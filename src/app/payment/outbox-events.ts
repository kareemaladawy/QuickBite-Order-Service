import type { Knex } from "knex";
import { insertOutboxEvent } from "../../lib/events/outbox.repo";
import { OrderEventType } from "../../lib/events/event-types";
import { Transaction } from "./entity/transaction.entity";
import { PaymentOutboxPayload } from "./types";

export function buildPaymentOutboxPayload(transaction: Transaction): PaymentOutboxPayload {
    return {
        transactionId: transaction.id,
        region: transaction.region,
        orderId: transaction.orderId,
        orderCreatedAt: transaction.orderCreatedAt?.toISOString() ?? null,
        transactionType: transaction.transactionType,
        method: transaction.method,
        providerId: transaction.providerId,
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency,
        createdAt: transaction.createdAt.toISOString(),
    };
}

export async function insertPaymentOutboxEvent(transaction: Transaction, eventType: OrderEventType, conn: Knex): Promise<void> {
    await insertOutboxEvent(conn, {
        aggregateType: "payment",
        aggregateId: String(transaction.id),
        eventType,
        payload: buildPaymentOutboxPayload(transaction),
    });
}
