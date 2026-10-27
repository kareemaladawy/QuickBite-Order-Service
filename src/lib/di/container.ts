import "reflect-metadata";
import {container} from "tsyringe";
import {TOKENS} from "./tokens";
import {Logger} from "../logger/logger";
import {cacheProvider} from "../cache/init";
import {messageBroker} from "../messaging/init";
import {coreClient} from "../core-client/core-client";
import {registerRbacCoreEventHandlers} from "../auth/rbac.events";
import {PermissionCacheService} from "../auth/permission-cache.service";
import {RbacEventsController} from "../auth/rbac-events.controller";
import {OrderService} from "../../app/order/service/order.service";
import {OrderController} from "../../app/order/controller/order.controller";
import {OrderEventsController} from "../../app/order/controller/order-events.controller";
import {registerOrderCoreEventHandlers} from "../../app/order/order.events";

// Infrastructure
container.registerSingleton<Logger>(TOKENS.Logger, Logger);
container.registerInstance(TOKENS.CacheProvider, cacheProvider);
container.registerInstance(TOKENS.MessageBroker, messageBroker);
container.registerInstance(TOKENS.CoreClient, coreClient);
container.registerSingleton(TOKENS.PermissionCacheService, PermissionCacheService);
container.registerSingleton(TOKENS.RbacEventsController, RbacEventsController);
registerRbacCoreEventHandlers(container.resolve(TOKENS.RbacEventsController));

// Order module
container.registerSingleton(TOKENS.OrderService, OrderService);
container.registerSingleton(TOKENS.OrderController, OrderController);
container.registerSingleton(TOKENS.OrderEventsController, OrderEventsController);
registerOrderCoreEventHandlers(container.resolve(TOKENS.OrderEventsController));

export {container};
