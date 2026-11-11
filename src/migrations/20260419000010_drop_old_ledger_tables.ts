import type { Knex } from "knex";

// Clean replace, agreed with the team: this is a pre-production schema (phased build,
// no real traffic), so there's nothing to backfill. Superseded by treasury_ledger +
// restaurant_ledger/restaurant_balances + agent_ledger/agent_balances (next three
// migrations).
export async function up(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("agent_earnings");
    await knex.schema.dropTableIfExists("restaurant_balances");
    await knex.schema.dropTableIfExists("transactions");
}

export async function down(knex: Knex): Promise<void> {
    // Clean replace by agreement — no data to preserve, so there's nothing to restore.
}
