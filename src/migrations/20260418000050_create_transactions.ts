import type { Knex } from "knex";

const TRANSACTION_TYPES = ["charge", "refund", "commission", "payout", "cod_collection", "adjustment"];
const TRANSACTION_METHODS = ["online", "cod", "bank_transfer", "system"];
const TRANSACTION_STATUSES = ["pending", "succeeded", "failed", "reversed"];

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("transactions", (table) => {
        table.bigIncrements("id").primary();
        table.text("region").notNullable();
        table.bigInteger("order_id").nullable(); // NULL for payouts not tied to an order
        // Denormalized from orders.created_at, nullable to match order_id — a composite
        // FK with any NULL member is simply not checked by Postgres, so this still
        // supports payout rows that carry no order link at all. See order_items'
        // migration comment for why the FK must be composite in the first place.
        table.timestamp("order_created_at", { useTz: false }).nullable();
        table.text("transaction_type").notNullable();
        table.text("method").notNullable();
        table.integer("provider_id").nullable();
        table.text("provider_reference_id").nullable();
        table.text("status").notNullable();
        table.integer("amount").notNullable();
        table.text("currency").notNullable();
        table.bigInteger("src_acc_id").nullable();
        table.bigInteger("dst_acc_id").nullable();
        table.boolean("is_refunded").notNullable().defaultTo(false);
        table.bigInteger("refunded_payment_id").nullable();
        table.text("idempotency_key").nullable();
        table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
        table.timestamp("updated_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());

        table
            .foreign(["order_id", "order_created_at"], "fk_transactions_order_id")
            .references(["id", "created_at"])
            .inTable("orders");
        table.foreign("refunded_payment_id", "fk_transactions_refunded_payment_id").references("id").inTable("transactions");

        table.unique("idempotency_key", { indexName: "uq_transactions_idempotency_key" });

        // supports order detail expansion (1 round trip per order's tx ledger)
        table.index("order_id", "idx_transactions_order_id");
        // supports finance reconciliation by status + type
        table.index(["transaction_type", "status", "created_at"], "idx_transactions_type_status_created_at");
    });

    // supports restaurant payout history: GET /restaurant/payouts?from=&to= (Phase 5)
    await knex.raw(
        `CREATE INDEX idx_transactions_dst_acc_type_created_at ON transactions (dst_acc_id, transaction_type, created_at DESC) WHERE transaction_type = 'payout'`,
    );
    // supports webhook/refund correlation lookup where provider_reference_id is set
    await knex.raw(
        `CREATE INDEX idx_transactions_provider_reference_id ON transactions (provider_reference_id) WHERE provider_reference_id IS NOT NULL`,
    );

    await knex.raw(
        `ALTER TABLE transactions ADD CONSTRAINT chk_transactions_type CHECK (transaction_type IN (${TRANSACTION_TYPES.map((s) => `'${s}'`).join(", ")}))`,
    );
    await knex.raw(
        `ALTER TABLE transactions ADD CONSTRAINT chk_transactions_method CHECK (method IN (${TRANSACTION_METHODS.map((s) => `'${s}'`).join(", ")}))`,
    );
    await knex.raw(
        `ALTER TABLE transactions ADD CONSTRAINT chk_transactions_status CHECK (status IN (${TRANSACTION_STATUSES.map((s) => `'${s}'`).join(", ")}))`,
    );
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("transactions");
}
