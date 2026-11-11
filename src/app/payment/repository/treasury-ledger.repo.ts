import { Knex } from "knex";
import { TreasuryLedgerEntry } from "../entity/treasury-ledger-entry.entity";
import { CreateTreasuryEntryRow, UpdateTreasuryEntryInput } from "../types";
import { PaginationParams } from "../../../lib/http/pagination/types";
import { applyCursorPagination } from "../../../lib/http/pagination/cursor-pagination";
import { PayeeAccountType, TreasuryEntryType, TreasuryStatus } from "../enums";

const TREASURY_LEDGER_COLUMNS = [
    "id", "region", "order_id", "order_created_at", "entry_type", "method", "provider_id",
    "provider_reference_id", "status", "amount", "currency", "customer_id", "payee_account_type",
    "payee_account_id", "is_refunded", "refunded_entry_id", "idempotency_key", "created_at", "updated_at",
];

function toEntity(row: any): TreasuryLedgerEntry {
    return new TreasuryLedgerEntry({
        id: Number(row.id), region: row.region, orderId: row.order_id === null ? null : Number(row.order_id),
        orderCreatedAt: row.order_created_at, entryType: row.entry_type, method: row.method,
        providerId: row.provider_id === null ? null : Number(row.provider_id), providerReferenceId: row.provider_reference_id,
        status: row.status, amount: row.amount, currency: row.currency,
        customerId: row.customer_id === null ? null : Number(row.customer_id),
        payeeAccountType: row.payee_account_type, payeeAccountId: row.payee_account_id === null ? null : Number(row.payee_account_id),
        isRefunded: row.is_refunded, refundedEntryId: row.refunded_entry_id === null ? null : Number(row.refunded_entry_id),
        idempotencyKey: row.idempotency_key, createdAt: row.created_at, updatedAt: row.updated_at,
    });
}

export async function createTreasuryEntry(data: CreateTreasuryEntryRow, conn: Knex): Promise<TreasuryLedgerEntry> {
    const now = new Date();
    const [row] = await conn("treasury_ledger")
        .insert({
            region: data.region, order_id: data.orderId ?? null, order_created_at: data.orderCreatedAt ?? null,
            entry_type: data.entryType, method: data.method, provider_id: data.providerId ?? null,
            provider_reference_id: data.providerReferenceId ?? null, status: data.status, amount: data.amount, currency: data.currency,
            customer_id: data.customerId ?? null, payee_account_type: data.payeeAccountType ?? null,
            payee_account_id: data.payeeAccountId ?? null, idempotency_key: data.idempotencyKey ?? null,
            created_at: now, updated_at: now,
        })
        .returning(TREASURY_LEDGER_COLUMNS);
    return toEntity(row);
}

export async function findTreasuryEntryById(id: number, conn: Knex): Promise<TreasuryLedgerEntry | undefined> {
    const row = await conn("treasury_ledger").where("id", id).select(TREASURY_LEDGER_COLUMNS).first();
    return row ? toEntity(row) : undefined;
}

// Batch — guards against N+1 when loading an order's whole ledger
export async function findTreasuryEntriesByOrderIds(orderIds: number[], conn: Knex): Promise<TreasuryLedgerEntry[]> {
    if (orderIds.length === 0) return [];
    const rows = await conn("treasury_ledger").whereIn("order_id", orderIds).select(TREASURY_LEDGER_COLUMNS);
    return rows.map(toEntity);
}

export async function findLatestSucceededChargeByOrderId(orderId: number, conn: Knex): Promise<TreasuryLedgerEntry | undefined> {
    const row = await conn("treasury_ledger")
        .where("order_id", orderId)
        .whereIn("entry_type", [TreasuryEntryType.CHARGE, TreasuryEntryType.COD_COLLECTION])
        .where("status", TreasuryStatus.SUCCEEDED)
        .orderBy("created_at", "desc").select(TREASURY_LEDGER_COLUMNS).first();
    return row ? toEntity(row) : undefined;
}

// Batch source for the payment reconciler (lib/jobs/payment-reconciler.ts)
export async function findUnreconciledSucceededCharges(cutoff: Date, conn: Knex, limit = 100): Promise<TreasuryLedgerEntry[]> {
    const rows = await conn("treasury_ledger")
        .whereIn("treasury_ledger.entry_type", [TreasuryEntryType.CHARGE, TreasuryEntryType.COD_COLLECTION])
        .where("treasury_ledger.status", TreasuryStatus.SUCCEEDED)
        .where("treasury_ledger.created_at", "<", cutoff)
        .whereNotNull("treasury_ledger.order_id")
        .whereExists(
            conn("orders").select(1).whereRaw("orders.id = treasury_ledger.order_id")
                .whereRaw("orders.created_at = treasury_ledger.order_created_at").where("orders.status", "pending_payment"),
        )
        .orderBy("treasury_ledger.created_at", "asc").limit(limit).select(TREASURY_LEDGER_COLUMNS.map((c) => `treasury_ledger.${c}`));
    return rows.map(toEntity);
}

export async function findRefundsByChargeId(chargeId: number, conn: Knex): Promise<TreasuryLedgerEntry[]> {
    const rows = await conn("treasury_ledger")
        .where("refunded_entry_id", chargeId).where("entry_type", TreasuryEntryType.REFUND).select(TREASURY_LEDGER_COLUMNS);
    return rows.map(toEntity);
}

export async function findPendingRefundByProviderReference(providerReferenceId: string, conn: Knex): Promise<TreasuryLedgerEntry | undefined> {
    const row = await conn("treasury_ledger")
        .where("provider_reference_id", providerReferenceId).where("entry_type", TreasuryEntryType.REFUND).where("status", TreasuryStatus.PENDING)
        .select(TREASURY_LEDGER_COLUMNS).first();
    return row ? toEntity(row) : undefined;
}

// Backed by idx_treasury_ledger_payee (partial index on entry_type = 'payout').
export async function findPayoutsByPayee(
    payeeAccountType: PayeeAccountType,
    payeeAccountId: number,
    range: { from: Date; to: Date },
    pagination: PaginationParams,
    conn: Knex,
): Promise<TreasuryLedgerEntry[]> {
    let query = conn("treasury_ledger")
        .where("payee_account_type", payeeAccountType)
        .where("payee_account_id", payeeAccountId)
        .where("entry_type", TreasuryEntryType.PAYOUT)
        .where("created_at", ">=", range.from)
        .where("created_at", "<=", range.to)
        .select(TREASURY_LEDGER_COLUMNS);
    query = applyCursorPagination(query, pagination);
    return (await query).map(toEntity);
}

export async function updateTreasuryEntry(id: number, data: UpdateTreasuryEntryInput, conn: Knex): Promise<TreasuryLedgerEntry> {
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (data.status !== undefined) patch.status = data.status;
    if (data.providerReferenceId !== undefined) patch.provider_reference_id = data.providerReferenceId;
    if (data.isRefunded !== undefined) patch.is_refunded = data.isRefunded;
    if (data.refundedEntryId !== undefined) patch.refunded_entry_id = data.refundedEntryId;
    const [row] = await conn("treasury_ledger").where("id", id).update(patch).returning(TREASURY_LEDGER_COLUMNS);
    return toEntity(row);
}
