// Routing keys published to the `order.events` exchange. analytics-service's consumer
// binds against these exact strings — keep the two sides in sync when adding a new type.
export enum OrderEventType {
    ORDER_PLACED = "order.placed",
    ORDER_ACCEPTED = "order.accepted",
    ORDER_REJECTED = "order.rejected",
    ORDER_DELIVERED = "order.delivered",
    ORDER_CANCELLED = "order.cancelled",
    PAYMENT_COMPLETED = "payment.completed",
    PAYMENT_FAILED = "payment.failed",
}
