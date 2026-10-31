import type { Knex } from "knex";

// docs/business-logic/agents.md §3 — the assignment broadcast (and the delivery-task
// DTO) need the branch's pickup lat/lng/name/address on every `ready` order. Snapshotting
// them here at order-creation time (mirrors delivery_address_text_snapshot) means the
// hot broadcast path never calls core-service's getBranch() just to re-fetch data that
// was already known when the order was placed. ALTER on the partitioned parent
// propagates to every partition.
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE orders ADD COLUMN pickup_lat DECIMAL(10,7) NOT NULL DEFAULT 0;
        ALTER TABLE orders ADD COLUMN pickup_lng DECIMAL(10,7) NOT NULL DEFAULT 0;
        ALTER TABLE orders ADD COLUMN pickup_address_text_snapshot TEXT NOT NULL DEFAULT '';
        ALTER TABLE orders ADD COLUMN branch_name_snapshot TEXT NOT NULL DEFAULT '';
        ALTER TABLE orders ALTER COLUMN pickup_lat DROP DEFAULT;
        ALTER TABLE orders ALTER COLUMN pickup_lng DROP DEFAULT;
        ALTER TABLE orders ALTER COLUMN pickup_address_text_snapshot DROP DEFAULT;
        ALTER TABLE orders ALTER COLUMN branch_name_snapshot DROP DEFAULT;
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE orders DROP COLUMN pickup_lat;
        ALTER TABLE orders DROP COLUMN pickup_lng;
        ALTER TABLE orders DROP COLUMN pickup_address_text_snapshot;
        ALTER TABLE orders DROP COLUMN branch_name_snapshot;
    `);
}
