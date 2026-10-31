import { Knex } from "knex";
import { RestaurantBalance } from "../entity/restaurant-balance.entity";

const RESTAURANT_BALANCE_COLUMNS = ["restaurant_id", "region", "currency", "balance", "updated_at"];

function toEntity(row: any): RestaurantBalance {
    return new RestaurantBalance({
        restaurantId: Number(row.restaurant_id),
        region: row.region,
        currency: row.currency,
        balance: row.balance,
        updatedAt: row.updated_at,
    });
}

export async function findBalancesByRestaurant(restaurantId: number, conn: Knex): Promise<RestaurantBalance[]> {
    const rows = await conn("restaurant_balances").where("restaurant_id", restaurantId).select(RESTAURANT_BALANCE_COLUMNS);
    return rows.map(toEntity);
}

export async function findBalance(restaurantId: number, currency: string, conn: Knex): Promise<RestaurantBalance | undefined> {
    const row = await conn("restaurant_balances")
        .where({ restaurant_id: restaurantId, currency })
        .select(RESTAURANT_BALANCE_COLUMNS)
        .first();
    return row ? toEntity(row) : undefined;
}

// Atomic credit (order `delivered` settlement) via an upsert rather than a separate
// SELECT ... FOR UPDATE + UPDATE — a single statement that's correct under concurrency
// by construction (restaurant-finance.md §3 note on locking is satisfied either way).
export async function creditBalance(
    restaurantId: number,
    region: string,
    currency: string,
    deltaMinor: number,
    conn: Knex,
): Promise<RestaurantBalance> {
    const [row] = await conn("restaurant_balances")
        .insert({ restaurant_id: restaurantId, region, currency, balance: deltaMinor, updated_at: new Date() })
        .onConflict(["restaurant_id", "currency"])
        .merge({
            balance: conn.raw("restaurant_balances.balance + ?", [deltaMinor]),
            updated_at: new Date(),
        })
        .returning(RESTAURANT_BALANCE_COLUMNS);
    return toEntity(row);
}

// Atomic conditional debit (payout) — the WHERE clause rejects the write in the same
// statement as the balance check, so there's no window between "read balance" and
// "write balance" for a second payout to race through. Returns undefined when the
// balance is insufficient (including when no row exists yet, i.e. balance 0).
export async function debitIfSufficient(
    restaurantId: number,
    currency: string,
    amountMinor: number,
    conn: Knex,
): Promise<RestaurantBalance | undefined> {
    const [row] = await conn("restaurant_balances")
        .where({ restaurant_id: restaurantId, currency })
        .andWhere("balance", ">=", amountMinor)
        .update({ balance: conn.raw("balance - ?", [amountMinor]), updated_at: new Date() })
        .returning(RESTAURANT_BALANCE_COLUMNS);
    return row ? toEntity(row) : undefined;
}
