import { Knex } from "knex";
import { RestaurantLedgerEntry } from "../entity/restaurant-ledger-entry.entity";
import { RestaurantLedgerEntryType } from "../enums";
import { PaginationParams } from "../../../lib/http/pagination/types";
import { applyCursorPagination } from "../../../lib/http/pagination/cursor-pagination";
import { InsertRestaurantLedgerEntryRow } from "../types";

const RESTAURANT_LEDGER_COLUMNS = [
    "id", "region", "restaurant_id", "currency", "entry_type", "amount", "balance_after",
    "order_id", "order_created_at", "treasury_ledger_id", "note", "created_at",
];

function toEntity(row: any): RestaurantLedgerEntry {
    return new RestaurantLedgerEntry({
        id: Number(row.id), region: row.region, restaurantId: Number(row.restaurant_id), currency: row.currency,
        entryType: row.entry_type, amount: row.amount, balanceAfter: row.balance_after,
        orderId: row.order_id === null ? null : Number(row.order_id), orderCreatedAt: row.order_created_at,
        treasuryLedgerId: row.treasury_ledger_id === null ? null : Number(row.treasury_ledger_id),
        note: row.note, createdAt: row.created_at,
    });
}

export async function insertLedgerEntry(data: InsertRestaurantLedgerEntryRow, conn: Knex): Promise<RestaurantLedgerEntry> {
    const [row] = await conn("restaurant_ledger")
        .insert({
            region: data.region, restaurant_id: data.restaurantId, currency: data.currency, entry_type: data.entryType,
            amount: data.amount, balance_after: data.balanceAfter, order_id: data.orderId ?? null,
            order_created_at: data.orderCreatedAt ?? null, treasury_ledger_id: data.treasuryLedgerId ?? null,
            note: data.note ?? null, created_at: new Date(),
        })
        .returning(RESTAURANT_LEDGER_COLUMNS);
    return toEntity(row);
}

// Backed by idx_restaurant_ledger_restaurant_created_at — supports GET /restaurant/ledger
export async function findLedgerByRestaurant(
    restaurantId: number,
    currency: string,
    range: { from: Date; to: Date },
    pagination: PaginationParams,
    conn: Knex,
): Promise<RestaurantLedgerEntry[]> {
    let query = conn("restaurant_ledger")
        .where("restaurant_id", restaurantId).where("currency", currency)
        .where("created_at", ">=", range.from).where("created_at", "<=", range.to)
        .select(RESTAURANT_LEDGER_COLUMNS);
    query = applyCursorPagination(query, pagination);
    return (await query).map(toEntity);
}

// Backed by uq_restaurant_ledger_restaurant_order_type — used to decide whether an
// order was ever settled (i.e. whether a refund on it needs a clawback).
export async function findLedgerEntryForOrder(
    restaurantId: number,
    orderId: number,
    entryType: RestaurantLedgerEntryType,
    conn: Knex,
): Promise<RestaurantLedgerEntry | undefined> {
    const row = await conn("restaurant_ledger")
        .where({ restaurant_id: restaurantId, order_id: orderId, entry_type: entryType })
        .select(RESTAURANT_LEDGER_COLUMNS).first();
    return row ? toEntity(row) : undefined;
}
