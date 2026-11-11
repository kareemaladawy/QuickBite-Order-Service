import { inject, injectable } from "tsyringe";
import type { Knex } from "knex";
import { container } from "../../../lib/di/container";
import { TOKENS } from "../../../lib/di/tokens";
import { db } from "../../../lib/knex/knex";
import { logger } from "../../../lib/logger/logger";
import { JWTPayload } from "../../../lib/auth/types";
import { PaymentProviderRegistry } from "../../../lib/payments/registry";
import { PaymentProviderError } from "../../../pkg/payments/errors";
import { addMs, toMs } from "../../../pkg/utils/time";
import { PaginationParams } from "../../../lib/http/pagination/types";
import type { OrderService } from "../../order/service/order.service";
import { OrderStatus } from "../../order/enums";
import { OrderCompositeId } from "../../order/types";
import { createPaymentSession, findLatestActiveSessionByOrderId } from "../repository/payment-session.repo";
import { findProviderById, findProviderByName } from "../repository/payment-provider.repo";
import {
    createTreasuryEntry, findPayoutsByPayee, findRefundsByChargeId, findTreasuryEntryById,
    findUnreconciledSucceededCharges, updateTreasuryEntry,
} from "../repository/treasury-ledger.repo";
import { PaymentSessionStatus, PayeeAccountType, TreasuryEntryType, TreasuryMethod, TreasuryStatus } from "../enums";
import {
    AlreadyRefundedError, ForbiddenPaymentAccessError, MissingProviderReferenceError, OnlinePaymentUnavailableInRegionError,
    OrderNotPendingPaymentError, PaymentNotFoundError, PaymentNotRefundableError, PaymentProviderDisabledError,
    PaymentProviderUpstreamError, RefundExceedsChargeError,
} from "../errors";
import { RefundRequestDTO } from "../dto/payment.request.dto";
import { GetPaymentResult, InitPaymentResult, OrderPayloadForPaymentInit } from "../types";
import { TreasuryLedgerEntry } from "../entity/treasury-ledger-entry.entity";

@injectable()
export class PaymentService {
    constructor(@inject(TOKENS.PaymentProviderRegistry) private readonly registry: PaymentProviderRegistry) { }

    assertOnlinePaymentSupported = (region: string): void => {
        if (!this.registry.forRegion(region)) {
            throw OnlinePaymentUnavailableInRegionError;
        }
    };

    initForOrder = async (input: OrderPayloadForPaymentInit): Promise<InitPaymentResult> => {
        this.assertOnlinePaymentSupported(input.region);
        const { provider, returnUrl, webhookUrl, sessionTimeoutMin } = this.registry.forRegion(input.region)!;
        const providerName = this.registry.providerNameForRegion(input.region)!;
        const conn = db(input.region);

        const existing = await findLatestActiveSessionByOrderId(input.orderId, conn);
        if (existing) {
            return {
                redirectUrl: existing.redirectUrl, sessionId: existing.providerSessionId,
                expiresAt: addMs(existing.createdAt, toMs(sessionTimeoutMin, "m")).toISOString(),
            };
        }

        const providerRow = await findProviderByName(providerName, conn);
        if (!providerRow || !providerRow.isEnabled) throw PaymentProviderDisabledError;

        const expiresAt = addMs(new Date(), toMs(sessionTimeoutMin, "m"));

        let session;
        try {
            session = await provider.createSession({
                merchantOrderId: input.orderPublicId, amountMinor: input.amountMinor, currency: input.currency,
                customerReference: String(input.customerId), returnUrl, webhookUrl, expiresAt,
                metaData: { region: input.region, orderPublicId: input.orderPublicId },
            });
        } catch (err) {
            if (err instanceof PaymentProviderError && err.statusCode < 500) {
                logger.error("payment provider rejected session creation", { orderId: input.orderId, statusCode: err.statusCode, message: err.message, raw: err.raw });
                throw PaymentProviderUpstreamError;
            }
            throw err;
        }

        await createPaymentSession({
            region: input.region, orderId: input.orderId, orderCreatedAt: input.orderCreatedAt, providerId: providerRow.id,
            providerSessionId: session.providerSessionId, redirectUrl: session.redirectUrl, amount: input.amountMinor,
            currency: input.currency, status: PaymentSessionStatus.INITIALIZED, rawInitPayload: session.raw,
        }, conn);

        return { redirectUrl: session.redirectUrl, sessionId: session.providerSessionId, expiresAt: expiresAt.toISOString() };
    };

