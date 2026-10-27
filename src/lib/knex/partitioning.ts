import { Knex } from "knex";
import { MonthPartitionBound } from "./types";

/**
 * Computes the [from, to) bound and partition name for the month `monthOffset`
 * months after `reference` (0 = current month).
 */
export function monthPartitionBound(monthOffset: number, reference = new Date()): MonthPartitionBound {
    const start = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + monthOffset, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const name = `orders_y${start.getUTCFullYear()}m${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
    return {
        name,
        from: start.toISOString().slice(0, 10),
        to: end.toISOString().slice(0, 10),
    };
}

/**
 * Ensures a monthly RANGE partition of `orders` exists for the current month and
 * the next `monthsAhead - 1` months. Idempotent — safe to re-run (e.g. monthly via
 * `npm run db:ensure-partitions`) to keep partitions rolling forward.
 */
export async function ensureOrderMonthPartitions(conn: Knex, monthsAhead = 12): Promise<string[]> {
    const created: string[] = [];

    for (let offset = 0; offset < monthsAhead; offset++) {
        const { name, from, to } = monthPartitionBound(offset);

        const existing = await conn.raw<{ rows: { oid: string | null }[] }>(
            `SELECT to_regclass(?) AS oid`,
            [name],
        );
        if (existing.rows[0]?.oid) continue;

        // Postgres doesn't accept bind parameters inside FOR VALUES FROM/TO (DDL), so the
        // date bounds are inlined as literals; they're computed internally, never user input.
        await conn.raw(
            `CREATE TABLE ?? PARTITION OF orders FOR VALUES FROM ('${from}') TO ('${to}')`,
            [name],
        );
        created.push(name);
    }

    return created;
}
