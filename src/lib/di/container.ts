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
import {paymentProviderRegistry} from "../payments/init";
import {PaymentService} from "../../app/payment/service/payment.service";
import {PaymentWebhookService} from "../../app/payment/service/payment-webhook.service";
import {PaymentController} from "../../app/payment/controller/payment.controller";
import {WebhookController} from "../../app/payment/controller/webhook.controller";

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

// Payment module
container.registerInstance(TOKENS.PaymentProviderRegistry, paymentProviderRegistry);
container.registerSingleton(TOKENS.PaymentService, PaymentService);
container.registerSingleton(TOKENS.PaymentWebhookService, PaymentWebhookService);
container.registerSingleton(TOKENS.PaymentController, PaymentController);
container.registerSingleton(TOKENS.WebhookController, WebhookController);

export {container};
