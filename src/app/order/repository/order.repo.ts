import { Knex } from "knex";
import { Order } from "../entity/order.entity";
import { OrderStatus } from "../enums";
import { applyCursorPagination } from "../../../lib/http/pagination/cursor-pagination";
import { PaginationParams } from "../../../lib/http/pagination/types";
import {
    CreateOrderRow,
    FindOrdersByBranchFilters,
    FindOrdersByCustomerFilters,
    OrderCompositeId,
    UpdateOrderStatusInput,
} from "../types";

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
    "pickup_lat",
    "pickup_lng",
    "pickup_address_text_snapshot",
    "branch_name_snapshot",
    "status",
    "subtotal",
    "delivery_fee",
    "service_fee",
    "total",
    "commission",
    "currency",
    "payment_method",
    "delivery_agent_id",
    "reassignment_attempts",
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
        pickupLat: Number(row.pickup_lat),
        pickupLng: Number(row.pickup_lng),
        pickupAddressTextSnapshot: row.pickup_address_text_snapshot,
        branchNameSnapshot: row.branch_name_snapshot,
        status: row.status,
        subtotal: row.subtotal,
        deliveryFee: row.delivery_fee,
        serviceFee: row.service_fee,
        total: row.total,
        commission: row.commission,
        currency: row.currency,
        paymentMethod: row.payment_method,
        deliveryAgentId: row.delivery_agent_id === null ? null : Number(row.delivery_agent_id),
        reassignmentAttempts: row.reassignment_attempts,
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
            pickup_lat: data.pickupLat,
            pickup_lng: data.pickupLng,
            pickup_address_text_snapshot: data.pickupAddressTextSnapshot,
            branch_name_snapshot: data.branchNameSnapshot,
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

// Composite lookup by the partitioned PK — used where the caller only has the
// internal id + denormalized created_at (e.g. a transactions row), not the public_id.
export async function findOrderById(id: number, createdAt: Date, conn: Knex): Promise<Order | undefined> {
    const row = await conn("orders").where("id", id).where("created_at", createdAt).select(ORDER_COLUMNS).first();
    return row ? toEntity(row) : undefined;
}

// supports the pending-payment sweep job (lib/jobs/pending-payment-sweep.ts) —
// idx_orders_pending_payment_created_at. Bounded by `limit` so one sweep tick can't
// run unboundedly long even if a backlog builds up. Excludes an order that already has
// a succeeded charge/cod_collection: that order isn't abandoned, it's just stuck mid
// place-order because the post-charge `pending_payment -> placed` transition failed or
// never ran (see payment-webhook.service.ts's handleCapture comment). The payment
// reconciler job (lib/jobs/payment-reconciler.ts) is what retries that transition —
// this sweep must never cancel an order that was already paid for.
export async function findStalePendingPaymentOrders(cutoff: Date, conn: Knex, limit = 100): Promise<Order[]> {
    const rows = await conn("orders")
        .where("orders.status", OrderStatus.PENDING_PAYMENT)
        .where("orders.created_at", "<", cutoff)
        .whereNotExists(
            conn("treasury_ledger")
                .select(1)
                .whereRaw("treasury_ledger.order_id = orders.id")
                .whereIn("treasury_ledger.entry_type", ["charge", "cod_collection"])
                .where("treasury_ledger.status", "succeeded"),
        )
        .orderBy("orders.created_at", "asc")
        .limit(limit)
        .select(ORDER_COLUMNS);
    return rows.map(toEntity);
}

// Batch composite-PK lookup (CLAUDE.md §7 — no N+1) for callers that only hold
// (id, createdAt) pairs from another table's denormalized order reference — e.g. the
// payment reconciler correlating a succeeded charge back to its order.
export async function findOrdersByIds(pairs: OrderCompositeId[], conn: Knex): Promise<Order[]> {
    if (pairs.length === 0) return [];
    const rows = await conn("orders")
        .whereIn(
            ["id", "created_at"],
            pairs.map((p) => [p.id, p.createdAt]),
        )
        .select(ORDER_COLUMNS);
    return rows.map(toEntity);
}

export async function findOrdersByCustomer(
    customerId: number,
    filters: FindOrdersByCustomerFilters,
    pagination: PaginationParams,
    conn: Knex,
): Promise<Order[]> {
    const yearStart = new Date(Date.UTC(filters.year, 0, 1));
    const yearEnd = new Date(Date.UTC(filters.year + 1, 0, 1));
    let query = conn("orders")
        .where("customer_id", customerId)
        .where("created_at", ">=", yearStart)
        .where("created_at", "<", yearEnd)
        .select(ORDER_COLUMNS);
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
    if (data.commission !== undefined) patch.commission = data.commission;

    // created_at is part of the PK (partitioned table) — included so the planner can
    // prune to a single partition instead of scanning every one.
    const [row] = await conn("orders")
        .where("id", orderId)
        .where("created_at", orderCreatedAt)
        .update(patch)
        .returning(ORDER_COLUMNS);

    return toEntity(row);
}

