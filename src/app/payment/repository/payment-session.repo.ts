import { Knex } from "knex";
import { PaymentSession } from "../entity/payment-session.entity";
import { CreatePaymentSessionRow, UpdatePaymentSessionInput } from "../types";
import { PaymentSessionStatus } from "../enums";

const PAYMENT_SESSION_COLUMNS = [
    "id",
    "region",
    "order_id",
    "order_created_at",
    "provider_id",
    "provider_session_id",
    "redirect_url",
    "amount",
    "currency",
    "status",
    "raw_init_payload",
    "raw_last_payload",
    "created_at",
    "updated_at",
];

function toEntity(row: any): PaymentSession {
    return new PaymentSession({
        id: Number(row.id),
        region: row.region,
        orderId: Number(row.order_id),
        orderCreatedAt: row.order_created_at,
        providerId: Number(row.provider_id),
        providerSessionId: row.provider_session_id,
        redirectUrl: row.redirect_url,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        rawInitPayload: row.raw_init_payload,
        rawLastPayload: row.raw_last_payload,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

export async function createPaymentSession(data: CreatePaymentSessionRow, conn: Knex): Promise<PaymentSession> {
    const now = new Date();
    const [row] = await conn("payment_sessions")
        .insert({
            region: data.region,
            order_id: data.orderId,
            order_created_at: data.orderCreatedAt,
            provider_id: data.providerId,
            provider_session_id: data.providerSessionId,
            redirect_url: data.redirectUrl,
            amount: data.amount,
            currency: data.currency,
            status: data.status,
            raw_init_payload: JSON.stringify(data.rawInitPayload),
            created_at: now,
            updated_at: now,
        })
        .returning(PAYMENT_SESSION_COLUMNS);

    return toEntity(row);
}

// Supports PaymentService.init's domain-level idempotency check (§2 step 3 of
// docs/business-logic/payments.md): don't call Kashier twice for the same order while
// a session is still in flight.
export async function findLatestActiveSessionByOrderId(orderId: number, conn: Knex): Promise<PaymentSession | undefined> {
    const row = await conn("payment_sessions")
        .where("order_id", orderId)
        .whereIn("status", [PaymentSessionStatus.INITIALIZED, PaymentSessionStatus.PENDING])
        .orderBy("created_at", "desc")
        .select(PAYMENT_SESSION_COLUMNS)
        .first();
    return row ? toEntity(row) : undefined;
}

export async function findSessionByProviderSessionId(providerSessionId: string, conn: Knex): Promise<PaymentSession | undefined> {
    const row = await conn("payment_sessions")
        .where("provider_session_id", providerSessionId)
        .select(PAYMENT_SESSION_COLUMNS)
        .first();
    return row ? toEntity(row) : undefined;
}

export async function updatePaymentSession(id: number, data: UpdatePaymentSessionInput, conn: Knex): Promise<PaymentSession> {
    const patch: Record<string, unknown> = {
        status: data.status,
        updated_at: new Date(),
    };
    if (data.rawLastPayload !== undefined) patch.raw_last_payload = JSON.stringify(data.rawLastPayload);

    const [row] = await conn("payment_sessions").where("id", id).update(patch).returning(PAYMENT_SESSION_COLUMNS);
    return toEntity(row);
}
