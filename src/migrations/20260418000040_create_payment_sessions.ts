import type { Knex } from "knex";

const SESSION_STATUSES = ["initialized", "pending", "authorized", "captured", "failed", "expired", "cancelled"];

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("payment_sessions", (table) => {
        table.bigIncrements("id").primary();
        table.text("region").notNullable();
        table.bigInteger("order_id").notNullable();
        // Denormalized from orders.created_at — orders is partitioned by created_at, so
        // any real FK into it must be composite (order_id, order_created_at), same
        // pattern as order_items (see that migration's comment for the full reasoning).
        table.timestamp("order_created_at", { useTz: false }).notNullable();
        table.integer("provider_id").notNullable();
        table.text("provider_session_id").notNullable();
        table.text("redirect_url").notNullable();
        table.integer("amount").notNullable();
        table.text("currency").notNullable();
        table.text("status").notNullable();
        table.jsonb("raw_init_payload").notNullable();
        table.jsonb("raw_last_payload").nullable();
        table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
        table.timestamp("updated_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());

        table
            .foreign(["order_id", "order_created_at"], "fk_payment_sessions_order_id")
            .references(["id", "created_at"])
            .inTable("orders");

        table.unique("provider_session_id", { indexName: "uq_payment_sessions_provider_session_id" });
        // supports webhook lookup by Kashier session id
        table.index("provider_session_id", "idx_payment_sessions_provider_session_id");
        // supports order -> session lookup (init-retry idempotency check)
        table.index("order_id", "idx_payment_sessions_order_id");
    });

    await knex.raw(
        `ALTER TABLE payment_sessions ADD CONSTRAINT chk_payment_sessions_status CHECK (status IN (${SESSION_STATUSES.map((s) => `'${s}'`).join(", ")}))`,
    );
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("payment_sessions");
}