// Compensating delete for an order whose online payment session never got created
// (placeOrder's payment-init failure path) — the order was never returned to the
// client, so nothing observed it existing. order_items cascades via its FK (see
// 20260418000030_create_order_items.ts), so this alone is enough.
export async function deleteOrder(orderId: number, orderCreatedAt: Date, conn: Knex): Promise<void> {
    await conn("orders").where("id", orderId).where("created_at", orderCreatedAt).del();
}

// Called only via OrderService.assignAgent (CLAUDE.md §3 — the Agents module never
// reaches into this repo directly) — commits a winning broadcast-accept or a manual
// admin assign. `orders.delivery_agent_id` is set here and nowhere else in this file.
export async function setDeliveryAgent(
    orderId: number,
    orderCreatedAt: Date,
    agentId: number,
    conn: Knex,
): Promise<Order> {
    const [row] = await conn("orders")
        .where("id", orderId)
        .where("created_at", orderCreatedAt)
        .update({
            delivery_agent_id: agentId,
            status: OrderStatus.ASSIGNED,
            assigned_at: new Date(),
            updated_at: new Date(),
        })
        .returning(ORDER_COLUMNS);
    return toEntity(row);
}

// Cancellation-while-assigned (agents.md §8) clears the committed agent so the order no
// longer counts against anyone's presence:load.
export async function clearDeliveryAgent(orderId: number, orderCreatedAt: Date, conn: Knex): Promise<Order> {
    const [row] = await conn("orders")
        .where("id", orderId)
        .where("created_at", orderCreatedAt)
        .update({ delivery_agent_id: null, updated_at: new Date() })
        .returning(ORDER_COLUMNS);
    return toEntity(row);
}

// Only ever incremented by a reassignment (admin-triggered or the sweep worker) —
// accept/decline/expiry never touch this counter (agents.md §4, §9).
export async function incrementReassignmentAttempts(orderId: number, orderCreatedAt: Date, conn: Knex): Promise<Order> {
    const [row] = await conn("orders")
        .where("id", orderId)
        .where("created_at", orderCreatedAt)
        .update({ reassignment_attempts: conn.raw("reassignment_attempts + 1"), updated_at: new Date() })
        .returning(ORDER_COLUMNS);
    return toEntity(row);
}

// Backs the assignment-sweep worker's per-region scan (idx_orders_status_created_at) —
// a small, transient slice of the hot table (agents.md §14).
export async function findReadyOrders(conn: Knex, limit = 100): Promise<Order[]> {
    const rows = await conn("orders").where("status", OrderStatus.READY).limit(limit).select(ORDER_COLUMNS);
    return rows.map(toEntity);
}

// Backs GET /agents/tasks?status= (idx_orders_delivery_agent_id_status).
export async function findOrdersByAgent(
    agentId: number,
    filters: { status?: OrderStatus },
    pagination: PaginationParams,
    conn: Knex,
): Promise<Order[]> {
    let query = conn("orders").where("delivery_agent_id", agentId).select(ORDER_COLUMNS);
    if (filters.status) query = query.where("status", filters.status);
    query = applyCursorPagination(query, pagination);
    return (await query).map(toEntity);
}

// Any order currently committed to this agent that isn't yet delivered — used by
// PresenceService.goOffline's 409 AgentInActiveDelivery check (agents.md §1).
export async function countActiveOrdersForAgent(agentId: number, conn: Knex): Promise<number> {
    const row = await conn("orders")
        .where("delivery_agent_id", agentId)
        .whereIn("status", [OrderStatus.ASSIGNED, OrderStatus.PICKED])
        .count<{ count: string }[]>({ count: "*" })
        .first();
    return Number(row?.count ?? 0);
}

// Bounded by AGENT_MAX_CONCURRENT_ORDERS — used to fan out a ping's lat/lng to every
// order this agent is currently handling (PresenceService.ping, agents.md §2).
export async function findActiveOrdersByAgent(agentId: number, conn: Knex): Promise<Order[]> {
    const rows = await conn("orders")
        .where("delivery_agent_id", agentId)
        .whereIn("status", [OrderStatus.ASSIGNED, OrderStatus.PICKED])
        .select(ORDER_COLUMNS);
    return rows.map(toEntity);
}
