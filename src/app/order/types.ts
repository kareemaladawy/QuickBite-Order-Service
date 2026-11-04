import { OrderActorType, OrderStatus } from "./enums";
import { Order } from "./entity/order.entity";
import { OrderItem } from "./entity/order-item.entity";

// Context assertTransition() needs to decide whether a transition is legal — not an
// entity, not a DTO; shared between the controller (which derives it from req.user)
// and order-status.service.ts.
export interface OrderActorContext {
    type: OrderActorType;
    orderCreatedAt: Date;
    acceptedAt: Date | null;
}

export interface CreateOrderItemInput {
    productId: number;
    quantity: number;
}

export interface PlaceOrderResult {
    order: Order;
    items: OrderItem[];
    // Set only when paymentMethod is 'online' — the payment module is invoked inline
    // from placeOrder() per product decision (no separate "first init" call; see
    // PaymentService.initForOrder in app/payment).
    paymentInit?: PaymentInitSummary;
}

export interface PaymentInitSummary {
    redirectUrl: string;
    sessionId: string;
    expiresAt: string;
}

// The composite PK of the partitioned `orders` table — for callers (e.g. the payment
// reconciler) that only hold this pair via another table's denormalized order
// reference, not the public_id normal callers use.
export interface OrderCompositeId {
    id: number;
    createdAt: Date;
}

export interface GetOrderResult {
    order: Order;
    items: OrderItem[];
}

export interface OffendingOrderItem {
    productId: number;
    reason: "not_found" | "unavailable" | "insufficient_stock";
}

export interface CreateOrderRow {
    region: string;
    publicId: string;
    countryCode: string;
    restaurantId: number;
    branchId: number;
    customerId: number;
    customerAddressId: number;
    deliveryLat: number;
    deliveryLng: number;
    deliveryAddressTextSnapshot: string;
    pickupLat: number;
    pickupLng: number;
    pickupAddressTextSnapshot: string;
    branchNameSnapshot: string;
    status: OrderStatus;
    subtotal: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
    currency: string;
    paymentMethod: string;
}

export interface FindOrdersByBranchFilters {
    status?: OrderStatus;
    from?: Date;
    to?: Date;
}

// GET /customer/orders?year=YYYY (docs/api-contracts.md §1.3) — bounds the query to a
// single calendar year so the service can decide, from `year` alone, whether to read
// the hot cluster or the archive cluster (Phase 5).
export interface FindOrdersByCustomerFilters {
    year: number;
}

export interface UpdateOrderStatusInput {
    status: OrderStatus;
    timestampColumn?: string; // whitelisted snake_case column, set by order-status.service.ts
    cancellationReason?: string;
    // Set only on the assigned->picked->delivered agent path, for the 'delivered'
    // transition — the platform commission computed by the Restaurant Finance module
    // (finance.service.recordDeliverySettlement), persisted in the same UPDATE as the
    // status flip rather than a second write.
    commission?: number;
}

export interface FindOrdersByAgentFilters {
    status?: OrderStatus;
}

export interface CreateOrderItemRow {
    region: string;
    orderId: number;
    orderCreatedAt: Date;
    productId: number;
    quantity: number;
    unitPriceSnapshot: number;
    nameSnapshot: string;
    imageUrlSnapshot: string | null;
    lineTotal: number;
}

export interface ProductStockChangedPayload {
    productId: number;
    branchId: number;
    stock: number;
    isAvailable: boolean;
}

export interface ProductPriceChangedPayload {
    productId: number;
    branchId: number;
    price: number;
}

export interface BranchChangedPayload {
    branchId: number;
}

export interface RestaurantSuspendedPayload {
    restaurantId: number;
}

// Rich outbox payload for analytics-service (see outbox-events.ts) — a flattened
// snapshot of the order at the moment of the event, not a public response DTO.
export interface OrderOutboxItemPayload {
    productId: number;
    nameSnapshot: string;
    quantity: number;
    unitPriceSnapshot: number;
    lineTotal: number;
}

export interface OrderOutboxPayload {
    id: number;
    publicId: string;
    region: string;
    countryCode: string;
    restaurantId: number;
    branchId: number;
    customerId: number;
    deliveryAgentId: number | null;
    status: OrderStatus;
    subtotal: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
    commission: number;
    currency: string;
    paymentMethod: string;
    cancellationReason: string | null;
    createdAt: string;
    updatedAt: string;
    acceptedAt: string | null;
    rejectedAt: string | null;
    readyAt: string | null;
    assignedAt: string | null;
    pickedAt: string | null;
    deliveredAt: string | null;
    cancelledAt: string | null;
}

// Leaner, dedicated payload for order.placed — fired once, at submission, before the
// order has any of the fields above (accepted/rejected/delivered/etc.).
export interface OrderPlacedOutboxPayload {
    orderId: number;
    region: string;
    countryCode: string;
    restaurantId: number;
    branchId: number;
    customerId: number;
    status: OrderStatus;
    paymentMethod: string;
    subtotal: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
    currency: string;
    items: OrderOutboxItemPayload[];
    placedAt: string;
}
