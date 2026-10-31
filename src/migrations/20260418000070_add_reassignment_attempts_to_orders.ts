import type { Knex } from "knex";

// docs/database-design.md §3.1 — bumped on every reassign (admin-triggered or the
// assignment-sweep worker); capped by MAX_REASSIGNMENT_ATTEMPTS. Added here rather than
// in the original create_orders migration because Phase 3 (agents/delivery) is the first
// phase that needs it. ALTER on the partitioned parent propagates to every partition.
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`ALTER TABLE orders ADD COLUMN reassignment_attempts SMALLINT NOT NULL DEFAULT 0`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`ALTER TABLE orders DROP COLUMN reassignment_attempts`);
}
