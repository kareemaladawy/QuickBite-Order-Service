export enum OrderStatus {
    PENDING_PAYMENT = "pending_payment",
    PLACED = "placed",
    ACCEPTED = "accepted",
    REJECTED = "rejected",
    PREPARING = "preparing",
    READY = "ready",
    ASSIGNED = "assigned",
    PICKED = "picked",
    DELIVERED = "delivered",
    CANCELLED = "cancelled",
}

export enum RestaurantStatus {
    ACTIVE = "active",
    PENDING = "pending",
    INACTIVE = "inactive",
    SUSPENDED = "suspended"
}

export enum PaymentMethod {
    ONLINE = "online",
    COD = "cod",
}

// Who is driving a status transition — assertTransition() checks this against the
// allowed-actors matrix in order-status.service.ts (docs/business-logic/orders.md §1).
export enum OrderActorType {
    CUSTOMER = "customer",
    RESTAURANT = "restaurant",
    ADMIN = "admin",
    AGENT = "agent",
    SYSTEM = "system",
}
