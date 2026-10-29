import { Order } from "../entity/order.entity";
import { OrderItem } from "../entity/order-item.entity";
import { OrderStatus, PaymentMethod } from "../enums";
import { PaymentInitSummary } from "../types";

export class OrderItemResponseDTO {
    productId!: number;
    quantity!: number;
    unitPrice!: number;
    name!: string;
    imageUrl!: string | null;
    lineTotal!: number;

    static from(item: OrderItem): OrderItemResponseDTO {
        const dto = new OrderItemResponseDTO();
        dto.productId = item.productId;
        dto.quantity = item.quantity;
        dto.unitPrice = item.unitPriceSnapshot;
        dto.name = item.nameSnapshot;
        dto.imageUrl = item.imageUrlSnapshot;
        dto.lineTotal = item.lineTotal;
        return dto;
    }
}

// Full detail — GET /orders/{id} and the POST /orders response.
export class OrderResponseDTO {
    id!: string; // public_id
    status!: OrderStatus;
    branchId!: number;
    restaurantId!: number;
    paymentMethod!: PaymentMethod;
    subtotal!: number;
    deliveryFee!: number;
    serviceFee!: number;
    total!: number;
    currency!: string;
    deliveryAddressText!: string;
    deliveryAgentId!: number | null;
    cancellationReason!: string | null;
    createdAt!: string;
    updatedAt!: string;
    acceptedAt!: string | null;
    rejectedAt!: string | null;
    preparingAt!: string | null;
    readyAt!: string | null;
    assignedAt!: string | null;
    pickedAt!: string | null;
    deliveredAt!: string | null;
    cancelledAt!: string | null;
    items!: OrderItemResponseDTO[];
    // Only set for a freshly-placed online order awaiting payment — the redirect the
    // client needs to send the customer to (see docs/business-logic/payments.md §2).
    payment!: PaymentInitSummary | null;

    static from(order: Order, items: OrderItem[], paymentInit?: PaymentInitSummary): OrderResponseDTO {
        const dto = new OrderResponseDTO();
        dto.id = order.publicId;
        dto.status = order.status;
        dto.branchId = order.branchId;
        dto.restaurantId = order.restaurantId;
        dto.paymentMethod = order.paymentMethod;
        dto.subtotal = order.subtotal;
        dto.deliveryFee = order.deliveryFee;
        dto.serviceFee = order.serviceFee;
        dto.total = order.total;
        dto.currency = order.currency;
        dto.deliveryAddressText = order.deliveryAddressTextSnapshot;
        dto.deliveryAgentId = order.deliveryAgentId;
        dto.cancellationReason = order.cancellationReason;
        dto.createdAt = order.createdAt.toISOString();
        dto.updatedAt = order.updatedAt.toISOString();
        dto.acceptedAt = order.acceptedAt?.toISOString() ?? null;
        dto.rejectedAt = order.rejectedAt?.toISOString() ?? null;
        dto.preparingAt = order.preparingAt?.toISOString() ?? null;
        dto.readyAt = order.readyAt?.toISOString() ?? null;
        dto.assignedAt = order.assignedAt?.toISOString() ?? null;
        dto.pickedAt = order.pickedAt?.toISOString() ?? null;
        dto.deliveredAt = order.deliveredAt?.toISOString() ?? null;
        dto.cancelledAt = order.cancelledAt?.toISOString() ?? null;
        dto.items = items.map(OrderItemResponseDTO.from);
        dto.payment = paymentInit ?? null;
        return dto;
    }
}

// Lighter shape for list views (GET /customer/orders, GET /restaurant/orders) and the
// `order.created` WS payload — no item expansion, one row per order.
export class OrderSummaryResponseDTO {
    id!: string;
    status!: OrderStatus;
    branchId!: number;
    total!: number;
    currency!: string;
    paymentMethod!: PaymentMethod;
    createdAt!: string;

    static from(order: Order): OrderSummaryResponseDTO {
        const dto = new OrderSummaryResponseDTO();
        dto.id = order.publicId;
        dto.status = order.status;
        dto.branchId = order.branchId;
        dto.total = order.total;
        dto.currency = order.currency;
        dto.paymentMethod = order.paymentMethod;
        dto.createdAt = order.createdAt.toISOString();
        return dto;
    }
}

// PATCH /orders/{id}/status response + the `order.status_changed` WS payload shape.
export class OrderStatusResponseDTO {
    id!: string;
    status!: OrderStatus;
    ts!: string;

    static from(order: Order): OrderStatusResponseDTO {
        const dto = new OrderStatusResponseDTO();
        dto.id = order.publicId;
        dto.status = order.status;
        dto.ts = order.updatedAt.toISOString();
        return dto;
    }
}
