import "reflect-metadata";
import http from "http";
import { logger } from "./lib/logger/logger";
import { destroyAll, pingAll } from "./lib/knex/knex";
import { attachWsServer } from "./lib/websocket/ws-server";
import { container } from "./lib/di/container";
import { TOKENS } from "./lib/di/tokens";
import { startPendingPaymentSweep } from "./lib/jobs/pending-payment-sweep";
import { startPaymentReconciler } from "./lib/jobs/payment-reconciler";
import { startAssignmentSweep } from "./lib/jobs/assignment-sweep.worker";
import { startArchivalWorker } from "./lib/jobs/archival.worker";

// Never listens — attachWsServer only needs an HttpServer to bind socket.io
// internals to. Its redis-adapter still fans emits out to every connected
// socket on the real server.ts processes, so services resolving
// TOKENS.WsServer to publish status changes work unchanged in this process.
const dummyServer = http.createServer();
const io = attachWsServer(dummyServer);
container.registerInstance(TOKENS.WsServer, io);

async function main() {
    logger.info("order-service worker starting");

    try {
        const result = await pingAll();
        for (const r of result) {
            if (r.ok) logger.info("shard reachable", { region: r.region, cluster: r.cluster });
            else logger.warn("shard unreachable", { region: r.region, cluster: r.cluster, error: r.error });
        }
    } catch (err) {
        logger.error("shard ping failed", { error: (err as Error).message });
    }

    const pendingPaymentSweepTimer = startPendingPaymentSweep();
    const paymentReconcilerTimer = startPaymentReconciler();
    const assignmentSweepTimer = startAssignmentSweep();
    const archivalWorkerTimer = startArchivalWorker();

    async function shutdown() {
        logger.info("worker shutdown requested");
        clearInterval(pendingPaymentSweepTimer);
        clearInterval(paymentReconcilerTimer);
        clearInterval(assignmentSweepTimer);
        clearInterval(archivalWorkerTimer);
        try {
            await io.close();
        } catch { }
        try {
            await destroyAll();
        } catch (err) {
            logger.warn("db destroy error", { error: (err as Error).message });
        }
        process.exit(0);
    }

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main();
