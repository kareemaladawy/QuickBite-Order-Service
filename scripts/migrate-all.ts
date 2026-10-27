import "reflect-metadata";
import { env } from "../src/lib/config/env";
import { db, destroyAll } from "../src/lib/knex/knex";

// Migrations iterate over every configured region — there is no global database
// for this service (docs/database-design.md §6).
async function main(): Promise<void> {
    for (const region of env.regions) {
        console.log(`[migrate:all] region=${region}`);
        const conn = db(region);
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
