import type { Knex } from "knex";

// The restaurant account ledger — one signed row per balance change (settlement,
// commission, refund clawback, payout, manual adjustment), with balance_after
// snapshotted on every row. restaurant_balances becomes a pure cached projection
// of SUM(amount) over this table, kept in sync by the same trx that writes the row.
const RESTAURANT_LEDGER_ENTRY_TYPES = ["settlement_credit", "commission_debit", "refund_debit", "payout_debit", "adjustment"];

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("restaurant_balances", (table) => {
        table.bigInteger("restaurant_id").notNullable();
        table.text("region").notNullable();
        table.text("currency").notNullable();
        table.integer("balance").notNullable().defaultTo(0);
        table.timestamp("updated_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
        table.primary(["restaurant_id", "currency"]);
    });
    // No balance >= 0 check this time: a refund clawback on an already-settled order
    // can push a restaurant into debt, recovered from its next payout.

    await knex.schema.createTable("restaurant_ledger", (table) => {
        table.bigIncrements("id").primary();
        table.text("region").notNullable();
        table.bigInteger("restaurant_id").notNullable();
        table.text("currency").notNullable();
        table.text("entry_type").notNullable();
        table.integer("amount").notNullable();
        table.integer("balance_after").notNullable();
        table.bigInteger("order_id").nullable();
        table.timestamp("order_created_at", { useTz: false }).nullable();
        table.bigInteger("treasury_ledger_id").nullable();
        table.text("note").nullable();
        table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());

        table.foreign(["order_id", "order_created_at"], "fk_restaurant_ledger_order_id").references(["id", "created_at"]).inTable("orders");
        table.foreign("treasury_ledger_id", "fk_restaurant_ledger_treasury_ledger_id").references("id").inTable("treasury_ledger");
    });

    // one settlement/commission/refund line per order per type — also the idempotency
    // guard for recordDeliverySettlement / recordRefundClawback
    await knex.raw(`CREATE UNIQUE INDEX uq_restaurant_ledger_restaurant_order_type ON restaurant_ledger (restaurant_id, order_id, entry_type) WHERE order_id IS NOT NULL`);
    // one payout_debit line per treasury payout row
    await knex.raw(`CREATE UNIQUE INDEX uq_restaurant_ledger_treasury ON restaurant_ledger (restaurant_id, treasury_ledger_id, entry_type) WHERE treasury_ledger_id IS NOT NULL`);
    // supports GET /restaurant/ledger
    await knex.raw(`CREATE INDEX idx_restaurant_ledger_restaurant_created_at ON restaurant_ledger (restaurant_id, currency, created_at DESC)`);

    await knex.raw(`ALTER TABLE restaurant_ledger ADD CONSTRAINT chk_restaurant_ledger_entry_type CHECK (entry_type IN (${RESTAURANT_LEDGER_ENTRY_TYPES.map((s) => `'${s}'`).join(", ")}))`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("restaurant_ledger");
    await knex.schema.dropTableIfExists("restaurant_balances");
}
