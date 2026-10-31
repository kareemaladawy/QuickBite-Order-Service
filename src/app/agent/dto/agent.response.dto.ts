import { Order } from "../../order/entity/order.entity";
import { OrderStatus, PaymentMethod } from "../../order/enums";
import { AgentEarning } from "../entity/agent-earning.entity";
import { env } from "../../../lib/config/env";

export class DeliveryTaskResponseDTO {
    orderPublicId!: string;
    status!: OrderStatus;
    pickup!: { branchName: string; lat: number; lng: number; addressText: string };
    dropoff!: { lat: number; lng: number; addressText: string };
    itemsCount!: number;
    total!: number;
    currency!: string;
    paymentMethod!: PaymentMethod;
    earningEstimate?: number;
    assignedAt!: string | null;

    static from(order: Order, itemsCount: number): DeliveryTaskResponseDTO {
        const dto = new DeliveryTaskResponseDTO();
        dto.orderPublicId = order.publicId;
        dto.status = order.status;
        dto.pickup = {
            branchName: order.branchNameSnapshot,
            lat: order.pickupLat,
            lng: order.pickupLng,
            addressText: order.pickupAddressTextSnapshot,
        };
        dto.dropoff = {
            lat: order.deliveryLat,
            lng: order.deliveryLng,
            addressText: order.deliveryAddressTextSnapshot,
        };
        dto.itemsCount = itemsCount;
        dto.total = order.total;
        dto.currency = order.currency;
        dto.paymentMethod = order.paymentMethod;
        if (order.status !== OrderStatus.DELIVERED && order.status !== OrderStatus.CANCELLED) {
            dto.earningEstimate = Math.floor((order.deliveryFee * env.agents.earningsSharePct) / 100);
        }
        dto.assignedAt = order.assignedAt ? order.assignedAt.toISOString() : null;
        return dto;
    }
}

export class DeliveryStatusResponseDTO {
    orderPublicId!: string;
    status!: OrderStatus;
    updatedAt!: string;

    static from(order: Order): DeliveryStatusResponseDTO {
        const dto = new DeliveryStatusResponseDTO();
        dto.orderPublicId = order.publicId;
        dto.status = order.status;
        dto.updatedAt = order.updatedAt.toISOString();
        return dto;
    }
}

export class EarningItemResponseDTO {
    orderPublicId!: string;
    amount!: number;
    currency!: string;
    earnedAt!: string;
}

export class AgentEarningsResponseDTO {
    range!: { from: string; to: string };
    totals!: { count: number; sum: number; currency: string };
    items!: EarningItemResponseDTO[];
    nextCursor!: string | null;

    static from(
        range: { from: Date; to: Date },
        totals: { count: number; sum: number },
        currency: string,
        earnings: AgentEarning[],
        orderPublicIdById: Map<number, string>,
        nextCursor: string | null,
    ): AgentEarningsResponseDTO {
        const dto = new AgentEarningsResponseDTO();
        dto.range = { from: range.from.toISOString(), to: range.to.toISOString() };
        dto.totals = { count: totals.count, sum: totals.sum, currency };
        dto.items = earnings.map((e) => ({
            orderPublicId: orderPublicIdById.get(e.orderId) ?? "",
            amount: e.amount,
            currency: e.currency,
            earnedAt: e.earnedAt.toISOString(),
        }));
        dto.nextCursor = nextCursor;
        return dto;
    }
}
