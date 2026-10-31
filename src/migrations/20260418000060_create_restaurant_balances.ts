import type { Knex } from "knex";

// One row per (restaurant, currency) — see docs/database-design.md §3.6. Credited on
// order `delivered` (subtotal - commission) and debited on payout, both via an atomic
// UPDATE/UPSERT rather than an explicit SELECT ... FOR UPDATE (see restaurant-balance.repo.ts).
export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("restaurant_balances", (table) => {
        table.bigInteger("restaurant_id").notNullable();
        table.text("region").notNullable();
        table.text("currency").notNullable();
        table.integer("balance").notNullable().defaultTo(0);
        table.timestamp("updated_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());

        table.primary(["restaurant_id", "currency"]);
    });

    await knex.raw(`ALTER TABLE restaurant_balances ADD CONSTRAINT chk_restaurant_balances_balance CHECK (balance >= 0)`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("restaurant_balances");
}
