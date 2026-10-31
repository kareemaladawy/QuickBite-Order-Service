import { container } from "../di/container";
import { TOKENS } from "../di/tokens";
import { env } from "../config/env";
import { logger } from "../logger/logger";
import { cacheProvider } from "../cache/init";
import { toMs } from "../../pkg/utils/time";
import type { OrderService } from "../../app/order/service/order.service";
import type { AssignmentService } from "../../app/agent/service/assignment.service";

// agents.md §3.5 — the real retry mechanism for broadcast/accept assignment. Same
// setInterval + per-region Redis lock shape as pending-payment-sweep.ts; registered via
// DI tokens only (CLAUDE.md §3 layering — lib/ never imports app/<module>/* directly,
// only types for DI resolution).
function sweepLockKey(region: string): string {
    return `assignment:sweep:${region}:lock`;
}

export async function runAssignmentSweep(): Promise<void> {
    const orderService = container.resolve<OrderService>(TOKENS.OrderService);
    const assignmentService = container.resolve<AssignmentService>(TOKENS.AssignmentService);

    for (const region of env.regions) {
        const lockTtlSec = Math.max(1, env.assignment.sweepCronSec - 2);
        const gotLock = await cacheProvider.trySet(sweepLockKey(region), "1", lockTtlSec);
        if (!gotLock) continue;

        try {
            const readyOrders = await orderService.findReadyOrdersForAssignment(region);
            for (const order of readyOrders) {
                try {
                    await assignmentService.tickSweepCandidate(order);
                } catch (err) {
                    logger.error("assignment sweep: tick failed for order", {
                        orderId: order.id,
                        region,
                        error: (err as Error).message,
                    });
                }
            }
        } catch (err) {
            logger.error("assignment sweep failed for region", { region, error: (err as Error).message });
        }
    }
}

export function startAssignmentSweep(): NodeJS.Timeout {
    const intervalMs = toMs(env.assignment.sweepCronSec, "s");
    return setInterval(() => {
        runAssignmentSweep().catch((err) => {
            logger.error("assignment sweep tick failed", { error: (err as Error).message });
        });
    }, intervalMs);
}
