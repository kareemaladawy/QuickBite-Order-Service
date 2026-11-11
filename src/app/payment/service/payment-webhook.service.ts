import { inject, injectable } from "tsyringe";
import type { Knex } from "knex";
import { validate as isUuid } from "uuid";
import { container } from "../../../lib/di/container";
import { TOKENS } from "../../../lib/di/tokens";
import { db } from "../../../lib/knex/knex";
import { logger } from "../../../lib/logger/logger";
import { PaymentProviderRegistry } from "../../../lib/payments/registry";
import { PaymentSignatureError } from "../../../pkg/payments/errors";
import { WebhookEvent, WebhookHeaders } from "../../../pkg/payments/types";
import type { OrderService } from "../../order/service/order.service";
import type { Order } from "../../order/entity/order.entity";
import { OrderStatus } from "../../order/enums";
import { OrderNotFoundError } from "../../order/errors";
import type { FinanceService } from "../../restaurant-finance/service/finance.service";
import { findLatestSessionByOrderId, updatePaymentSession } from "../repository/payment-session.repo";
import { findProviderByName } from "../repository/payment-provider.repo";
import {
    createTreasuryEntry, findLatestSucceededChargeByOrderId, findPendingRefundByProviderReference, updateTreasuryEntry,
} from "../repository/treasury-ledger.repo";
import { insertWebhookEventIfNew, markWebhookEventError, markWebhookEventProcessed } from "../repository/payment-webhook-event.repo";
import { insertPaymentOutboxEvent } from "../outbox-events";
import { OrderEventType } from "../../../lib/events/event-types";
import { PaymentSessionStatus, TreasuryEntryType, TreasuryMethod, TreasuryStatus } from "../enums";
import {
    InvalidWebhookSignatureError, UnsupportedPaymentProviderError, WebhookMissingRegionError, WebhookProcessingFailedError,
} from "../errors";

const CAPTURE_EVENT_TYPES = new Set(["pay", "capture", "authorize"]);
const REFUND_EVENT_TYPES = new Set(["refund", "partial_refund"]);

@injectable()
export class PaymentWebhookService {
    constructor(@inject(TOKENS.PaymentProviderRegistry) private readonly registry: PaymentProviderRegistry) { }

    handle = async (providerParam: string, rawBody: Record<string, unknown>, headers: WebhookHeaders): Promise<{ duplicate: boolean }> => {
        const providerConfig = this.registry.byName(providerParam);
        if (!providerConfig) throw UnsupportedPaymentProviderError;
        const { provider } = providerConfig;

        let event: WebhookEvent;
        try {
            event = provider.verifyWebhook(rawBody, headers);
        } catch (err) {
            if (err instanceof PaymentSignatureError) {
                logger.warn("webhook signature mismatch — dropped", { provider: providerParam, error: err.message });
                throw InvalidWebhookSignatureError;
            }
            throw err;
        }

        const region = event.metaData.region;
        if (!region) {
            logger.error("webhook missing region metaData — cannot route to a shard", { provider: providerParam, event });
            throw WebhookMissingRegionError;
        }

        const conn = db(region);
        const providerRow = await findProviderByName(providerParam, conn);
        if (!providerRow) throw UnsupportedPaymentProviderError;

        const providerEventId = `${event.transactionId}:${event.status}`;
        const signature = provider.getSignatureHeaderValue(headers);

        const recorded = await insertWebhookEventIfNew(region, providerRow.id, providerEventId, signature ?? "", rawBody, conn);
        if (!recorded) {
            logger.info("duplicate webhook — acked, no side effects", { provider: providerParam, providerEventId });
            return { duplicate: true };
        }

        const trx = await conn.transaction();
        try {
            await this.process(event, region, providerRow.id, trx);
            await trx.commit();
        } catch (err) {
            await trx.rollback();
            await markWebhookEventError(providerRow.id, providerEventId, (err as Error).message, conn);
            logger.error("webhook processing failed", { provider: providerParam, providerEventId, error: (err as Error).message });
            throw WebhookProcessingFailedError;
        }

        await markWebhookEventProcessed(providerRow.id, providerEventId, conn);
        return { duplicate: false };
    };

