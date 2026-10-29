import { Knex } from "knex";
import { Transaction } from "../entity/transaction.entity";
import { CreateTransactionRow, UpdateTransactionInput } from "../types";

const TRANSACTION_COLUMNS = [
    "id",
    "region",
    "order_id",
    "order_created_at",
    "transaction_type",
    "method",
    "provider_id",
    "provider_reference_id",
    "status",
    "amount",
    "currency",
    "src_acc_id",
    "dst_acc_id",
    "is_refunded",
    "refunded_payment_id",
    "idempotency_key",
    "created_at",
    "updated_at",
];

function toEntity(row: any): Transaction {
    return new Transaction({
        id: Number(row.id),
        region: row.region,
        orderId: row.order_id === null ? null : Number(row.order_id),
        orderCreatedAt: row.order_created_at,
        transactionType: row.transaction_type,
        method: row.method,
        providerId: row.provider_id === null ? null : Number(row.provider_id),
        providerReferenceId: row.provider_reference_id,
        status: row.status,
        amount: row.amount,
        currency: row.currency,
        srcAccId: row.src_acc_id === null ? null : Number(row.src_acc_id),
        dstAccId: row.dst_acc_id === null ? null : Number(row.dst_acc_id),
        isRefunded: row.is_refunded,
        refundedPaymentId: row.refunded_payment_id === null ? null : Number(row.refunded_payment_id),
        idempotencyKey: row.idempotency_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

export async function createTransaction(data: CreateTransactionRow, conn: Knex): Promise<Transaction> {
    const now = new Date();
    const [row] = await conn("transactions")
        .insert({
            region: data.region,
            order_id: data.orderId ?? null,
            order_created_at: data.orderCreatedAt ?? null,
            transaction_type: data.transactionType,
            method: data.method,
            provider_id: data.providerId ?? null,
            provider_reference_id: data.providerReferenceId ?? null,
            status: data.status,
            amount: data.amount,
            currency: data.currency,
            src_acc_id: data.srcAccId ?? null,
            dst_acc_id: data.dstAccId ?? null,
            idempotency_key: data.idempotencyKey ?? null,
            created_at: now,
            updated_at: now,
        })
        .returning(TRANSACTION_COLUMNS);

    return toEntity(row);
}

export async function findTransactionById(id: number, conn: Knex): Promise<Transaction | undefined> {
    const row = await conn("transactions").where("id", id).select(TRANSACTION_COLUMNS).first();
    return row ? toEntity(row) : undefined;
}

// Batch — guards against N+1 when loading an order's whole ledger (CLAUDE.md §7).
export async function findTransactionsByOrderIds(orderIds: number[], conn: Knex): Promise<Transaction[]> {
    if (orderIds.length === 0) return [];
    const rows = await conn("transactions").whereIn("order_id", orderIds).select(TRANSACTION_COLUMNS);
    return rows.map(toEntity);
}

// Finds the most recent succeeded charge/cod_collection for an order — the thing a
// refund request targets.
export async function findLatestSucceededChargeByOrderId(orderId: number, conn: Knex): Promise<Transaction | undefined> {
    const row = await conn("transactions")
        .where("order_id", orderId)
        .whereIn("transaction_type", ["charge", "cod_collection"])
        .where("status", "succeeded")
        .orderBy("created_at", "desc")
        .select(TRANSACTION_COLUMNS)
        .first();
    return row ? toEntity(row) : undefined;
}

// Batch source for the payment reconciler (lib/jobs/payment-reconciler.ts) — a
// succeeded charge/cod_collection whose order never left pending_payment because the
// post-charge `pending_payment -> placed` transition failed or never ran (see
// payment-webhook.service.ts's handleCapture comment). Joins on the order's current
// status (rather than just scanning the oldest succeeded charges) so this stays cheap
// as the ledger grows — once an order is reconciled it drops out of this query.
// `cutoff` is a grace window so this doesn't race the webhook's own synchronous call
// to markPlacedBySystem for a charge that only just succeeded.
export async function findUnreconciledSucceededCharges(cutoff: Date, conn: Knex, limit = 100): Promise<Transaction[]> {
    const rows = await conn("transactions")
        .whereIn("transactions.transaction_type", ["charge", "cod_collection"])
        .where("transactions.status", "succeeded")
        .where("transactions.created_at", "<", cutoff)
        .whereNotNull("transactions.order_id")
        .whereExists(
            conn("orders")
                .select(1)
                .whereRaw("orders.id = transactions.order_id")
                .whereRaw("orders.created_at = transactions.order_created_at")
                .where("orders.status", "pending_payment"),
        )
        .orderBy("transactions.created_at", "asc")
        .limit(limit)
        .select(TRANSACTION_COLUMNS.map((c) => `transactions.${c}`));
    return rows.map(toEntity);
}

export async function findRefundsByChargeId(chargeId: number, conn: Knex): Promise<Transaction[]> {
    const rows = await conn("transactions")
        .where("refunded_payment_id", chargeId)
        .where("transaction_type", "refund")
        .select(TRANSACTION_COLUMNS);
    return rows.map(toEntity);
}

// Locates the original pending refund row by the provider reference captured at
// refund-init time, so the refund webhook can flip it to succeeded/failed.
export async function findPendingRefundByProviderReference(
    providerReferenceId: string,
    conn: Knex,
): Promise<Transaction | undefined> {
    const row = await conn("transactions")
        .where("provider_reference_id", providerReferenceId)
        .where("transaction_type", "refund")
        .where("status", "pending")
        .select(TRANSACTION_COLUMNS)
        .first();
    return row ? toEntity(row) : undefined;
}

export async function updateTransaction(id: number, data: UpdateTransactionInput, conn: Knex): Promise<Transaction> {
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (data.status !== undefined) patch.status = data.status;
    if (data.providerReferenceId !== undefined) patch.provider_reference_id = data.providerReferenceId;
    if (data.isRefunded !== undefined) patch.is_refunded = data.isRefunded;
    if (data.refundedPaymentId !== undefined) patch.refunded_payment_id = data.refundedPaymentId;

    const [row] = await conn("transactions").where("id", id).update(patch).returning(TRANSACTION_COLUMNS);
    return toEntity(row);
}
