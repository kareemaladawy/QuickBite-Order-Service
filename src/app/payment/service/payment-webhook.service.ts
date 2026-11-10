import { inject, injectable } from "tsyringe";
import type { Knex } from "knex";
import { validate as isUuid } from "uuid";
import { container } from "../../../lib/di/container";
import { TOKENS } from "../../../lib/di/tokens";
import { db } from "../../../lib/knex/knex";
import { logger } from "../../../lib/logger/logger";
import { publishToRoom } from "../../../lib/websocket/publish";
import { PaymentProviderRegistry } from "../../../lib/payments/registry";
import { PaymentSignatureError } from "../../../pkg/payments/errors";
import { WebhookEvent, WebhookHeaders } from "../../../pkg/payments/types";
import type { OrderService } from "../../order/service/order.service";
import type { Order } from "../../order/entity/order.entity";
import { OrderStatus } from "../../order/enums";
import { OrderNotFoundError } from "../../order/errors";
import { findLatestSessionByOrderId, updatePaymentSession } from "../repository/payment-session.repo";
import { findProviderByName } from "../repository/payment-provider.repo";
import {
    createTransaction,
    findLatestSucceededChargeByOrderId,
    findPendingRefundByProviderReference,
    updateTransaction,
} from "../repository/transaction.repo";
import { insertWebhookEventIfNew, markWebhookEventError, markWebhookEventProcessed } from "../repository/payment-webhook-event.repo";
import { insertPaymentOutboxEvent } from "../outbox-events";
import { OrderEventType } from "../../../lib/events/event-types";
import { PaymentSessionStatus, TransactionMethod, TransactionStatus, TransactionType } from "../enums";
import {
    InvalidWebhookSignatureError,
    UnsupportedPaymentProviderError,
    WebhookMissingRegionError,
    WebhookProcessingFailedError,
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

        // The webhook call carries none of our own routing context, so we embed the
        // shard at session-creation time (metaData.region) and read it back here — the
        // only way to avoid a cross-shard scan on every webhook (CLAUDE.md §7).
        const region = event.metaData.region;
        if (!region) {
            logger.error("webhook missing region metaData — cannot route to a shard", { provider: providerParam, event });
            throw WebhookMissingRegionError;
        }

        const conn = db(region);
        // Same name the registry and the webhook path param use — the payment_providers
        // row is where "which provider" finally becomes a stable int id for the ledger.
        const providerRow = await findProviderByName(providerParam, conn);
        if (!providerRow) throw UnsupportedPaymentProviderError;

        // Most providers have no single generic event id; we dedupe on
        // transactionId+status so each real status change is processed once, while
        // exact repeats (including Kashier's own `idempotency`-flagged replays) are
        // caught by the unique constraint (docs/business-logic/payments.md §3).
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
            await this.handleRefundOutcome(event, trx);
            return;
        }

        logger.info("webhook: no handler for event type — recorded, no action taken", { eventType: event.eventType });
    }

    private async handleCapture(event: WebhookEvent, region: string, providerId: number, trx: Knex.Transaction): Promise<void> {
        // orderReference is Kashier echoing back our merchantOrderId (the order's
        // public_id), but nothing stops a malformed or stale value arriving on the
        // wire (bad test payloads, a reference for an order that no longer exists).
        // That's not a transient failure we want Kashier to keep retrying forever —
        // treat it the same as the "no matching payment_session" case above: log and
        // ack, don't throw.
        if (!isUuid(event.orderReference)) {
            logger.warn("webhook: orderReference is not a valid order id — skipped", {
                orderReference: event.orderReference,
                providerOrderId: event.providerOrderId,
            });
            return;
        }

        let order: Order;
        try {
            order = await this.orderService().getOrderForSystem(event.orderReference, region);
        } catch (err) {
            if (err === OrderNotFoundError) {
                logger.warn("webhook: no matching order for orderReference — skipped", {
                    orderReference: event.orderReference,
                    providerOrderId: event.providerOrderId,
                });
                return;
            }
            throw err;
        }

        const session = await findLatestSessionByOrderId(order.id, trx);
        if (session) {
            await updatePaymentSession(
                session.id,
                {
                    status: event.status === "SUCCESS" ? PaymentSessionStatus.CAPTURED : PaymentSessionStatus.FAILED,
                    rawLastPayload: event.raw,
                },
                trx,
            );
        } else {
            logger.warn("webhook: no matching payment_session for order", { orderId: order.id });
        }

        const transaction = await createTransaction(
            {
                region,
                orderId: order.id,
                orderCreatedAt: order.createdAt,
                transactionType: TransactionType.CHARGE,
                method: TransactionMethod.ONLINE,
                providerId,
                providerReferenceId: event.providerOrderId,
                status: event.status === "SUCCESS" ? TransactionStatus.SUCCEEDED : TransactionStatus.FAILED,
                amount: event.amountMinor,
                currency: event.currency,
                srcAccId: order.customerId,
                idempotencyKey: `${event.transactionId}:${event.status}`,
            },
            trx,
        );

        await insertPaymentOutboxEvent(
            transaction,
            event.status === "SUCCESS" ? OrderEventType.PAYMENT_COMPLETED : OrderEventType.PAYMENT_FAILED,
            trx,
        );

        if (event.status === "SUCCESS") {
            if (order.status === OrderStatus.PENDING_PAYMENT) {
                // Deliberately outside `trx`: markPlacedBySystem owns its own
                // connection inside order.service.ts, and CLAUDE.md §3 forbids this
                // module reaching into order.repo to share one. The charge above is
                // already durable at this point; if this step fails the order stays
                // `pending_payment` with a succeeded charge on record — a reconciler
                // would need to retry the transition, not re-charge the customer.
                await this.orderService().markPlacedBySystem(order, region);
            }
        }
    }

    private async handleRefundOutcome(event: WebhookEvent, trx: Knex.Transaction): Promise<void> {
        const refundTx = await findPendingRefundByProviderReference(event.providerOrderId, trx);
        if (!refundTx) {
            logger.warn("refund webhook: no matching pending refund transaction", { providerOrderId: event.providerOrderId });
            return;
        }

        if (event.status === "SUCCESS") {
            await updateTransaction(refundTx.id, { status: TransactionStatus.SUCCEEDED }, trx);
            if (refundTx.orderId !== null) {
                // Mark the original charge refunded. We don't track partial-refund
                // running totals beyond the single is_refunded boolean the schema
                // provides (docs/database-design.md §3.5) — a second partial refund
                // against the same charge is rejected upstream by
                // PaymentService.refund's AlreadyRefundedError check.
                const charge = await findLatestSucceededChargeByOrderId(refundTx.orderId, trx);
                if (charge) {
                    await updateTransaction(charge.id, { isRefunded: true, refundedPaymentId: refundTx.id }, trx);
                }
            }
            // restaurant_balances adjustment deferred to Phase 3 — no delivered orders
            // exist yet for this to apply to (see docs/business-logic/payments.md §2).
        } else {
            await updateTransaction(refundTx.id, { status: TransactionStatus.FAILED }, trx);
        }
    }

    private orderService(): OrderService {
        return container.resolve<OrderService>(TOKENS.OrderService);
    }
}
