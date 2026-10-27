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

export interface UpdateOrderStatusInput {
    status: OrderStatus;
    timestampColumn?: string; // whitelisted snake_case column, set by order-status.service.ts
    cancellationReason?: string;
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
