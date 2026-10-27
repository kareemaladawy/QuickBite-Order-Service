import { registerHandler } from "../core-events/consumer";
import { RbacEventsController } from "./rbac-events.controller";

// Registers this lib's inbound core-event handlers. Called once at DI container
// bootstrap, alongside the per-module registrations, with the controller already
// resolved by container.ts (so this file never has to reach into the DI container).
export function registerRbacCoreEventHandlers(controller: RbacEventsController): void {
    registerHandler("rbac.permissions_changed", controller.onPermissionsChanged);
}
