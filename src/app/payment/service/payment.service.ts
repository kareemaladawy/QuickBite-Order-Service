import { inject, injectable } from "tsyringe";
import { container } from "../../../lib/di/container";
import { TOKENS } from "../../../lib/di/tokens";
import { db } from "../../../lib/knex/knex";
import { logger } from "../../../lib/logger/logger";
import { JWTPayload } from "../../../lib/auth/types";
import { PaymentProviderRegistry } from "../../../lib/payments/registry";
import { PaymentProviderError } from "../../../pkg/payments/errors";
import { addMs, toMs } from "../../../pkg/utils/time";
import type { OrderService } from "../../order/service/order.service";
import { OrderStatus } from "../../order/enums";
import { OrderCompositeId } from "../../order/types";
import { createPaymentSession, findLatestActiveSessionByOrderId } from "../repository/payment-session.repo";
import { findProviderById, findProviderByName } from "../repository/payment-provider.repo";
import {
    createTransaction,
    findRefundsByChargeId,
    findTransactionById,
    findUnreconciledSucceededCharges,
    updateTransaction,
} from "../repository/transaction.repo";
import { PaymentSessionStatus, TransactionMethod, TransactionStatus, TransactionType } from "../enums";
import {
    AlreadyRefundedError,
    ForbiddenPaymentAccessError,
    MissingProviderReferenceError,
    OnlinePaymentUnavailableInRegionError,
    OrderNotPendingPaymentError,
    PaymentNotFoundError,
    PaymentNotRefundableError,
    PaymentProviderDisabledError,
    PaymentProviderUpstreamError,
    RefundExceedsChargeError,
} from "../errors";
import { RefundRequestDTO } from "../dto/payment.request.dto";
import { GetPaymentResult, InitPaymentResult, OrderPayloadForPaymentInit } from "../types";
import { Transaction } from "../entity/transaction.entity";

@injectable()
export class PaymentService {
    constructor(@inject(TOKENS.PaymentProviderRegistry) private readonly registry: PaymentProviderRegistry) { }

