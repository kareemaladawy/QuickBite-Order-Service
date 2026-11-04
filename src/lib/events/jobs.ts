import { env } from "../config/env";
import { logger } from "../logger/logger";
import { cacheProvider } from "../cache/init";
import { toMs } from "../../pkg/utils/time";
import { drainOutboxForRegion } from "./outbox-drain";

// Same shape as lib/jobs/pending-payment-sweep.ts: setInterval + a per-region Redis
// lock so more than one running worker process can't double-claim the same region's
// batch (the lock is a courtesy — FOR UPDATE SKIP LOCKED in drainOutboxForRegion is
// what actually makes concurrent drains safe). The drain iterates every region on
// each tick.
const lockKeyFor = (region: string) => `outbox:drain:${region}:lock`;

export async function runOutboxDrain(): Promise<void> {
    const lockTtlSec = Math.max(1, env.outbox.intervalSec - 1);

    for (const region of env.regions) {
        const gotLock = await cacheProvider.trySet(lockKeyFor(region), "1", lockTtlSec);
        if (!gotLock) continue;

        try {
            const dispatched = await drainOutboxForRegion(region);
            if (dispatched > 0) {
                logger.info("outbox drain tick", { region, dispatched });
            }
        } catch (err) {
            logger.error("outbox drain failed for region", { region, error: (err as Error).message });
        }
    }
}

export function registerOutboxDrainJobs(): NodeJS.Timeout {
    const intervalMs = toMs(env.outbox.intervalSec, "s");
    return setInterval(() => {
        runOutboxDrain().catch((err) => {
            logger.error("outbox drain tick failed", { error: (err as Error).message });
        });
    }, intervalMs);
}
