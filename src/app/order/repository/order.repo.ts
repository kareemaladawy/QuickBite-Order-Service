import { Knex } from "knex";
import { Order } from "../entity/order.entity";
import { OrderStatus } from "../enums";
import { applyCursorPagination } from "../../../lib/http/pagination/cursor-pagination";
import { PaginationParams } from "../../../lib/http/pagination/types";
import { CreateOrderRow, FindOrdersByBranchFilters, UpdateOrderStatusInput } from "../types";

const ORDER_COLUMNS = [
    "id",
    "region",
    "public_id",
    "country_code",
    "restaurant_id",
    "branch_id",
    "customer_id",
    "customer_address_id",
    "delivery_lat",
    "delivery_lng",
    "delivery_address_text_snapshot",
    "status",
    "subtotal",
    "delivery_fee",
    "service_fee",
    "total",
    "commission",
    "currency",
    "payment_method",
    "delivery_agent_id",
    "cancellation_reason",
    "created_at",
    "updated_at",
    "accepted_at",
    "rejected_at",
    "preparing_at",
    "ready_at",
    "assigned_at",
    "picked_at",
    "delivered_at",
    "cancelled_at",
];

// bigint columns (id, *_id) come back from node-pg as strings to avoid precision loss
// above 2^53; Number() is safe here since these ids are well under that range.
function toEntity(row: any): Order {
    return new Order({
        id: Number(row.id),
        region: row.region,
        publicId: row.public_id,
        countryCode: row.country_code,
        restaurantId: Number(row.restaurant_id),
        branchId: Number(row.branch_id),
        customerId: Number(row.customer_id),
        customerAddressId: Number(row.customer_address_id),
        deliveryLat: Number(row.delivery_lat),
        deliveryLng: Number(row.delivery_lng),
        deliveryAddressTextSnapshot: row.delivery_address_text_snapshot,
        status: row.status,
        subtotal: row.subtotal,
        deliveryFee: row.delivery_fee,
        serviceFee: row.service_fee,
        total: row.total,
        commission: row.commission,
        currency: row.currency,
        paymentMethod: row.payment_method,
        deliveryAgentId: row.delivery_agent_id === null ? null : Number(row.delivery_agent_id),
        cancellationReason: row.cancellation_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        acceptedAt: row.accepted_at,
        rejectedAt: row.rejected_at,
        preparingAt: row.preparing_at,
        readyAt: row.ready_at,
        assignedAt: row.assigned_at,
        pickedAt: row.picked_at,
        deliveredAt: row.delivered_at,
        cancelledAt: row.cancelled_at,
    });
}

export async function createOrder(data: CreateOrderRow, conn: Knex): Promise<Order> {
    const now = new Date();
    const [row] = await conn("orders")
        .insert({
            region: data.region,
            public_id: data.publicId,
            country_code: data.countryCode,
            restaurant_id: data.restaurantId,
            branch_id: data.branchId,
            customer_id: data.customerId,
            customer_address_id: data.customerAddressId,
            delivery_lat: data.deliveryLat,
            delivery_lng: data.deliveryLng,
            delivery_address_text_snapshot: data.deliveryAddressTextSnapshot,
            status: data.status,
            subtotal: data.subtotal,
            delivery_fee: data.deliveryFee,
            service_fee: data.serviceFee,
            total: data.total,
            currency: data.currency,
            payment_method: data.paymentMethod,
            created_at: now,
            updated_at: now,
        })
        .returning(ORDER_COLUMNS);

    return toEntity(row);
}

export async function findOrderByPublicId(publicId: string, conn: Knex): Promise<Order | undefined> {
    const row = await conn("orders").where("public_id", publicId).select(ORDER_COLUMNS).first();
    return row ? toEntity(row) : undefined;
}

export async function findOrdersByCustomer(
    customerId: number,
    pagination: PaginationParams,
    conn: Knex,
): Promise<Order[]> {
    let query = conn("orders").where("customer_id", customerId).select(ORDER_COLUMNS);
    query = applyCursorPagination(query, pagination);
    const rows = await query;
    return rows.map(toEntity);
}

export async function findOrdersByBranch(
    branchId: number,
    filters: FindOrdersByBranchFilters,
    pagination: PaginationParams,
    conn: Knex,
): Promise<Order[]> {
    let query = conn("orders").where("branch_id", branchId).select(ORDER_COLUMNS);
    if (filters.status) query = query.where("status", filters.status);
    if (filters.from) query = query.where("created_at", ">=", filters.from);
    if (filters.to) query = query.where("created_at", "<=", filters.to);
    query = applyCursorPagination(query, pagination);
    const rows = await query;
    return rows.map(toEntity);
}

export async function updateOrderStatus(
    orderId: number,
    orderCreatedAt: Date,
    data: UpdateOrderStatusInput,
    conn: Knex,
): Promise<Order> {
    const patch: Record<string, unknown> = {
        status: data.status,
        updated_at: new Date(),
    };
    if (data.timestampColumn) patch[data.timestampColumn] = new Date();
    if (data.cancellationReason !== undefined) patch.cancellation_reason = data.cancellationReason;

    // created_at is part of the PK (partitioned table) — included so the planner can
    // prune to a single partition instead of scanning every one.
    const [row] = await conn("orders")
        .where("id", orderId)
        .where("created_at", orderCreatedAt)
        .update(patch)
        .returning(ORDER_COLUMNS);

    return toEntity(row);
}

// Forward scaffolding for the Phase 3 assignment service — not wired to any route yet.
export async function setDeliveryAgent(
    orderId: number,
    orderCreatedAt: Date,
    agentId: number,
    conn: Knex,
): Promise<void> {
    await conn("orders")
        .where("id", orderId)
        .where("created_at", orderCreatedAt)
        .update({
            delivery_agent_id: agentId,
            status: OrderStatus.ASSIGNED,
            assigned_at: new Date(),
            updated_at: new Date(),
        });
}
