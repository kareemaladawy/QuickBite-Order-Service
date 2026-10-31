// Shared by lib/jobs/archival.worker.ts — describes one hot-cluster table the nightly
// archival worker knows how to move rows out of. Kept in types.ts per CLAUDE.md §10
// (no inline interfaces in logic files).
export interface ArchivalTableConfig {
    name: string;
    // Column the worker buckets rows by "prior year" vs "current year" on. Not always
    // literally `created_at` — agent_earnings has no such column, only `earned_at`.
    dateColumn: string;
    // Primary key columns, in the exact order the table's PK/unique constraint
    // declares them — `orders` is partitioned by created_at, so its PK is composite
    // (id, created_at); every other archived table has a plain `id` PK.
    pkColumns: string[];
    columns: string[];
    // `orders.id` is `GENERATED ALWAYS AS IDENTITY` — preserving the hot cluster's id
    // in the archive row (required so child tables' denormalized order_id still
    // resolves) needs `OVERRIDING SYSTEM VALUE` on the INSERT. Every other archived
    // table uses a plain bigserial, which accepts an explicit id with no such clause.
    identityPk: boolean;
}