    // Exposed so OrderService can reject an online order for a region with no
    // configured provider before the order row (and its stock reservation) is ever
    // created, instead of only failing once initForOrder runs after the order already
    // exists — see env.payments.regionProviderMap / lib/payments/registry.ts.
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
                redirectUrl: existing.redirectUrl,
                sessionId: existing.providerSessionId,
                expiresAt: addMs(existing.createdAt, toMs(sessionTimeoutMin, "m")).toISOString(),
            };
        }

        const providerRow = await findProviderByName(providerName, conn);
        if (!providerRow || !providerRow.isEnabled) throw PaymentProviderDisabledError;

        const expiresAt = addMs(new Date(), toMs(sessionTimeoutMin, "m"));

        let session;
        try {
            session = await provider.createSession({
                merchantOrderId: input.orderPublicId,
                amountMinor: input.amountMinor,
                currency: input.currency,
                customerReference: String(input.customerId),
                returnUrl,
                webhookUrl,
                expiresAt,
                metaData: { region: input.region, orderPublicId: input.orderPublicId },
            });
        } catch (err) {
            if (err instanceof PaymentProviderError && err.statusCode < 500) {
                logger.error("payment provider rejected session creation", {
                    orderId: input.orderId,
                    statusCode: err.statusCode,
                    message: err.message,
                    raw: err.raw,
                });
                throw PaymentProviderUpstreamError;
            }
            throw err;
        }

        await createPaymentSession(
            {
                region: input.region,
                orderId: input.orderId,
                orderCreatedAt: input.orderCreatedAt,
                providerId: providerRow.id,
                providerSessionId: session.providerSessionId,
                redirectUrl: session.redirectUrl,
                amount: input.amountMinor,
                currency: input.currency,
                status: PaymentSessionStatus.INITIALIZED,
                rawInitPayload: session.raw,
            },
            conn,
        );

        return {
            redirectUrl: session.redirectUrl,
            sessionId: session.providerSessionId,
            expiresAt: expiresAt.toISOString()
        };
    };

    // POST /payments/init — retry-only path (see conversation decision: the first init
    // always happens inline in OrderService.placeOrder). Lets a client whose session
    // expired or failed to create get a fresh one without re-placing the whole order.
    initRetry = async (actor: JWTPayload, orderPublicId: string, region: string): Promise<InitPaymentResult> => {
        const order = await this.orderService().getOrderForSystem(orderPublicId, region);

        if (order.customerId !== actor.userId) throw ForbiddenPaymentAccessError;
        if (order.status !== OrderStatus.PENDING_PAYMENT) throw OrderNotPendingPaymentError;

        return this.initForOrder({
            orderId: order.id,
            orderCreatedAt: order.createdAt,
            orderPublicId: order.publicId,
            customerId: order.customerId,
            amountMinor: order.total,
            currency: order.currency,
            region,
        });
    };

    // Route is nested under /restaurants/:restaurantId/payments/:paymentId —
    // requireRestaurantMember (routes.ts) already confirmed the caller may act for
    // restaurantId (system_admin, or a restaurant_user who owns it). What's left here
    // is purely a data check: does this transaction actually belong to that
    // restaurant, not an authorization decision. A payout (no order link) isn't
    // reachable via this restaurant-scoped route in this milestone — see CLAUDE.md
    // §13, payouts land with the restaurant-finance module.
    getById = async (transactionId: number, restaurantId: number, region: string): Promise<GetPaymentResult> => {
        const conn = db(region);
        const transaction = await findTransactionById(transactionId, conn);
        if (!transaction) throw PaymentNotFoundError;

        if (transaction.orderId === null || transaction.orderCreatedAt === null) {
            throw PaymentNotFoundError;
        }

        const order = await this.orderService().getOrderByIdForSystem(transaction.orderId, transaction.orderCreatedAt, region);
        if (order.restaurantId !== restaurantId) throw PaymentNotFoundError;

        const refunds =
            transaction.transactionType === TransactionType.CHARGE || transaction.transactionType === TransactionType.COD_COLLECTION
                ? await findRefundsByChargeId(transaction.id, conn)
                : [];

        return { transaction, orderPublicId: order.publicId, refunds };
    };

    refund = async (
        actor: JWTPayload,
        transactionId: number,
        region: string,
        data: RefundRequestDTO,
        idempotencyKey: string,
    ): Promise<Transaction> => {
        const conn = db(region);
        const charge = await findTransactionById(transactionId, conn);
        if (!charge) throw PaymentNotFoundError;

        if (
            (charge.transactionType !== TransactionType.CHARGE && charge.transactionType !== TransactionType.COD_COLLECTION) ||
            charge.status !== TransactionStatus.SUCCEEDED
        ) {
            throw PaymentNotRefundableError;
        }
        if (charge.isRefunded) throw AlreadyRefundedError;

        const amountMinor = data.amount ?? charge.amount;
        if (amountMinor > charge.amount) throw RefundExceedsChargeError;

        const refundRow = await createTransaction(
            {
                region,
                orderId: charge.orderId ?? undefined,
                orderCreatedAt: charge.orderCreatedAt ?? undefined,
                transactionType: TransactionType.REFUND,
                method: charge.method,
                providerId: charge.providerId ?? undefined,
                status: TransactionStatus.PENDING,
                amount: amountMinor,
                currency: charge.currency,
                dstAccId: charge.srcAccId ?? undefined,
                idempotencyKey,
            },
            conn,
        );

        if (charge.method === TransactionMethod.COD) {
            // Cash never reached the platform — bookkeeping only, no provider call,
            // nothing to wait on. See docs/business-logic/payments.md §5.
            const settled = await updateTransaction(refundRow.id, { status: TransactionStatus.SUCCEEDED }, conn);
            await updateTransaction(charge.id, { isRefunded: true, refundedPaymentId: refundRow.id }, conn);
            return settled;
        }

        if (!charge.providerReferenceId) throw MissingProviderReferenceError;
        if (charge.providerId === null) throw PaymentProviderDisabledError;

        // The charge's own provider_id tells us which client actually took this
        // payment — not necessarily "the" region's current provider (a region's
        // provider could change after the charge was made).
        const providerRow = await findProviderById(charge.providerId, conn);
        const providerConfig = providerRow ? this.registry.byName(providerRow.name) : undefined;
        if (!providerConfig) throw PaymentProviderDisabledError;
        const { provider } = providerConfig;

        try {
            await provider.refund({
                providerOrderId: charge.providerReferenceId,
                amountMinor: data.amount,
                reason: data.reason,
            });
            // Kashier's refund call targets the order (not a transaction id we mint),
            // so we correlate the eventual refund webhook back to this row by the same
            // kashierOrderId the charge used.
            await updateTransaction(refundRow.id, { providerReferenceId: charge.providerReferenceId }, conn);
            return refundRow; // stays 'pending' until the refund webhook confirms it
        } catch (err) {
            await updateTransaction(refundRow.id, { status: TransactionStatus.FAILED }, conn);
            if (err instanceof PaymentProviderError) {
                logger.error("payment provider rejected refund", {
                    transactionId,
                    statusCode: err.statusCode,
                    message: err.message,
                    raw: err.raw,
                });
                throw PaymentProviderUpstreamError;
            }
            throw err;
        }
    };

    // Background reconciler (lib/jobs/payment-reconciler.ts) — picks up a succeeded
    // charge whose order never made it out of pending_payment because the post-charge
    // `pending_payment -> placed` transition failed or never ran (see
    // payment-webhook.service.ts's handleCapture comment) and retries it, instead of
    // leaving the order to eventually be wrongly cancelled by the pending-payment
    // sweep. `graceSec` keeps this from racing the webhook's own synchronous call to
    // markPlacedBySystem for a charge that only just succeeded. Returns how many
    // orders it reconciled this pass, for the job's own logging.
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
                logger.error("payment reconciler: failed to retry pending_payment -> placed transition", {
                    orderId: order.id,
                    error: (err as Error).message,
                });
            }
        }

        return reconciledCount;
    };

    // Resolved lazily rather than constructor-injected: order.service.ts resolves
    // PaymentService the same way (lib/di/container.ts registers both; importing
    // OrderService's *class* here for DI would make the two modules's container
    // registrations depend on each other's load order for no benefit — the type-only
    // import above is all static analysis needs).
    private orderService(): OrderService {
        return container.resolve<OrderService>(TOKENS.OrderService);
    }
}
