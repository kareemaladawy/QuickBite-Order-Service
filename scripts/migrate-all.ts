import "reflect-metadata";
import { db, dbArchive, destroyAll } from "../src/lib/knex/knex";
import { listConfiguredRegions } from "../src/lib/knex/shards";

function parseCluster(): "hot" | "archive" {
    const arg = process.argv.find((a) => a.startsWith("--cluster="));
    const value = arg?.split("=")[1] ?? "hot";
    if (value !== "hot" && value !== "archive") {
        throw new Error(`[migrate:all] unknown --cluster value: ${value}`);
    }
    return value;
}

// Migrations iterate over every configured region — there is no global database
// for this service (docs/database-design.md §6).
async function main(): Promise<void> {
    const cluster = parseCluster();
    const regions = listConfiguredRegions(cluster);
    for (const region of regions) {
        console.log(`[migrate:all] cluster=${cluster} region=${region}`);
        const conn = cluster === "archive" ? dbArchive(region) : db(region);
        const [batchNo, migrations] = await conn.migrate.latest();
        console.log(
            migrations.length > 0
                ? `  batch ${batchNo}: ${migrations.join(", ")}`
                : "  already up to date",
        );
    }
}

main()
    .then(() => destroyAll())
    .catch(async (err) => {
        console.error(err);
        await destroyAll();
        process.exit(1);
    });
