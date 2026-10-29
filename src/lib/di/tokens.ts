export const TOKENS = {
    // infra
    Logger: Symbol.for("Logger"),
    CacheProvider: Symbol.for("CacheProvider"),
    MessageBroker: Symbol.for("MessageBroker"),
    CoreClient: Symbol.for("CoreClient"),
    WsServer: Symbol.for("WsServer"),
    PermissionCacheService: Symbol.for("PermissionCacheService"),
    RbacEventsController: Symbol.for("RbacEventsController"),

    // order module
    OrderService: Symbol.for("OrderService"),
    OrderController: Symbol.for("OrderController"),
    OrderEventsController: Symbol.for("OrderEventsController"),

    // payment module
    PaymentProviderRegistry: Symbol.for("PaymentProviderRegistry"),
    PaymentService: Symbol.for("PaymentService"),
    PaymentController: Symbol.for("PaymentController"),
    PaymentWebhookService: Symbol.for("PaymentWebhookService"),
    WebhookController: Symbol.for("WebhookController"),
};