    private async process(event: WebhookEvent, region: string, providerId: number, trx: Knex.Transaction): Promise<void> {
        if (CAPTURE_EVENT_TYPES.has(event.eventType)) {
            await this.handleCapture(event, region, providerId, trx);
            return;
        }
        if (REFUND_EVENT_TYPES.has(event.eventType)) {
            await this.handleRefundOutcome(event, region, trx);
            return;
        }
        logger.info("webhook: no handler for event type — recorded, no action taken", { eventType: event.eventType });
    }

    private async handleCapture(event: WebhookEvent, region: string, providerId: number, trx: Knex.Transaction): Promise<void> {
        if (!isUuid(event.orderReference)) {
            logger.warn("webhook: orderReference is not a valid order id — skipped", { orderReference: event.orderReference, providerOrderId: event.providerOrderId });
            return;
        }

        let order: Order;
        try {
            order = await this.orderService().getOrderForSystem(event.orderReference, region);
        } catch (err) {
            if (err === OrderNotFoundError) {
                logger.warn("webhook: no matching order for orderReference — skipped", { orderReference: event.orderReference, providerOrderId: event.providerOrderId });
                return;
            }
            throw err;
        }

        const session = await findLatestSessionByOrderId(order.id, trx);
        if (session) {
            await updatePaymentSession(session.id, {
                status: event.status === "SUCCESS" ? PaymentSessionStatus.CAPTURED : PaymentSessionStatus.FAILED,
                rawLastPayload: event.raw,
            }, trx);
        } else {
            logger.warn("webhook: no matching payment_session for order", { orderId: order.id });
        }

        const entry = await createTreasuryEntry({
            region, orderId: order.id, orderCreatedAt: order.createdAt,
            entryType: TreasuryEntryType.CHARGE, method: TreasuryMethod.ONLINE, providerId,
            providerReferenceId: event.providerOrderId,
            status: event.status === "SUCCESS" ? TreasuryStatus.SUCCEEDED : TreasuryStatus.FAILED,
            amount: event.amountMinor, currency: event.currency, customerId: order.customerId,
            idempotencyKey: `${event.transactionId}:${event.status}`,
        }, trx);

        await insertPaymentOutboxEvent(
            entry,
            event.status === "SUCCESS" ? OrderEventType.PAYMENT_COMPLETED : OrderEventType.PAYMENT_FAILED,
            trx,
        );

        if (event.status === "SUCCESS") {
            if (order.status === OrderStatus.PENDING_PAYMENT) {
                // Deliberately outside `trx` — see comment in source.
                await this.orderService().markPlacedBySystem(order, region);
            }
        }
    }

    private async handleRefundOutcome(event: WebhookEvent, region: string, trx: Knex.Transaction): Promise<void> {
        const refundEntry = await findPendingRefundByProviderReference(event.providerOrderId, trx);
        if (!refundEntry) {
            logger.warn("refund webhook: no matching pending refund entry", { providerOrderId: event.providerOrderId });
            return;
        }

        if (event.status !== "SUCCESS") {
            await updateTreasuryEntry(refundEntry.id, { status: TreasuryStatus.FAILED }, trx);
            return;
        }

        await updateTreasuryEntry(refundEntry.id, { status: TreasuryStatus.SUCCEEDED }, trx);
        if (refundEntry.orderId === null) return;

        const charge = await findLatestSucceededChargeByOrderId(refundEntry.orderId, trx);
        if (charge) {
            await updateTreasuryEntry(charge.id, { isRefunded: true, refundedEntryId: refundEntry.id }, trx);
        }

        // A refund on an order that was never delivered/settled has nothing to claw
        // back — recordRefundClawback() is a no-op unless a settlement_credit exists
        // for this order (restaurant-finance.service decides that, not here).
        const order = await this.orderService().getOrderByIdForSystem(refundEntry.orderId, refundEntry.orderCreatedAt!, region);
        await this.financeService().recordRefundClawback(order, refundEntry.amount, trx);
    }

    private orderService(): OrderService {
        return container.resolve<OrderService>(TOKENS.OrderService);
    }

    private financeService(): FinanceService {
        return container.resolve<FinanceService>(TOKENS.FinanceService);
    }
}
