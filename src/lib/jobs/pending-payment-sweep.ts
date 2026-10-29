import { container } from "../di/container";
import { TOKENS } from "../di/tokens";
import { env } from "../config/env";
import { logger } from "../logger/logger";
import { cacheProvider } from "../cache/init";
import { toMs } from "../../pkg/utils/time";
import type { OrderService } from "../../app/order/service/order.service";

// docs/business-logic/orders.md §9 / payments.md §9 — the only background worker
// besides the Phase 7 cold-archival worker; same shape (setInterval + a Redis lock
// guarding each tick so more than one running process can't double-cancel the same
// orders — see docs/implementation-plan.md's Phase 7 archival-worker description).
const LOCK_KEY = "sweep:pending-payment:lock";

export async function runPendingPaymentSweep(): Promise<void> {
    // TTL a touch under the tick interval: if this process dies mid-sweep, the lock
    // expires before the next scheduled tick instead of wedging the sweep off forever.
    const lockTtlSec = Math.max(1, env.orders.sweepIntervalSec - 5);
    const gotLock = await cacheProvider.trySet(LOCK_KEY, "1", lockTtlSec);
    if (!gotLock) return;

    const orderService = container.resolve<OrderService>(TOKENS.OrderService);

    for (const region of env.regions) {
        try {
            const cancelled = await orderService.sweepStalePendingPaymentOrders(region, env.orders.pendingPaymentTimeoutMin);
            if (cancelled > 0) {
                logger.info("pending-payment sweep cancelled stale orders", { region, cancelled });
            }
        } catch (err) {
            logger.error("pending-payment sweep failed for region", { region, error: (err as Error).message });
        }
    }
}

export function startPendingPaymentSweep(): NodeJS.Timeout {
    const intervalMs = toMs(env.orders.sweepIntervalSec, "s");
    return setInterval(() => {
        runPendingPaymentSweep().catch((err) => {
            logger.error("pending-payment sweep tick failed", { error: (err as Error).message });
        });
    }, intervalMs);
}
