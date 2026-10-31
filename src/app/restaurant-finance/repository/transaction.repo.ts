import { Knex } from "knex";
import { TransactionMethod, TransactionStatus, TransactionType } from "../../payment/enums";
import { PaginationParams } from "../../../lib/http/pagination/types";
import { applyCursorPagination } from "../../../lib/http/pagination/cursor-pagination";
import { PayoutRow } from "../types";

// This module owns no part of the `transactions` table's schema (that's the Payments
// module's migration — see 20260418000050_create_transactions.ts) but writes directly
// to the shared ledger via its own minimal repo, the same way order.repo.ts already
// queries `transactions` directly for the pending-payment sweep (CLAUDE.md §3 — no
// cross-module repository *imports*; a shared SQL table accessed from each module's own
// repo file is not the same thing as reaching into another module's repository code).

// commission and cod_collection rows are written inside the trx delivery.service already
// owns (agents.md §7) — `method` is 'system' for commission since no payment method
// moved this money, it's a platform-side bookkeeping entry.
export async function insertCommission(
    data: { region: string; orderId: number; orderCreatedAt: Date; restaurantId: number; amount: number; currency: string },
    conn: Knex,
): Promise<void> {
    await conn("transactions").insert({
        region: data.region,
        order_id: data.orderId,
        order_created_at: data.orderCreatedAt,
        transaction_type: TransactionType.COMMISSION,
        method: TransactionMethod.SYSTEM,
        status: TransactionStatus.SUCCEEDED,
        amount: data.amount,
        currency: data.currency,
        src_acc_id: data.restaurantId,
        dst_acc_id: null,
        created_at: new Date(),
        updated_at: new Date(),
    });
}

// The only point a COD order's cash ever enters the ledger (restaurant-finance.md §7) —
// placement writes no transaction at all for COD.
export async function insertCodCollection(
    data: {
        region: string;
        orderId: number;
        orderCreatedAt: Date;
        customerId: number;
        restaurantId: number;
        amount: number;
        currency: string;
    },
    conn: Knex,
): Promise<void> {
    await conn("transactions").insert({
        region: data.region,
        order_id: data.orderId,
        order_created_at: data.orderCreatedAt,
        transaction_type: TransactionType.COD_COLLECTION,
        method: TransactionMethod.COD,
        status: TransactionStatus.SUCCEEDED,
        amount: data.amount,
        currency: data.currency,
        src_acc_id: data.customerId,
        dst_acc_id: data.restaurantId,
        created_at: new Date(),
        updated_at: new Date(),
    });
}

export async function insertPayout(
    data: {
        region: string;
        restaurantId: number;
        amount: number;
        currency: string;
        providerReferenceId: string;
        idempotencyKey: string;
    },
    conn: Knex,
): Promise<PayoutRow> {
    const now = new Date();
    const [row] = await conn("transactions")
        .insert({
            region: data.region,
            order_id: null,
            order_created_at: null,
            transaction_type: TransactionType.PAYOUT,
            method: TransactionMethod.BANK_TRANSFER,
            status: TransactionStatus.SUCCEEDED,
            amount: data.amount,
            currency: data.currency,
            src_acc_id: null,
            dst_acc_id: data.restaurantId,
            provider_reference_id: data.providerReferenceId,
            idempotency_key: data.idempotencyKey,
            created_at: now,
            updated_at: now,
        })
        .returning(["id", "amount", "currency", "status", "provider_reference_id", "created_at"]);

    return toPayoutRow(row);
}

// Backed by idx_transactions_dst_acc_type_created_at (restaurant-finance.md §3).
export async function findPayoutsByRestaurant(
    restaurantId: number,
    range: { from: Date; to: Date },
    pagination: PaginationParams,
    conn: Knex,
): Promise<PayoutRow[]> {
    let query = conn("transactions")
        .where("dst_acc_id", restaurantId)
        .where("transaction_type", TransactionType.PAYOUT)
        .where("created_at", ">=", range.from)
        .where("created_at", "<=", range.to)
        .select(["id", "amount", "currency", "status", "provider_reference_id", "created_at"]);
    query = applyCursorPagination(query, pagination);
    return (await query).map(toPayoutRow);
}

function toPayoutRow(row: any): PayoutRow {
    return {
        id: Number(row.id),
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        providerReferenceId: row.provider_reference_id,
        createdAt: row.created_at,
    };
}
