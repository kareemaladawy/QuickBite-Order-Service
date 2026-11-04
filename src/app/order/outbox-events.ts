import { insertOutboxEvent } from "../../lib/events/outbox.repo";
import { OrderEventType } from "../../lib/events/event-types";
import { Order } from "./entity/order.entity";
import { OrderItem } from "./entity/order-item.entity";
import { OrderStatus } from "./enums";
import { OrderOutboxPayload, OrderPlacedOutboxPayload } from "./types";
import type { Knex } from "knex";

// Which restaurant/customer/admin-driven status transitions get an outbound event,
// and under what event_type — analytics-service's requested lifecycle events.
export const ORDER_STATUS_OUTBOX_EVENT_TYPE: Partial<Record<OrderStatus, OrderEventType>> = {
    [OrderStatus.ACCEPTED]: OrderEventType.ORDER_ACCEPTED,
    [OrderStatus.REJECTED]: OrderEventType.ORDER_REJECTED,
    [OrderStatus.CANCELLED]: OrderEventType.ORDER_CANCELLED,
};

export function buildOrderOutboxPayload(order: Order): OrderOutboxPayload {
    return {
        id: order.id,
        publicId: order.publicId,
        region: order.region,
        countryCode: order.countryCode,
        restaurantId: order.restaurantId,
        branchId: order.branchId,
        customerId: order.customerId,
        deliveryAgentId: order.deliveryAgentId,
        status: order.status,
        subtotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        serviceFee: order.serviceFee,
        total: order.total,
        commission: order.commission,
        currency: order.currency,
        paymentMethod: order.paymentMethod,
        cancellationReason: order.cancellationReason,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
        acceptedAt: order.acceptedAt?.toISOString() ?? null,
        rejectedAt: order.rejectedAt?.toISOString() ?? null,
        readyAt: order.readyAt?.toISOString() ?? null,
        assignedAt: order.assignedAt?.toISOString() ?? null,
        pickedAt: order.pickedAt?.toISOString() ?? null,
        deliveredAt: order.deliveredAt?.toISOString() ?? null,
        cancelledAt: order.cancelledAt?.toISOString() ?? null,
    };
}

export async function insertOrderOutboxEvent(order: Order, eventType: OrderEventType, conn: Knex): Promise<void> {
    await insertOutboxEvent(conn, {
        aggregateType: "order",
        aggregateId: order.publicId,
        eventType,
        payload: buildOrderOutboxPayload(order),
    });
}

// Leaner, dedicated shape for order.placed — fired once, at submission, from inside
// placeOrder's own trx, for every order regardless of payment method. Deliberately
// not buildOrderOutboxPayload: at this point the order has none of the
// accepted/rejected/delivered/etc. fields yet, and an online order is still
// `pending_payment` (payment.completed/payment.failed are the signal for that).
export function buildOrderPlacedOutboxPayload(order: Order, items: OrderItem[]): OrderPlacedOutboxPayload {
    return {
        orderId: order.id,
        region: order.region,
        countryCode: order.countryCode,
        restaurantId: order.restaurantId,
        branchId: order.branchId,
        customerId: order.customerId,
        status: order.status,
        paymentMethod: order.paymentMethod,
        subtotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        serviceFee: order.serviceFee,
        total: order.total,
        currency: order.currency,
        items: items.map((item) => ({
            productId: item.productId,
            nameSnapshot: item.nameSnapshot,
            quantity: item.quantity,
            unitPriceSnapshot: item.unitPriceSnapshot,
            lineTotal: item.lineTotal,
        })),
        placedAt: order.createdAt.toISOString(),
    };
}

export async function insertOrderPlacedOutboxEvent(order: Order, items: OrderItem[], conn: Knex): Promise<void> {
    await insertOutboxEvent(conn, {
        aggregateType: "order",
        aggregateId: order.publicId,
        eventType: OrderEventType.ORDER_PLACED,
        payload: buildOrderPlacedOutboxPayload(order, items),
    });
}