    initRetry = async (actor: JWTPayload, orderPublicId: string, region: string): Promise<InitPaymentResult> => {
        const order = await this.orderService().getOrderForSystem(orderPublicId, region);
        if (order.customerId !== actor.userId) throw ForbiddenPaymentAccessError;
        if (order.status !== OrderStatus.PENDING_PAYMENT) throw OrderNotPendingPaymentError;
        return this.initForOrder({
            orderId: order.id, orderCreatedAt: order.createdAt, orderPublicId: order.publicId,
            customerId: order.customerId, amountMinor: order.total, currency: order.currency, region,
        });
    };

    getById = async (transactionId: number, restaurantId: number, region: string): Promise<GetPaymentResult> => {
        const conn = db(region);
        const transaction = await findTreasuryEntryById(transactionId, conn);
        if (!transaction) throw PaymentNotFoundError;
        if (transaction.orderId === null || transaction.orderCreatedAt === null) throw PaymentNotFoundError;

        const order = await this.orderService().getOrderByIdForSystem(transaction.orderId, transaction.orderCreatedAt, region);
        if (order.restaurantId !== restaurantId) throw PaymentNotFoundError;

        const refunds =
            transaction.entryType === TreasuryEntryType.CHARGE || transaction.entryType === TreasuryEntryType.COD_COLLECTION
                ? await findRefundsByChargeId(transaction.id, conn) : [];

        return { transaction, orderPublicId: order.publicId, refunds };
    };

    refund = async (actor: JWTPayload, transactionId: number, region: string, data: RefundRequestDTO, idempotencyKey: string): Promise<TreasuryLedgerEntry> => {
        const conn = db(region);
        const charge = await findTreasuryEntryById(transactionId, conn);
        if (!charge) throw PaymentNotFoundError;

        if (
            (charge.entryType !== TreasuryEntryType.CHARGE && charge.entryType !== TreasuryEntryType.COD_COLLECTION) ||
            charge.status !== TreasuryStatus.SUCCEEDED
        ) {
            throw PaymentNotRefundableError;
        }
        if (charge.isRefunded) throw AlreadyRefundedError;

        const amountMinor = data.amount ?? charge.amount;
        if (amountMinor > charge.amount) throw RefundExceedsChargeError;

        const refundRow = await createTreasuryEntry({
            region, orderId: charge.orderId ?? undefined, orderCreatedAt: charge.orderCreatedAt ?? undefined,
            entryType: TreasuryEntryType.REFUND, method: charge.method, providerId: charge.providerId ?? undefined,
            status: TreasuryStatus.PENDING, amount: amountMinor, currency: charge.currency,
            customerId: charge.customerId ?? undefined, idempotencyKey,
        }, conn);

        if (charge.method === TreasuryMethod.COD) {
            const settled = await updateTreasuryEntry(refundRow.id, { status: TreasuryStatus.SUCCEEDED }, conn);
            await updateTreasuryEntry(charge.id, { isRefunded: true, refundedEntryId: refundRow.id }, conn);
            return settled;
        }

        if (!charge.providerReferenceId) throw MissingProviderReferenceError;
        if (charge.providerId === null) throw PaymentProviderDisabledError;

        const providerRow = await findProviderById(charge.providerId, conn);
        const providerConfig = providerRow ? this.registry.byName(providerRow.name) : undefined;
        if (!providerConfig) throw PaymentProviderDisabledError;
        const { provider } = providerConfig;

        try {
            await provider.refund({ providerOrderId: charge.providerReferenceId, amountMinor: data.amount, reason: data.reason });
            await updateTreasuryEntry(refundRow.id, { providerReferenceId: charge.providerReferenceId }, conn);
            return refundRow; // stays 'pending' until the refund webhook confirms it
        } catch (err) {
            await updateTreasuryEntry(refundRow.id, { status: TreasuryStatus.FAILED }, conn);
            if (err instanceof PaymentProviderError) {
                logger.error("payment provider rejected refund", { transactionId, statusCode: err.statusCode, message: err.message, raw: err.raw });
                throw PaymentProviderUpstreamError;
            }
            throw err;
        }
    };

