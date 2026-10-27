import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("order_items", (table) => {
        table.bigIncrements("id").primary();
        table.text("region").notNullable();
        table.bigInteger("order_id").notNullable();
        // Denormalized from orders.created_at. orders is partitioned by created_at, and
        // Postgres requires an FK's target unique constraint to include the partition key,
        // so this FK is composite: (order_id, order_created_at) -> orders(id, created_at).
        // useTz:false: must match orders.created_at's `timestamp` (no tz) type exactly
        // for the composite FK below (and to avoid implicit tz-conversion surprises).
        table.timestamp("order_created_at", { useTz: false }).notNullable();
        table.bigInteger("product_id").notNullable();
        table.integer("quantity").notNullable();
        table.integer("unit_price_snapshot").notNullable();
        table.text("name_snapshot").notNullable();
        table.text("image_url_snapshot").nullable();
        table.integer("line_total").notNullable();
        table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());

        table
            .foreign(["order_id", "order_created_at"], "fk_order_items_order_id")
            .references(["id", "created_at"])
            .inTable("orders")
            .onDelete("CASCADE");

        // supports GET /orders/{orderId} item expansion (single batch fetch via whereIn)
        table.index("order_id", "idx_order_items_order_id");
    });

    await knex.raw(`ALTER TABLE order_items ADD CONSTRAINT chk_order_items_quantity CHECK (quantity > 0)`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("order_items");
}
