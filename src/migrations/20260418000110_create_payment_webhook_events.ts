import type { Knex } from "knex";

// Dedupe ledger for inbound Kashier webhooks. Kashier has no single generic "event id"
// field (docs/business-logic/payments.md's `provider_event_id` is realized here as
// `<transactionId>:<status>` — see payment-webhook.service.ts — so repeated status
// updates for the same transaction are each processed once, but exact repeats
// (Kashier's own retries) are not).
export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("payment_webhook_events", (table) => {
        table.bigIncrements("id").primary();
        table.text("region").notNullable();
        table.integer("provider_id").notNullable();
        table.text("provider_event_id").notNullable();
        table.text("signature").notNullable();
        table.jsonb("payload").notNullable();
        table.timestamp("processed_at", { useTz: false }).nullable();
        table.text("process_error").nullable();
        table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());

        table.unique(["provider_id", "provider_event_id"], { indexName: "uq_payment_webhook_events_provider_id_event_id" });
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("payment_webhook_events");
}
