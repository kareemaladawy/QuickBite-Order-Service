import type { Knex } from "knex";

// The agent account ledger — mirrors restaurant_ledger/restaurant_balances (same
// migration above), keyed by agent instead of restaurant. Replaces agent_earnings:
// GET /agents/earnings now reads agent_ledger filtered to entry_type = 'earning_credit'.
const AGENT_LEDGER_ENTRY_TYPES = ["earning_credit", "payout_debit", "adjustment"];

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("agent_balances", (table) => {
        table.bigInteger("agent_id").notNullable();
        table.text("region").notNullable();
        table.text("currency").notNullable();
        table.integer("balance").notNullable().defaultTo(0);
        table.timestamp("updated_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
        table.primary(["agent_id", "currency"]);
    });

    await knex.schema.createTable("agent_ledger", (table) => {
        table.bigIncrements("id").primary();
        table.text("region").notNullable();
        table.bigInteger("agent_id").notNullable();
        table.text("currency").notNullable();
        table.text("entry_type").notNullable();
        table.integer("amount").notNullable();
        table.integer("balance_after").notNullable();
        table.bigInteger("order_id").nullable();
        table.timestamp("order_created_at", { useTz: false }).nullable();
        table.bigInteger("treasury_ledger_id").nullable();
        table.text("note").nullable();
        table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());

        table.foreign(["order_id", "order_created_at"], "fk_agent_ledger_order_id").references(["id", "created_at"]).inTable("orders");
        table.foreign("treasury_ledger_id", "fk_agent_ledger_treasury_ledger_id").references("id").inTable("treasury_ledger");
    });

    // one earning_credit line per delivered order — also the idempotency guard for
    // AgentFinanceService.recordEarning
    await knex.raw(`CREATE UNIQUE INDEX uq_agent_ledger_agent_order_type ON agent_ledger (agent_id, order_id, entry_type) WHERE order_id IS NOT NULL`);
    // one payout_debit line per treasury payout row
    await knex.raw(`CREATE UNIQUE INDEX uq_agent_ledger_treasury ON agent_ledger (agent_id, treasury_ledger_id, entry_type) WHERE treasury_ledger_id IS NOT NULL`);
    // supports GET /agents/earnings and GET /agents/ledger
    await knex.raw(`CREATE INDEX idx_agent_ledger_agent_created_at ON agent_ledger (agent_id, currency, created_at DESC)`);

    await knex.raw(`ALTER TABLE agent_ledger ADD CONSTRAINT chk_agent_ledger_entry_type CHECK (entry_type IN (${AGENT_LEDGER_ENTRY_TYPES.map((s) => `'${s}'`).join(", ")}))`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("agent_ledger");
    await knex.schema.dropTableIfExists("agent_balances");
}
