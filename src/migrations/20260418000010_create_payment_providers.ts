import type { Knex } from "knex";
import { regionOf } from "../lib/knex/types";

// Not sharded in schema (docs/database-design.md §2 "Tables that ARE NOT sharded"),
// but each region still gets its own migration run against its own DB — every shard's
// Knex config carries its own `region` (see lib/knex/types.ts regionOf), so the seed
// below is region-conditional regardless of whether migrations are driven by the CLI
// (REGION env var) or scripts/migrate-all.ts (no env var, built programmatically).
// This table only ever holds real payment gateways — COD is a payment *method*
// (orders.payment_method / transactions.method), not a provider, and gets no row
// here (see app/payment/enums.ts PaymentProviderName).
export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("payment_providers", (table) => {
        table.integer("id").primary();
        table.text("name").notNullable();
        table.boolean("is_enabled").notNullable().defaultTo(true);
        table.smallint("priority").notNullable().defaultTo(100);

        table.unique("name", { indexName: "uq_payment_providers_name" });
    });

    // Kashier is only configured for the eg region (env.payments.regionProviderMap,
    // PAYMENT_PROVIDERS_BY_REGION=eg:kashier) — don't seed a row implying it's usable
    // elsewhere.
    if (regionOf(knex) === "eg") {
        await knex("payment_providers").insert([{ id: 1, name: "kashier", is_enabled: true, priority: 10 }]);
    }
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("payment_providers");
}
