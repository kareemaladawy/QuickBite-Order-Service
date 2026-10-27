import { registerHandler } from "../../lib/core-events/consumer";
import { OrderEventsController } from "./controller/order-events.controller";

// Registers this module's inbound core-event handlers. Called once at DI container
// bootstrap, with the controller already resolved by container.ts (so this file never
// has to reach into the DI container) — see docs/implementation-plan.md Phase 1 item 12.
export function registerOrderCoreEventHandlers(controller: OrderEventsController): void {
    registerHandler("product.stock.changed", controller.onProductStockChanged);
    registerHandler("product.price.changed", controller.onProductPriceChanged);
    registerHandler("branch.updated", controller.onBranchUpdated);
    registerHandler("branch.deactivated", controller.onBranchDeactivated);
    registerHandler("restaurant.suspended", controller.onRestaurantSuspended);
}
