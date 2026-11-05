import { Router } from "express";
import { authenticate } from "../../lib/auth/guard";
import { requireBranchAccess, requireRestaurantMember } from "../../lib/auth/rbac";
import { idempotency } from "../../lib/idempotency/idempotency";
import { withCache } from "../../lib/cache/withCache";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { OrderController } from "./controller/order.controller";
import { requireConcreteRegion, requireRegion } from "../../lib/sharding/region-resolver";

export const orderRouter = Router();

const orderController = container.resolve<OrderController>(TOKENS.OrderController);

orderRouter.post(
    "/orders",
    authenticate,
    requireRegion,
    idempotency({ strict: true }),
    orderController.placeOrder,
);

// Customer (own) + system_admin only. No restaurant/branch param here — ownership can
// only be confirmed once the order is loaded (see OrderService.getOrder). Restaurant
// actors use the branch-scoped route below instead.
orderRouter.get(
    "/orders/:orderId",
    authenticate,
    requireConcreteRegion,
    orderController.getOrder,
);

// Restaurant actors (restaurant_user + system_admin) only. requireRestaurantMember and
// requireBranchAccess 403 before the handler runs if the caller isn't system_admin or a
// member of this branch — ownership is enforced by middleware via the route params, not
// inside the service.
orderRouter.get(
    "/restaurants/:restaurantId/branches/:branchId/orders/:orderId",
    authenticate,
    requireConcreteRegion,
    requireRestaurantMember("restaurantId"),
    requireBranchAccess("branchId"),
    orderController.getRestaurantOrder,
);

// Customer self-cancel + system_admin only. No restaurant/branch param here — there's
// nothing to check against until the order is loaded (see OrderService.updateStatus).
// Restaurant actors (accept/reject/preparing/ready/cancel) use the branch-scoped route
// below instead. No rbac() middleware: the real gatekeeping on which actor may move
// which status is assertTransition() in order-status.service.ts.
orderRouter.patch(
    "/orders/:orderId/status",
    authenticate,
    requireConcreteRegion,
    orderController.updateStatus,
);

// Restaurant actors (restaurant_user + system_admin) only. requireRestaurantMember and
// requireBranchAccess 403 before the handler runs if the caller isn't system_admin or a
// member of this branch — ownership is enforced by middleware via the route params, not
// inside the service. No rbac() placeholder here either, for the same reason as above:
// which target status a restaurant_user may set is still assertTransition()'s call.
orderRouter.patch(
    "/restaurants/:restaurantId/branches/:branchId/orders/:orderId/status",
    authenticate,
    requireConcreteRegion,
    requireRestaurantMember("restaurantId"),
    requireBranchAccess("branchId"),
    orderController.updateRestaurantOrderStatus,
);

orderRouter.get(
    "/customer/orders",
    authenticate,
    requireConcreteRegion,
    orderController.listCustomerOrders,
);

// 10s TTL: the restaurant dashboard polls this list frequently per branch; a short cache
// absorbs that polling without serving noticeably stale data. Explicitly invalidated by
// OrderService on placeOrder() and updateStatus() for the affected branch — see
// invalidateRestaurantOrdersCache() in order.service.ts.
orderRouter.get(
    "/restaurants/:restaurantId/branches/:branchId/orders",
    authenticate,
    requireConcreteRegion,
    requireRestaurantMember("restaurantId"),
    requireBranchAccess("branchId"),
    withCache(10, false),
    orderController.listBranchOrders,
);
