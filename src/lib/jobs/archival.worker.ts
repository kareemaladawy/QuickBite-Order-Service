import { Knex } from "knex";
import { env } from "../config/env";
import { logger } from "../logger/logger";
import { cacheProvider } from "../cache/init";
import { db, dbArchive } from "../knex/knex";
import { toMs } from "../../pkg/utils/time";
import { ArchivalTableConfig } from "./types";

// docs/implementation-plan.md Phase 5 — moves rows older than the current year from
// the hot cluster to the per-region archive cluster so the hot DB stays small
// (docs/system-design.md §10). One instance per region, same setInterval + per-region
// Redis lock shape as the other lib/jobs workers (pending-payment-sweep.ts,
// payment-reconciler.ts, assignment-sweep.worker.ts).
//
// This is pure cross-cluster row movement, not business logic — it operates on raw
// table/column names rather than going through app/<module> entities/repos (which are
// shaped for single-row reads/writes, not bulk copy of rows whose columns are opaque
// to this worker). That keeps it a lib/ concern with no app/ import, per CLAUDE.md §3.
//
// Listed child-first: the archive cluster runs the *same* migrations as the hot
// cluster (docs/implementation-plan.md Phase 5 Migrations), so it carries the exact
// same FK constraints. That cuts both ways —
//   - DELETE from hot must go child-first (hot's FKs are still enforced; order_items
//     cascades, the rest RESTRICT), so `orders` is last.
//   - INSERT into archive must go parent-first (archive's FKs are enforced too — a
//     child can't reference an `orders` row that isn't in archive yet), so this list
//     is walked in reverse for the insert phase (see runArchivalWorker).
const ARCHIVAL_TABLES: ArchivalTableConfig[] = [
    {
        name: "agent_earnings",
        dateColumn: "earned_at",
        pkColumns: ["id"],
        columns: ["id", "region", "agent_id", "order_id", "order_created_at", "amount", "currency", "earned_at"],
        identityPk: false,
    },
    {
        name: "payment_webhook_events",
        dateColumn: "created_at",
        pkColumns: ["id"],
        columns: [
            "id", "region", "provider_id", "provider_event_id", "signature",
            "payload", "processed_at", "process_error", "created_at",
        ],
        identityPk: false,
    },
    {
        name: "payment_sessions",
        dateColumn: "created_at",
        pkColumns: ["id"],
        columns: [
            "id", "region", "order_id", "order_created_at", "provider_id",
            "provider_session_id", "redirect_url", "amount", "currency", "status",
            "raw_init_payload", "raw_last_payload", "created_at", "updated_at",
        ],
        identityPk: false,
    },
    {
        name: "transactions",
        dateColumn: "created_at",
        pkColumns: ["id"],
        columns: [
            "id", "region", "order_id", "order_created_at", "transaction_type", "method",
            "provider_id", "provider_reference_id", "status", "amount", "currency",
            "src_acc_id", "dst_acc_id", "is_refunded", "refunded_payment_id",
            "idempotency_key", "created_at", "updated_at",
        ],
        identityPk: false,
    },
    {
        name: "order_items",
        dateColumn: "created_at",
        pkColumns: ["id"],
        columns: [
            "id", "region", "order_id", "order_created_at", "product_id", "quantity",
            "unit_price_snapshot", "name_snapshot", "image_url_snapshot", "line_total", "created_at",
        ],
        identityPk: false,
    },
    {
        name: "orders",
        dateColumn: "created_at",
        pkColumns: ["id", "created_at"],
        columns: [
            "id", "region", "public_id", "country_code", "restaurant_id", "branch_id",
            "customer_id", "customer_address_id", "delivery_lat", "delivery_lng",
            "delivery_address_text_snapshot", "pickup_lat", "pickup_lng",
            "pickup_address_text_snapshot", "branch_name_snapshot", "status", "subtotal",
            "delivery_fee", "service_fee", "total", "commission", "currency",
            "payment_method", "delivery_agent_id", "reassignment_attempts",
            "cancellation_reason", "created_at", "updated_at", "accepted_at",
            "rejected_at", "preparing_at", "ready_at", "assigned_at", "picked_at",
            "delivered_at", "cancelled_at",
        ],
        identityPk: true,
    },
];

function lockKey(region: string): string {
    return `archival:${region}:lock`;
}

function startOfCurrentYearUtc(): Date {
    return new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
}

function pkTuple(row: Record<string, unknown>, pkColumns: string[]): unknown[] {
    return pkColumns.map((col) => row[col]);
}

function pkKey(row: Record<string, unknown>, pkColumns: string[]): string {
    return pkTuple(row, pkColumns).map(String).join("|");
}

// Inserts straight into the archive cluster, ignoring a row that's already there
// (ON CONFLICT DO NOTHING) — the crash-safety net described in the implementation
// plan: a batch that commits to archive but crashes before the matching hot delete
// leaves the row in both places, and a re-run simply no-ops the re-insert.
async function insertArchiveBatch(
    archive: Knex,
    table: ArchivalTableConfig,
    rows: Record<string, unknown>[],
): Promise<void> {
    const query = archive(table.name).insert(rows).onConflict(table.pkColumns).ignore();

    if (!table.identityPk) {
        await query;
        return;
    }

    // knex has no query-builder API for `OVERRIDING SYSTEM VALUE`, so splice it into
    // the already-fully-built SQL (this still carries the ON CONFLICT clause above —
    // .toSQL() compiles the whole chain) right before the VALUES list.
    const { sql, bindings } = query.toSQL();
    const withOverride = sql.replace(/\)\s+values\s+\(/i, ") overriding system value values (");
    await archive.raw(withOverride, bindings as Knex.RawBinding[]);
}

