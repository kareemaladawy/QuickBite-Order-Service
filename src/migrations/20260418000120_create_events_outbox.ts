import type { Knex } from "knex";

// Transactional outbox for events this service emits to analytics-service (order
// lifecycle + payment outcomes). Written in the same trx as the domain mutation it
// describes; drained by lib/events/outbox-drain.ts into the `order.events` exchange.
// No `region` column — this table lives per-shard (one per region's hot DB), so the
// shard itself is the region; a row never needs to say which one it's in.
export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("events_outbox", (table) => {
        table.bigIncrements("id").primary();
        table.text("aggregate_type").notNullable();
        table.text("aggregate_id").notNullable();
        table.text("event_type").notNullable();
        table.uuid("event_id").notNullable();
        table.jsonb("payload").notNullable();
        table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
        table.timestamp("dispatched_at", { useTz: false }).nullable();
        table.integer("attempts").notNullable().defaultTo(0);
        table.text("last_error").nullable();

        table.unique(["event_id"], { indexName: "uq_events_outbox_event_id" });
    });

    // supports the drain's SELECT ... WHERE dispatched_at IS NULL ORDER BY
    // created_at LIMIT ? FOR UPDATE SKIP LOCKED
    await knex.raw(`
        CREATE INDEX idx_events_outbox_dispatched_at
            ON events_outbox (created_at)
            WHERE dispatched_at IS NULL
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("events_outbox");
}
