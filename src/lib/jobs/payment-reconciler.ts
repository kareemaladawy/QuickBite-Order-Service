import { container } from "../di/container";
import { TOKENS } from "../di/tokens";
import { env } from "../config/env";
import { logger } from "../logger/logger";
import { cacheProvider } from "../cache/init";
import { toMs } from "../../pkg/utils/time";
import type { PaymentService } from "../../app/payment/service/payment.service";

// docs/business-logic/payments.md §9 — retries the `pending_payment -> placed`
// transition for an order whose charge already succeeded but whose post-charge
// transition failed or never ran, instead of leaving it for the pending-payment sweep
// to (wrongly) cancel. Same shape as lib/jobs/pending-payment-sweep.ts: setInterval + a
// Redis lock guarding each tick so more than one running process can't double-process.
const LOCK_KEY = "reconciler:payment:lock";

export async function runPaymentReconciler(): Promise<void> {
    // TTL a touch under the tick interval: if this process dies mid-run, the lock
    // expires before the next scheduled tick instead of wedging the reconciler off.
    const lockTtlSec = Math.max(1, env.paymentReconciler.intervalSec - 5);
    const gotLock = await cacheProvider.trySet(LOCK_KEY, "1", lockTtlSec);
    if (!gotLock) return;

    const paymentService = container.resolve<PaymentService>(TOKENS.PaymentService);

    for (const region of env.regions) {
        try {
            const reconciled = await paymentService.reconcileStuckPlacedOrders(region, env.paymentReconciler.graceSec);
            if (reconciled > 0) {
                logger.info("payment reconciler: retried stuck pending_payment -> placed transitions", { region, reconciled });
            }
        } catch (err) {
            logger.error("payment reconciler failed for region", { region, error: (err as Error).message });
        }
    }
}

export function startPaymentReconciler(): NodeJS.Timeout {
    const intervalMs = toMs(env.paymentReconciler.intervalSec, "s");
    return setInterval(() => {
        runPaymentReconciler().catch((err) => {
            logger.error("payment reconciler tick failed", { error: (err as Error).message });
        });
    }, intervalMs);
}