// Phase 1 (parent-first across tables): copies every qualifying row from hot into
// archive, batch by batch. Paginated by `id` (every archived table's leading PK
// column is a monotonic bigserial/identity) rather than relying on hot shrinking as
// rows move, since nothing is deleted from hot until phase 2.
async function insertTableIntoArchive(
    region: string,
    table: ArchivalTableConfig,
    hot: Knex,
    archive: Knex,
    cutoff: Date,
    deadlineMs: number,
): Promise<void> {
    let cursorId = 0;

    while (Date.now() < deadlineMs) {
        const rows: Record<string, unknown>[] = await hot(table.name)
            .where(table.dateColumn, "<", cutoff)
            .andWhere("id", ">", cursorId)
            .orderBy("id", "asc")
            .limit(env.archival.batchSize)
            .select(table.columns);

        if (rows.length === 0) break;

        try {
            await insertArchiveBatch(archive, table, rows);
            logger.info("archival worker: inserted batch into archive", { region, table: table.name, rows: rows.length });
        } catch (err) {
            logger.error("archival worker: insert into archive failed, leaving batch in hot for the next run", {
                region,
                table: table.name,
                rows: rows.length,
                error: (err as Error).message,
            });
            break;
        }

        cursorId = Number(rows[rows.length - 1].id);
        if (rows.length < env.archival.batchSize) break;
    }
}

// Phase 2 (child-first across tables): deletes from hot whatever phase 1 already
// landed in archive. Only deletes rows confirmed present in archive — a row phase 1
// couldn't insert (logged above) is left in hot rather than risk losing it, and picked
// up again once a later run's phase 1 succeeds for it.
async function deleteTableFromHot(
    region: string,
    table: ArchivalTableConfig,
    hot: Knex,
    archive: Knex,
    cutoff: Date,
    deadlineMs: number,
): Promise<void> {
    while (Date.now() < deadlineMs) {
        const rows: Record<string, unknown>[] = await hot(table.name)
            .where(table.dateColumn, "<", cutoff)
            .orderBy("id", "asc")
            .limit(env.archival.batchSize)
            .select(table.pkColumns);

        if (rows.length === 0) break;

        const idTuples = rows.map((row) => pkTuple(row, table.pkColumns));
        const archivedRows: Record<string, unknown>[] = await archive(table.name)
            .whereIn(table.pkColumns, idTuples as Knex.Value[][])
            .select(table.pkColumns);
        const archivedKeys = new Set(archivedRows.map((row) => pkKey(row, table.pkColumns)));
        const toDelete = rows.filter((row) => archivedKeys.has(pkKey(row, table.pkColumns)));

        if (toDelete.length === 0) {
            logger.warn("archival worker: batch not yet archived, leaving in hot for the next run", {
                region,
                table: table.name,
                rows: rows.length,
            });
            break;
        }

        try {
            await hot(table.name)
                .whereIn(table.pkColumns, toDelete.map((row) => pkTuple(row, table.pkColumns)) as Knex.Value[][])
                .del();
            logger.info("archival worker: deleted batch from hot", { region, table: table.name, rows: toDelete.length });
        } catch (err) {
            logger.error("archival worker: delete from hot failed after archive insert — row left in both clusters", {
                region,
                table: table.name,
                rows: toDelete.length,
                error: (err as Error).message,
            });
            break;
        }

        // Fewer rows deleted than selected means some weren't archived yet — stop here
        // rather than reselecting the same stuck rows forever this run.
        if (toDelete.length < rows.length) break;
    }
}

export async function runArchivalWorker(): Promise<void> {
    for (const region of env.regions) {
        // Lock TTL covers the full runtime budget plus a buffer, so a process that
        // dies mid-run doesn't wedge the region off until the lock's own expiry —
        // but also doesn't let a second process pile on while this one is working.
        const lockTtlSec = Math.max(60, toMs(env.archival.maxRuntimeMin, "m") / 1000 + 60);
        const gotLock = await cacheProvider.trySet(lockKey(region), "1", lockTtlSec);
        if (!gotLock) continue;

        const deadlineMs = Date.now() + toMs(env.archival.maxRuntimeMin, "m");
        const cutoff = startOfCurrentYearUtc();
        const hot = db(region);
        const archive = dbArchive(region);

        try {
            // Phase 1: copy hot -> archive, parent-first (reverse of the child-first
            // delete order above — archive enforces the same FKs as hot).
            for (const table of [...ARCHIVAL_TABLES].reverse()) {
                if (Date.now() >= deadlineMs) break;
                await insertTableIntoArchive(region, table, hot, archive, cutoff, deadlineMs);
            }

            // Phase 2: delete from hot whatever phase 1 landed, child-first.
            for (const table of ARCHIVAL_TABLES) {
                if (Date.now() >= deadlineMs) {
                    logger.warn("archival worker: max runtime reached, resuming remaining tables on the next run", {
                        region,
                    });
                    break;
                }
                await deleteTableFromHot(region, table, hot, archive, cutoff, deadlineMs);
            }
        } catch (err) {
            logger.error("archival worker failed for region", { region, error: (err as Error).message });
        }
    }
}

export function startArchivalWorker(): NodeJS.Timeout {
    const intervalMs = toMs(env.archival.intervalSec, "s");
    return setInterval(() => {
        runArchivalWorker().catch((err) => {
            logger.error("archival worker tick failed", { error: (err as Error).message });
        });
    }, intervalMs);
}
