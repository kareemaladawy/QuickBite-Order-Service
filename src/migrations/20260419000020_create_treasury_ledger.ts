import type { Knex } from "knex";

// The treasury ledger — one row per real-world money event (a Kashier charge/refund,
// a bank-transfer payout, or cash collected on delivery). This is what finance
// reconciles against Kashier's daily settlement report. Commission never appears
// here — it's an internal accounting concept, not a bank event — see
// restaurant_ledger/agent_ledger (account ledgers) for that.
const TREASURY_ENTRY_TYPES = ["charge", "refund", "payout", "cod_collection"];
const TREASURY_METHODS = ["online", "cod", "bank_transfer"];
const TREASURY_STATUSES = ["pending", "succeeded", "failed", "reversed"];
const PAYEE_ACCOUNT_TYPES = ["restaurant", "agent"];

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("treasury_ledger", (table) => {
        table.bigIncrements("id").primary();
        table.text("region").notNullable();
        table.bigInteger("order_id").nullable();
        table.timestamp("order_created_at", { useTz: false }).nullable();
        table.text("entry_type").notNullable();
        table.text("method").notNullable();
        table.integer("provider_id").nullable();
        table.text("provider_reference_id").nullable();
        table.text("status").notNullable();
        table.integer("amount").notNullable();
        table.text("currency").notNullable();
        // Logical FK to core.users.id — the payer, for charge/refund/cod_collection.
        table.bigInteger("customer_id").nullable();
        // Resolves straight to restaurants.id / agents.id (never a core.users id) —
        // fixes the owner-user-id-vs-restaurant-id mismatch the old `transactions`
        // table had between src_acc_id/dst_acc_id and restaurant_balances.
        table.text("payee_account_type").nullable();
        table.bigInteger("payee_account_id").nullable();
        table.boolean("is_refunded").notNullable().defaultTo(false);
        table.bigInteger("refunded_entry_id").nullable();
        table.text("idempotency_key").nullable();
        table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
        table.timestamp("updated_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());

        table.foreign(["order_id", "order_created_at"], "fk_treasury_ledger_order_id").references(["id", "created_at"]).inTable("orders");
        table.foreign("refunded_entry_id", "fk_treasury_ledger_refunded_entry_id").references("id").inTable("treasury_ledger");
        table.unique("idempotency_key", { indexName: "uq_treasury_ledger_idempotency_key" });
        // supports GET /restaurants/:id/payments/:paymentId and order-ledger assembly
        table.index("order_id", "idx_treasury_ledger_order_id");
    });

    // supports the payment reconciler job and admin reconciliation scans by type/status/time
    await knex.raw(`CREATE INDEX idx_treasury_ledger_type_status_created_at ON treasury_ledger (entry_type, status, created_at)`);
    // supports the refund webhook's lookup of a pending refund by provider reference
    await knex.raw(`CREATE INDEX idx_treasury_ledger_provider_reference_id ON treasury_ledger (provider_reference_id) WHERE provider_reference_id IS NOT NULL`);
    // supports GET /restaurant/payouts and GET /agents/payouts (payee payout history)
    await knex.raw(`CREATE INDEX idx_treasury_ledger_payee ON treasury_ledger (payee_account_type, payee_account_id, entry_type, created_at DESC) WHERE entry_type = 'payout'`);

    await knex.raw(`ALTER TABLE treasury_ledger ADD CONSTRAINT chk_treasury_ledger_entry_type CHECK (entry_type IN (${TREASURY_ENTRY_TYPES.map((s) => `'${s}'`).join(", ")}))`);
    await knex.raw(`ALTER TABLE treasury_ledger ADD CONSTRAINT chk_treasury_ledger_method CHECK (method IN (${TREASURY_METHODS.map((s) => `'${s}'`).join(", ")}))`);
    await knex.raw(`ALTER TABLE treasury_ledger ADD CONSTRAINT chk_treasury_ledger_status CHECK (status IN (${TREASURY_STATUSES.map((s) => `'${s}'`).join(", ")}))`);
    await knex.raw(`ALTER TABLE treasury_ledger ADD CONSTRAINT chk_treasury_ledger_payee_account_type CHECK (payee_account_type IS NULL OR payee_account_type IN (${PAYEE_ACCOUNT_TYPES.map((s) => `'${s}'`).join(", ")}))`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("treasury_ledger");
}
