import type { Knex } from "knex";

export type Cluster = "hot" | "archive";

// Every shard's Knex config carries its own region, set once at construction (see
// shards.ts buildConfig / knexfile.ts) — the only reliable way for a migration
// function to know which region's DB it's running against. `process.env.REGION` is
// only set for the CLI (`npm run migrate`) path; migrate-all.ts builds connections
// programmatically per region without touching process.env.
export interface ShardKnexConfig extends Knex.Config {
    region: string;
}

export function regionOf(knex: Knex): string {
    return (knex.client.config as ShardKnexConfig).region;
}

export interface ShardPing {
    region: string;
    cluster: Cluster;
    ok: boolean;
    error?: string;
}

export interface MonthPartitionBound {
    name: string;
    from: string; // YYYY-MM-DD
    to: string;   // YYYY-MM-DD, exclusive
}
