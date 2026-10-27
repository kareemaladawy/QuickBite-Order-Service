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
};
