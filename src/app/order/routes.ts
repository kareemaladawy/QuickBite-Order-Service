import { Router } from "express";
import { authenticate } from "../../lib/auth/guard";
import { requireBranchAccess } from "../../lib/auth/rbac";
import { idempotency } from "../../lib/idempotency/idempotency";
import { withCache } from "../../lib/cache/withCache";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { OrderController } from "./controller/order.controller";
import { requireRegion } from "../../lib/sharding/region-resolver";

export const orderRouter = Router();

const orderController = container.resolve<OrderController>(TOKENS.OrderController);

orderRouter.post(
    "/orders",
    authenticate,
    requireRegion,
    idempotency({ strict: true }),
    orderController.placeOrder,
);

orderRouter.get("/orders/:orderId", authenticate, orderController.getOrder);

// No rbac() middleware here: this endpoint serves customer (cancel), restaurant
// (accept/reject/preparing/ready/cancel), and admin actors, and the real gatekeeping
// (which actor may move which status) is assertTransition() in order-status.service.ts.
// The generic rbac() placeholder only recognizes restaurant_user/system_admin and would
// incorrectly 403 a legitimate customer cancellation.
orderRouter.patch(
    "/orders/:orderId/status",
    authenticate,
    orderController.updateStatus,
);

orderRouter.get("/customer/orders", authenticate, orderController.listCustomerOrders);

// 10s TTL: the restaurant dashboard polls this list frequently per branch; a short cache
// absorbs that polling without serving noticeably stale data. Explicitly invalidated by
// OrderService on placeOrder() and updateStatus() for the affected branch — see
// invalidateRestaurantOrdersCache() in order.service.ts.
orderRouter.get(
    "/restaurant/orders/:branchId",
    authenticate,
    requireBranchAccess("branchId"),
    withCache(10, false),
    orderController.listRestaurantOrders,
);
