import type { Knex } from "knex";
import { insertOutboxEvent } from "../../lib/events/outbox.repo";
import { OrderEventType } from "../../lib/events/event-types";
import { TreasuryLedgerEntry } from "./entity/treasury-ledger-entry.entity";
import { PaymentOutboxPayload } from "./types";

export function buildPaymentOutboxPayload(entry: TreasuryLedgerEntry): PaymentOutboxPayload {
    return {
        treasuryLedgerId: entry.id,
        region: entry.region,
        orderId: entry.orderId,
        orderCreatedAt: entry.orderCreatedAt?.toISOString() ?? null,
        entryType: entry.entryType,
        method: entry.method,
        providerId: entry.providerId,
        status: entry.status,
        amount: entry.amount,
        currency: entry.currency,
        createdAt: entry.createdAt.toISOString(),
    };
}

export async function insertPaymentOutboxEvent(entry: TreasuryLedgerEntry, eventType: OrderEventType, conn: Knex): Promise<void> {
    await insertOutboxEvent(conn, {
        aggregateType: "payment",
        aggregateId: String(entry.id),
        eventType,
        payload: buildPaymentOutboxPayload(entry),
    });
}
