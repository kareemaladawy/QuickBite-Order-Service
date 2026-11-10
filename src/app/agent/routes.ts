import { NextFunction, Request, Response, Router } from "express";
import { authenticate } from "../../lib/auth/guard";
import { rbac } from "../../lib/auth/rbac";
import { SystemRole } from "../../lib/auth/types";
import { idempotency } from "../../lib/idempotency/idempotency";
import { withCache } from "../../lib/cache/withCache";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { requireRegion } from "../../lib/sharding/region-resolver";
import { PresenceController } from "./controller/presence.controller";
import { DeliveryController } from "./controller/delivery.controller";

export const agentRouter = Router();

const presenceController = container.resolve<PresenceController>(TOKENS.PresenceController);
const deliveryController = container.resolve<DeliveryController>(TOKENS.DeliveryController);

// Agents are not RBAC-permissioned for their own endpoints (agents.md §13) — just a
// role gate; ownership (which order/offer a given agent may act on) is a service-layer
// check, same pattern as elsewhere in this service.
function requireAgentRole(req: Request, res: Response, next: NextFunction) {
    if (req.user?.role !== SystemRole.DELIVERY_AGENT) {
        return res.status(403).json({ error: "delivery_agent role required" });
    }
    next();
}

agentRouter.post(
    "/agents/presence/online",
    authenticate,
    requireRegion,
    requireAgentRole,
    presenceController.online,
);

agentRouter.post(
    "/agents/presence/offline",
    authenticate,
    requireRegion,
    requireAgentRole,
    presenceController.offline,
);

agentRouter.post(
    "/agents/presence/ping",
    authenticate,
    requireRegion,
    requireAgentRole,
    presenceController.ping,
);

agentRouter.get(
    "/agents/tasks",
    authenticate,
    requireRegion,
    requireAgentRole,
    withCache(5, true),
    deliveryController.listTasks,
);

agentRouter.get(
    "/agents/earnings",
    authenticate,
    requireRegion,
    requireAgentRole,
    deliveryController.getEarnings,
);

// Manual admin override only (agentId required — see delivery.service.ts's `assign`).
// The broadcast fast path (order.status -> 'ready') and the sweep worker call
// AssignmentService directly, in-process — they never go through this HTTP route.
agentRouter.post(
    "/orders/:orderId/delivery/assign",
    authenticate,
    requireRegion,
    idempotency({ strict: true }),
    rbac({ resource: "deliveries", action: "assign" }),
    deliveryController.assign,
);

agentRouter.post(
    "/orders/:orderId/delivery/reassign",
    authenticate,
    requireRegion,
    rbac({ resource: "deliveries", action: "assign" }),
    deliveryController.reassign,
);

// Ownership (must hold a live offer) is checked in AssignmentService, not here —
// agents.md §13.
agentRouter.post(
    "/orders/:orderId/delivery/accept",
    authenticate,
    requireRegion,
    requireAgentRole,
    deliveryController.accept,
);

agentRouter.post(
    "/orders/:orderId/delivery/decline",
    authenticate,
    requireRegion,
    requireAgentRole,
    deliveryController.decline,
);

// Ownership (must be orders.delivery_agent_id) is checked in DeliveryService, not here.
agentRouter.patch(
    "/orders/:orderId/delivery/status",
    authenticate,
    requireRegion,
    requireAgentRole,
    deliveryController.updateStatus,
);
