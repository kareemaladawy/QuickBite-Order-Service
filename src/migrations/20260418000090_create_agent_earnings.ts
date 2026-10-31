import type { Knex } from "knex";

// Per-order earnings snapshot, written once at `delivered` (docs/database-design.md
// §3.7). Composite FK into `orders` for the same partitioning reason as `order_items`
// (see that migration's comment) — `order_created_at` is denormalized from
// `orders.created_at`.
export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("agent_earnings", (table) => {
        table.bigIncrements("id").primary();
        table.text("region").notNullable();
        table.bigInteger("agent_id").notNullable();
        table.bigInteger("order_id").notNullable();
        table.timestamp("order_created_at", { useTz: false }).notNullable();
        table.integer("amount").notNullable();
        table.text("currency").notNullable();
        table.timestamp("earned_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());

        table
            .foreign(["order_id", "order_created_at"], "fk_agent_earnings_order_id")
            .references(["id", "created_at"])
            .inTable("orders");
        table.unique("order_id", { indexName: "uq_agent_earnings_order_id" });
    });

    // supports GET /agents/earnings?from=&to= (ordered agent_id, earned_at DESC)
    await knex.raw(`CREATE INDEX idx_agent_earnings_agent_earned_at ON agent_earnings (agent_id, earned_at DESC)`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("agent_earnings");
}
