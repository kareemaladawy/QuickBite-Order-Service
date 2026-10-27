import "reflect-metadata";
import { env } from "../src/lib/config/env";
import { db, destroyAll } from "../src/lib/knex/knex";
import { ensureOrderMonthPartitions } from "../src/lib/knex/partitioning";

// Keeps the next N months of `orders` partitions pre-created, per region. Safe to
// re-run (idempotent) — run it monthly (ops cron) to keep partitions rolling forward.
// Usage: npm run db:ensure-partitions [monthsAhead]
async function main(): Promise<void> {
    const monthsAhead = Number(process.argv[2] ?? 12);

    for (const region of env.regions) {
        const created = await ensureOrderMonthPartitions(db(region), monthsAhead);
        console.log(
            created.length > 0
                ? `[partitions] region=${region} created: ${created.join(", ")}`
                : `[partitions] region=${region} already up to date`,
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