    // Called by restaurant-finance's finance.service on `delivered` for a COD order —
    // the only point a COD order's cash ever enters the treasury ledger.
    recordCodCollection = async (
        input: { region: string; orderId: number; orderCreatedAt: Date; customerId: number; amount: number; currency: string },
        conn: Knex,
    ): Promise<TreasuryLedgerEntry> => {
        return createTreasuryEntry({
            region: input.region, orderId: input.orderId, orderCreatedAt: input.orderCreatedAt,
            entryType: TreasuryEntryType.COD_COLLECTION, method: TreasuryMethod.COD, status: TreasuryStatus.SUCCEEDED,
            amount: input.amount, currency: input.currency, customerId: input.customerId,
        }, conn);
    };

    // Called by restaurant-finance's and agent's *-finance.service on an admin-recorded
    // payout — a single shared treasury insert, since a payout is the same real-world
    // event (a bank transfer out) regardless of which account ledger it's debited from.
    recordPayout = async (
        input: {
            region: string; payeeAccountType: PayeeAccountType; payeeAccountId: number;
            amount: number; currency: string; providerReferenceId: string; idempotencyKey: string;
        },
        conn: Knex,
    ): Promise<TreasuryLedgerEntry> => {
        return createTreasuryEntry({
            region: input.region, entryType: TreasuryEntryType.PAYOUT, method: TreasuryMethod.BANK_TRANSFER,
            status: TreasuryStatus.SUCCEEDED, amount: input.amount, currency: input.currency,
            payeeAccountType: input.payeeAccountType, payeeAccountId: input.payeeAccountId,
            providerReferenceId: input.providerReferenceId, idempotencyKey: input.idempotencyKey,
        }, conn);
    };

    listPayoutsForPayee = async (
        payeeAccountType: PayeeAccountType, payeeAccountId: number, region: string,
        range: { from: Date; to: Date }, pagination: PaginationParams,
    ): Promise<TreasuryLedgerEntry[]> => {
        return findPayoutsByPayee(payeeAccountType, payeeAccountId, range, pagination, db(region));
    };

    reconcileStuckPlacedOrders = async (region: string, graceSec: number): Promise<number> => {
        const conn = db(region);
        const cutoff = addMs(new Date(), -toMs(graceSec, "s"));
        const charges = await findUnreconciledSucceededCharges(cutoff, conn);
        if (charges.length === 0) return 0;

        const pairs: OrderCompositeId[] = charges
            .filter((c) => c.orderId !== null && c.orderCreatedAt !== null)
            .map((c) => ({ id: c.orderId!, createdAt: c.orderCreatedAt! }));
        if (pairs.length === 0) return 0;

        const orders = await this.orderService().getOrdersByCompositeIds(pairs, region);

        let reconciledCount = 0;
        for (const order of orders) {
            if (order.status !== OrderStatus.PENDING_PAYMENT) continue;
            try {
                await this.orderService().markPlacedBySystem(order, region);
                reconciledCount++;
            } catch (err) {
                logger.error("payment reconciler: failed to retry pending_payment -> placed transition", { orderId: order.id, error: (err as Error).message });
            }
        }
        return reconciledCount;
    };

    private orderService(): OrderService {
        return container.resolve<OrderService>(TOKENS.OrderService);
    }
}
