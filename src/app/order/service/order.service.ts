import { injectable } from "tsyringe";
import type { Knex } from "knex";
import { v4 as uuidv4 } from "uuid";
import { container } from "../../../lib/di/container";
import { TOKENS } from "../../../lib/di/tokens";
import { db, dbArchive } from "../../../lib/knex/knex";
import { logger } from "../../../lib/logger/logger";
import { cacheProvider } from "../../../lib/cache/init";
import { JWTPayload, SystemRole } from "../../../lib/auth/types";
import { bpsOfMinor, multiplyMinor, sumMinor } from "../../../pkg/utils/money";
import { addMs, toMs } from "../../../pkg/utils/time";
import { PaginationParams } from "../../../lib/http/pagination/types";
import {
    getBranch,
    getBranchProducts,
    isBranchRejectingOrders,
    releaseStock,
    reserveStock,
} from "../../../lib/core-client/branch.client";
import { getCustomerAddress } from "../../../lib/core-client/address.client";
import {
    bulkInsertItems,
    findItemsByOrderIds,
} from "../repository/order-item.repo";
import {
    clearDeliveryAgent,
    countActiveOrdersForAgent,
    createOrder,
    findActiveOrdersByAgent,
    deleteOrder,
    findOrderById,
    findOrderByPublicId,
    findOrdersByAgent,
    findOrdersByBranch,
    findOrdersByCustomer,
    findOrdersByIds,
    findReadyOrders,
    findStalePendingPaymentOrders,
    incrementReassignmentAttempts,
    setDeliveryAgent,
    updateOrderStatus,
} from "../repository/order.repo";
import { assertTransition, STATUS_TIMESTAMP_COLUMN } from "./order-status.service";
import { insertOrderOutboxEvent, insertOrderPlacedOutboxEvent, ORDER_STATUS_OUTBOX_EVENT_TYPE } from "../outbox-events";
import { OrderEventType } from "../../../lib/events/event-types";
import { Order } from "../entity/order.entity";
import { OrderItem } from "../entity/order-item.entity";
import { CreateOrderRequestDTO, UpdateOrderStatusRequestDTO } from "../dto/order.request.dto";
import { OrderActorType, OrderStatus, PaymentMethod, RestaurantStatus } from "../enums";
import {
    AddressNotOwnedError,
    BranchNotAcceptingOrdersError,
    EmptyOrderItemsError,
    ForbiddenOrderAccessError,
    MissingCancellationReasonError,
    OrderNotFoundError,
    orderItemsUnavailableError,
} from "../errors";
import {
    FindOrdersByAgentFilters,
    FindOrdersByBranchFilters,
    GetOrderResult,
    OffendingOrderItem,
    OrderActorContext,
    OrderCompositeId,
    PlaceOrderResult,
} from "../types";
import type { PaymentService } from "../../payment/service/payment.service";
import type { AssignmentService } from "../../agent/service/assignment.service";
import type { DeliveryService } from "../../agent/service/delivery.service";

// Flat 10% platform service fee, same across all regions until per-region/per-branch
// rates are configured.
const PLATFORM_SERVICE_RATE_BPS = 1000;

// Must match the mount in app.ts (`/api/v1`) + routes.ts (`/restaurant/orders/:branchId`) —
// this is what withCache() keys GET /restaurant/orders/:branchId under (see order.routes.ts).
const RESTAURANT_ORDERS_PATH = "/api/v1/restaurant/orders";

// Stamped by sweepStalePendingPaymentOrders — stable, system-facing wording, not
// something a customer or restaurant action ever produces.
const STALE_PENDING_PAYMENT_CANCELLATION_REASON = "Payment not completed in time";

// docs/implementation-plan.md Phase 5 — only the current year is queryable from the
// hot cluster; everything older lives in the per-region archive cluster.
function startOfYearUtc(year: number): Date {
    return new Date(Date.UTC(year, 0, 1));
}

// GET /restaurant/orders/:branchId is cached per exact query string (filters,
// pagination) on top of the path-scoped branchId, so a single `del(key)` can't target
// every cached variant for a branch — glob-match every key under this branch's path
// segment instead. Called after any write that changes what that list would return for
// the branch. Awaited by the caller so the list is guaranteed fresh by the time the
// write's response goes out.
async function invalidateRestaurantOrdersCache(region: string, branchId: number): Promise<void> {
    try {
        await cacheProvider.delByPattern(`${region}:GET:${RESTAURANT_ORDERS_PATH}/${branchId}*`);
    } catch (err) {
        logger.warn("restaurant orders cache invalidation failed", { region, branchId, error: (err as Error).message });
    }
}

@injectable()
export class OrderService {
    placeOrder = async (
        customer: JWTPayload,
        data: CreateOrderRequestDTO,
        idempotencyKey: string,
        correlationId?: string,
    ): Promise<PlaceOrderResult> => {
        if (data.items.length === 0) throw EmptyOrderItemsError;

        // Hard circuit breaker set by the branch.deactivated core-event handler — checked
        // ahead of the (cached) branch read so a deactivation is enforced immediately,
        // even against a request that's mid-flight on a stale cache read.
        if (await isBranchRejectingOrders(data.branchId)) throw BranchNotAcceptingOrdersError;

        // Step 1-2: branch (also resolves the shard region — the order always goes to
        // the branch's country shard, per docs/business-logic/orders.md §2).
        const branch = await getBranch(data.branchId, correlationId);
        if (!branch.isActive || !branch.acceptOrders || branch.restaurantStatus !== RestaurantStatus.ACTIVE) {
            throw BranchNotAcceptingOrdersError;
        }

        // Reject an online order for a region Kashier doesn't support before any stock
        // reservation or order row is created, rather than only discovering this once
        // initForOrder runs after the order already exists (PaymentService owns the
        // actual region list — see assertOnlinePaymentSupported).
        if (data.paymentMethod === PaymentMethod.ONLINE) {
            container.resolve<PaymentService>(TOKENS.PaymentService).assertOnlinePaymentSupported(branch.region);
        }

        // Step 3: customer address.
        const address = await getCustomerAddress(data.customerAddressId, correlationId);
        if (address.userId !== customer.userId) throw AddressNotOwnedError;

        // Step 4: batch price/stock/availability lookup and validation.
        const productIds = data.items.map((item) => item.productId);
        const products = await getBranchProducts(branch.id, productIds, correlationId);
        // construct a hash map to avoid n+1
        const productById = new Map(products.map((p) => [p.productId, p]));
        const offending: OffendingOrderItem[] = [];

        for (const item of data.items) {
            const product = productById.get(item.productId);

            if (!product) offending.push({ productId: item.productId, reason: "not_found" });
            else if (!product.isAvailable) offending.push({ productId: item.productId, reason: "unavailable" });
            else if (product.stock < item.quantity) offending.push({ productId: item.productId, reason: "insufficient_stock" });
        }

        if (offending.length > 0) throw orderItemsUnavailableError(offending);

        // Step 5: compute money (minor units).
        const subtotal = sumMinor(
            data.items.map((item) => multiplyMinor(productById.get(item.productId)!.price, item.quantity)),
        );
        const deliveryFee = branch.deliveryFee;
        const serviceFee = bpsOfMinor(subtotal, PLATFORM_SERVICE_RATE_BPS);
        const total = subtotal + deliveryFee + serviceFee;

        const region = branch.region;
        const conn = db(region);
        const status = data.paymentMethod === PaymentMethod.ONLINE ? OrderStatus.PENDING_PAYMENT : OrderStatus.PLACED;
        const publicId = uuidv4();

        // Step 6a: reserve stock before the order exists, so we never persist an order
        // the branch can no longer fulfill. Requires a matching
        // POST /internal/branches/{id}/release-stock endpoint in core-service to undo
        // this specific reservation (by idempotencyKey) if persistence below fails.
        const reservationItems = data.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity
        }));
        await reserveStock(branch.id, reservationItems, idempotencyKey, correlationId);

        // Step 6b: insert order + items in one trx. If this fails, the reservation above
        // was never consumed by a persisted order and must be released.
        const trx = await conn.transaction();
        let order: Order;
        let items: OrderItem[];

        try {
            order = await createOrder(
                {
                    region,
                    publicId,
                    countryCode: branch.region.toUpperCase(),
                    restaurantId: branch.restaurantId,
                    branchId: branch.id,
                    customerId: customer.userId,
                    customerAddressId: address.id,
                    deliveryLat: address.lat,
                    deliveryLng: address.lng,
                    deliveryAddressTextSnapshot: address.addressText,
                    pickupLat: branch.lat,
                    pickupLng: branch.lng,
                    pickupAddressTextSnapshot: branch.addressText,
                    branchNameSnapshot: branch.name,
                    status,
                    subtotal,
                    deliveryFee,
                    serviceFee,
                    total,
                    currency: branch.currency,
                    paymentMethod: data.paymentMethod,
                },
                trx,
            );

            items = await bulkInsertItems(
                data.items.map((item) => {
                    const product = productById.get(item.productId)!;
                    return {
                        region,
                        orderId: order.id,
                        orderCreatedAt: order.createdAt,
                        productId: item.productId,
                        quantity: item.quantity,
                        unitPriceSnapshot: product.price,
                        nameSnapshot: product.name,
                        imageUrlSnapshot: product.imageUrl,
                        lineTotal: multiplyMinor(product.price, item.quantity),
                    };
                }),
                trx,
            );

            // COD is placed immediately, so fire order.placed here. Online orders are
            // still `pending_payment` at this point — their order.placed fires later,
            // from markPlacedBySystem, once the capture webhook confirms payment.
            if (data.paymentMethod === PaymentMethod.COD) {
                await insertOrderPlacedOutboxEvent(order, items, trx);
            }

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            try {
                await releaseStock(branch.id, reservationItems, idempotencyKey, correlationId);
            } catch (releaseErr) {
                logger.error("releaseStock failed after order persistence error — stock left reserved", {
                    branchId: branch.id,
                    idempotencyKey,
                    error: (releaseErr as Error).message,
                });
            }
            throw err;
        }

        await invalidateRestaurantOrdersCache(region, branch.id);

        if (data.paymentMethod === PaymentMethod.COD) {
            this.emitWs(`branch:${branch.id}`, "order.created", order);
            return { order, items };
        }

        // Online orders: init the Kashier session inline (product decision — no
        // separate "first init" endpoint, see docs/business-logic/payments.md §2).
        // `order.created`/`order.status_changed` WS events are deferred until the
        // capture webhook actually confirms payment (markPlacedBySystem below).
        const paymentService = container.resolve<PaymentService>(TOKENS.PaymentService);
        try {
            const paymentInit = await paymentService.initForOrder({
                orderId: order.id,
                orderCreatedAt: order.createdAt,
                orderPublicId: order.publicId,
                customerId: order.customerId,
                amountMinor: order.total,
                currency: order.currency,
                region,
            });

            return { order, items, paymentInit };
        } catch (err) {
            // Payment init failed after the order was already committed above — the
            // client never saw this order (placeOrder hasn't returned yet), so rather
            // than leave it dangling in `pending_payment` forever, undo it: delete the
            // order (order_items cascades via its FK) and release the stock reserved
            // for it. Compensating actions are best-effort and logged, not swallowed —
            // the original payment error is always what's surfaced to the client.
            try {
                await deleteOrder(order.id, order.createdAt, conn);
                await releaseStock(branch.id, reservationItems, idempotencyKey, correlationId);
                await invalidateRestaurantOrdersCache(region, branch.id);
            } catch (cleanupErr) {
                logger.error("cleanup after payment-init failure failed — order and/or stock reservation left dangling", {
                    orderId: order.id,
                    branchId: branch.id,
                    idempotencyKey,
                    error: (cleanupErr as Error).message,
                });
            }
            throw err;
        }
    };

    // GET /orders/:orderId — customer (own) + system_admin. No branch/restaurant param
    // here, so ownership can only be confirmed once the order is loaded. The archive
    // cluster is admin-only (docs/implementation-plan.md Phase 5) — a customer never
    // falls back to it, so a customer's own historical order simply reads as not found
    // once it's been archived. system_admin gets the hot-first, archive-fallback lookup.
    getOrder = async (publicId: string, region: string, actor: JWTPayload): Promise<GetOrderResult> => {
        let conn = db(region);
        let order = await findOrderByPublicId(publicId, conn);
        if (!order && actor.role === SystemRole.SYSTEM_ADMIN) {
            conn = dbArchive(region);
            order = await findOrderByPublicId(publicId, conn);
        }
        if (!order) throw OrderNotFoundError;

        if (actor.role !== SystemRole.SYSTEM_ADMIN && !order.isOwnedBy(actor.userId)) {
            throw ForbiddenOrderAccessError;
        }

        const items = await findItemsByOrderIds([order.id], conn);
        return { order, items };
    };

    // GET /restaurants/:restaurantId/branches/:branchId/orders/:orderId —
    // restaurant_user + system_admin. requireRestaurantMember('restaurantId') and
    // requireBranchAccess('branchId') (routes.ts) already confirmed the caller may act
    // for that restaurant/branch; this is purely a data check — does this order
    // actually belong to that branch — not an authorization decision. Same hot-first,
    // archive-fallback lookup as getOrder above.
    getRestaurantOrder = async (
        publicId: string,
        region: string,
        restaurantId: number,
        branchId: number,
    ): Promise<GetOrderResult> => {
        let conn = db(region);
        let order = await findOrderByPublicId(publicId, conn);
        if (!order) {
            conn = dbArchive(region);
            order = await findOrderByPublicId(publicId, conn);
        }
        if (!order) throw OrderNotFoundError;

        if (order.restaurantId !== restaurantId || order.branchId !== branchId) {
            throw OrderNotFoundError;
        }

        const items = await findItemsByOrderIds([order.id], conn);
        return { order, items };
    };

    // GET /customer/orders?year=YYYY — the archive cluster is admin/restaurant-only
    // (docs/implementation-plan.md Phase 5); a customer never reads it, so this always
    // queries the hot cluster regardless of `year` — a prior-year request simply comes
    // back empty once those orders have been archived off the hot cluster.
    listCustomerOrders = async (
        customerId: number,
        region: string,
        year: number,
        pagination: PaginationParams,
    ): Promise<Order[]> => {
        return findOrdersByCustomer(customerId, { year }, pagination, db(region));
    };

    // GET /restaurant/orders/:branchId?from=&to= — a range entirely in prior years
    // reads only the archive cluster, a range entirely in the current year reads only
    // the hot cluster, and a range straddling the boundary (rare) fans out to both and
    // merges in-memory (docs/implementation-plan.md Phase 5's documented fan-out path).
    listRestaurantOrders = async (
        branchId: number,
        region: string,
        filters: FindOrdersByBranchFilters,
        pagination: PaginationParams,
    ): Promise<Order[]> => {
        const currentYearStart = startOfYearUtc(new Date().getUTCFullYear());
        const entirelyPastHot = filters.to !== undefined && filters.to < currentYearStart;
        const entirelyPastArchive = filters.from === undefined || filters.from >= currentYearStart;

        if (entirelyPastHot) {
            return findOrdersByBranch(branchId, filters, pagination, dbArchive(region));
        }
        if (entirelyPastArchive) {
            return findOrdersByBranch(branchId, filters, pagination, db(region));
        }

        // Straddles the boundary: query each cluster bounded by the same filters/limit,
        // merge, re-sort, and hand back at most `limit + 1` rows so the controller's
        // existing buildPaginationResult (hasMore/nextCursor) keeps working unchanged.
        const [archiveRows, hotRows] = await Promise.all([
            findOrdersByBranch(branchId, filters, pagination, dbArchive(region)),
            findOrdersByBranch(branchId, filters, pagination, db(region)),
        ]);

        const merged = [...archiveRows, ...hotRows].sort((a, b) => {
            const diff = a.createdAt.getTime() - b.createdAt.getTime();
            return pagination.sortOrder === "asc" ? diff : -diff;
        });

        return merged.slice(0, pagination.limit + 1);
    };

    // PATCH /orders/:orderId/status — customer self-cancel + system_admin. There is no
    // route param that scopes this to a branch/restaurant, so unlike
    // updateRestaurantOrderStatus below, ownership can't be checked by middleware alone:
    // a customer can only be confirmed to own the order once it's loaded.
    updateStatus = async (
        publicId: string,
        region: string,
        actor: JWTPayload,
        data: UpdateOrderStatusRequestDTO,
    ): Promise<Order> => {
        const conn = db(region);
        const order = await findOrderByPublicId(publicId, conn);
        if (!order) throw OrderNotFoundError;

        let actorType: OrderActorType;
        if (actor.role === SystemRole.SYSTEM_ADMIN) {
            actorType = OrderActorType.ADMIN;
        } else if (order.isOwnedBy(actor.userId)) {
            actorType = OrderActorType.CUSTOMER;
        } else {
            throw ForbiddenOrderAccessError;
        }

        return this.applyStatusTransition(order, region, conn, actorType, data);
    };

    // PATCH /restaurants/:restaurantId/branches/:branchId/orders/:orderId/status —
    // restaurant_user + system_admin. requireRestaurantMember('restaurantId') and
    // requireBranchAccess('branchId') (routes.ts) already confirmed the caller may act
    // for that restaurant/branch; all that's left here is a data check — does this
    // order actually belong to that branch — not an authorization decision.
    updateRestaurantOrderStatus = async (
        publicId: string,
        region: string,
        restaurantId: number,
        branchId: number,
        actor: JWTPayload,
        data: UpdateOrderStatusRequestDTO,
    ): Promise<Order> => {
        const conn = db(region);
        const order = await findOrderByPublicId(publicId, conn);
        if (!order) throw OrderNotFoundError;

        if (order.restaurantId !== restaurantId || order.branchId !== branchId) {
            throw OrderNotFoundError;
        }

        const actorType = actor.role === SystemRole.SYSTEM_ADMIN ? OrderActorType.ADMIN : OrderActorType.RESTAURANT;

        return this.applyStatusTransition(order, region, conn, actorType, data);
    };

    private applyStatusTransition = async (
        order: Order,
        region: string,
        conn: Knex,
        actorType: OrderActorType,
        data: UpdateOrderStatusRequestDTO,
    ): Promise<Order> => {
        if (data.status === OrderStatus.CANCELLED && !data.reason) {
            throw MissingCancellationReasonError;
        }

        const actorContext: OrderActorContext = {
            type: actorType,
            orderCreatedAt: order.createdAt,
            acceptedAt: order.acceptedAt,
        };
        assertTransition(order.status, data.status, actorContext);

        // Explicit trx (a savepoint if `conn` is already one) so the status flip and
        // its outbox event (if this transition has one) commit atomically.
        const trx = await conn.transaction();
        let updated: Order;
        try {
            updated = await updateOrderStatus(
                order.id,
                order.createdAt,
                {
                    status: data.status,
                    timestampColumn: STATUS_TIMESTAMP_COLUMN[data.status],
                    cancellationReason: data.status === OrderStatus.CANCELLED ? data.reason : undefined,
                },
                trx,
            );

            const eventType = ORDER_STATUS_OUTBOX_EVENT_TYPE[data.status];
            if (eventType) {
                await insertOrderOutboxEvent(updated, eventType, trx);
            }

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }

        await invalidateRestaurantOrdersCache(region, updated.branchId);

        this.emitWs(`customer:${order.customerId}`, "order.status_changed", updated);
        this.emitWs(`branch:${order.branchId}`, "order.status_changed", updated);

        // Cross-module hooks (agents.md §9, §8) — fire after the transition is durable
        // so a hook failure never rolls back (or blocks returning) the status change
        // itself; each is independently try/caught and logged.
        if (updated.status === OrderStatus.READY) {
            try {
                await this.assignmentService().tryAssign(updated);
            } catch (err) {
                logger.error("post-ready assignment broadcast failed — sweep worker will retry", {
                    orderId: updated.id,
                    error: (err as Error).message,
                });
            }
        } else if (updated.status === OrderStatus.CANCELLED && order.status === OrderStatus.ASSIGNED) {
            try {
                await this.deliveryService().handleCancelledWhileAssigned(updated);
            } catch (err) {
                logger.error("delivery cleanup after cancel-while-assigned failed", {
                    orderId: updated.id,
                    error: (err as Error).message,
                });
            }
        }

        return updated;
    };

    // No ownership check — for system-driven callers (the Kashier webhook handler)
    // that don't have a JWTPayload actor. Kept separate from getOrder() rather than
    // threading a nullable actor through its assertCanView().
    getOrderForSystem = async (publicId: string, region: string): Promise<Order> => {
        const order = await findOrderByPublicId(publicId, db(region));
        if (!order) throw OrderNotFoundError;
        return order;
    };

    // Same no-ownership-check contract as getOrderForSystem, but keyed by the
    // composite PK — for callers that only hold a transactions row (orderId +
    // the denormalized orderCreatedAt), e.g. PaymentService.getById's ownership check.
    getOrderByIdForSystem = async (id: number, createdAt: Date, region: string): Promise<Order> => {
        const order = await findOrderById(id, createdAt, db(region));
        if (!order) throw OrderNotFoundError;
        return order;
    };

    // Batch counterpart of getOrderByIdForSystem (CLAUDE.md §7 — no N+1), for callers
    // such as the payment reconciler that hold several (id, createdAt) pairs at once.
    getOrdersByCompositeIds = async (pairs: OrderCompositeId[], region: string): Promise<Order[]> => {
        return findOrdersByIds(pairs, db(region));
    };

    // Drives the `pending_payment -> placed` transition on a captured payment
    // (docs/business-logic/payments.md §3). Called by payment-webhook.service.ts,
    // which never reaches into order.repo directly (CLAUDE.md §3 cross-module rule).
    markPlacedBySystem = async (order: Order, region: string): Promise<Order> => {
        const actorContext: OrderActorContext = {
            type: OrderActorType.SYSTEM,
            orderCreatedAt: order.createdAt,
            acceptedAt: order.acceptedAt,
        };
        assertTransition(order.status, OrderStatus.PLACED, actorContext);

        // Online orders only fire order.placed here, once the capture webhook confirms
        // payment — unlike COD (fired at submission in placeOrder), an online order
        // isn't "placed" in any sense analytics cares about until payment clears.
        const trx = await db(region).transaction();
        let updated: Order;
        try {
            updated = await updateOrderStatus(
                order.id,
                order.createdAt,
                { status: OrderStatus.PLACED },
                trx,
            );
            const items = await findItemsByOrderIds([order.id], trx);
            await insertOrderPlacedOutboxEvent(updated, items, trx);
            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }

        await invalidateRestaurantOrdersCache(region, updated.branchId);

        this.emitWs(`branch:${updated.branchId}`, "order.created", updated);
        this.emitWs(`customer:${updated.customerId}`, "order.status_changed", updated);

        return updated;
    };

    // Background sweep (lib/jobs/pending-payment-sweep.ts) — a pending_payment order
    // whose online payment never completed within `timeoutMin` is auto-cancelled and
    // its reserved stock released, per docs/business-logic/orders.md §9 / payments.md
    // §9. Returns how many orders it cancelled this pass, for the job's own logging.
    sweepStalePendingPaymentOrders = async (region: string, timeoutMin: number): Promise<number> => {
        const conn = db(region);
        const cutoff = addMs(new Date(), -toMs(timeoutMin, "m"));
        const staleOrders = await findStalePendingPaymentOrders(cutoff, conn);
        if (staleOrders.length === 0) return 0;

        // Batch-fetch every stale order's items in one round trip (CLAUDE.md §7 — no
        // N+1), then group them back up per order.
        const itemsByOrderId = new Map<number, OrderItem[]>();
        for (const item of await findItemsByOrderIds(staleOrders.map((o) => o.id), conn)) {
            const list = itemsByOrderId.get(item.orderId) ?? [];
            list.push(item);
            itemsByOrderId.set(item.orderId, list);
        }

        let cancelledCount = 0;
        for (const order of staleOrders) {
            try {
                const actorContext: OrderActorContext = {
                    type: OrderActorType.SYSTEM,
                    orderCreatedAt: order.createdAt,
                    acceptedAt: order.acceptedAt,
                };
                assertTransition(order.status, OrderStatus.CANCELLED, actorContext);

                const sweepTrx = await conn.transaction();
                let updated: Order;
                try {
                    updated = await updateOrderStatus(
                        order.id,
                        order.createdAt,
                        {
                            status: OrderStatus.CANCELLED,
                            timestampColumn: STATUS_TIMESTAMP_COLUMN[OrderStatus.CANCELLED],
                            cancellationReason: STALE_PENDING_PAYMENT_CANCELLATION_REASON,
                        },
                        sweepTrx,
                    );
                    await insertOrderOutboxEvent(updated, OrderEventType.ORDER_CANCELLED, sweepTrx);
                    await sweepTrx.commit();
                } catch (err) {
                    await sweepTrx.rollback();
                    throw err;
                }

                // Best-effort: the order is already cancelled regardless of whether
                // this succeeds — a release failure here means stock stays reserved,
                // not that the order stays stuck in pending_payment.
                try {
                    const orderItems = itemsByOrderId.get(order.id) ?? [];
                    await releaseStock(
                        order.branchId,
                        orderItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
                        `sweep:${order.publicId}`,
                    );
                } catch (releaseErr) {
                    logger.error("sweep: releaseStock failed for cancelled order — stock may be left reserved", {
                        orderId: order.id,
                        branchId: order.branchId,
                        error: (releaseErr as Error).message,
                    });
                }

                await invalidateRestaurantOrdersCache(region, updated.branchId);
                this.emitWs(`customer:${updated.customerId}`, "order.status_changed", updated);
                this.emitWs(`branch:${updated.branchId}`, "order.status_changed", updated);
                cancelledCount++;
            } catch (err) {
                logger.error("sweep: failed to cancel stale pending_payment order", {
                    orderId: order.id,
                    error: (err as Error).message,
                });
            }
        }

        return cancelledCount;
    };

    // --- Agents module forwards every orders-table mutation it needs here instead of
    // reaching into order.repo directly (CLAUDE.md §3). None of these do ownership
    // checks — callers (delivery.service / assignment.service) already know which
    // agent/order they're acting on.

    // Commits a winning broadcast-accept or a manual admin assign.
    assignAgent = async (order: Order, agentId: number, conn: Knex): Promise<Order> => {
        const updated = await setDeliveryAgent(order.id, order.createdAt, agentId, conn);
        await invalidateRestaurantOrdersCache(order.region, updated.branchId);
        return updated;
    };

    // Cancellation-while-assigned (agents.md §8).
    clearAgent = async (order: Order, conn: Knex): Promise<Order> => {
        return clearDeliveryAgent(order.id, order.createdAt, conn);
    };

    // Every reassignment (admin-triggered or the sweep worker) bumps this counter.
    bumpReassignmentAttempts = async (order: Order, conn: Knex): Promise<Order> => {
        return incrementReassignmentAttempts(order.id, order.createdAt, conn);
    };

    // The assigned->picked->delivered agent path — reuses the same status machine and
    // actor-matrix as customer/restaurant transitions (order-status.service.ts), just
    // with OrderActorType.AGENT. `extra.commission` lets the 'delivered' transition
    // persist the Restaurant Finance module's computed commission in the same UPDATE as
    // the status flip (see UpdateOrderStatusInput).
    transitionByAgent = async (
        order: Order,
        toStatus: OrderStatus,
        conn: Knex,
        extra?: { commission?: number },
    ): Promise<Order> => {
        const actorContext: OrderActorContext = {
            type: OrderActorType.AGENT,
            orderCreatedAt: order.createdAt,
            acceptedAt: order.acceptedAt,
        };
        assertTransition(order.status, toStatus, actorContext);

        let updated: Order;
        if (toStatus === OrderStatus.DELIVERED) {
            // Only 'delivered' emits an outbox event on this path — wrap it in its own
            // trx (a savepoint if `conn` is already one) so the status flip and the
            // event commit atomically.
            const trx = await conn.transaction();
            try {
                updated = await updateOrderStatus(
                    order.id,
                    order.createdAt,
                    {
                        status: toStatus,
                        timestampColumn: STATUS_TIMESTAMP_COLUMN[toStatus],
                        commission: extra?.commission,
                    },
                    trx,
                );
                await insertOrderOutboxEvent(updated, OrderEventType.ORDER_DELIVERED, trx);
                await trx.commit();
            } catch (err) {
                await trx.rollback();
                throw err;
            }
        } else {
            updated = await updateOrderStatus(
                order.id,
                order.createdAt,
                {
                    status: toStatus,
                    timestampColumn: STATUS_TIMESTAMP_COLUMN[toStatus],
                    commission: extra?.commission,
                },
                conn,
            );
        }

        await invalidateRestaurantOrdersCache(order.region, updated.branchId);
        return updated;
    };

    // Backs the assignment-sweep worker's per-region scan.
    findReadyOrdersForAssignment = async (region: string, limit = 100): Promise<Order[]> => {
        return findReadyOrders(db(region), limit);
    };

    // GET /agents/tasks?status=
    findTasksByAgent = async (
        agentId: number,
        region: string,
        filters: FindOrdersByAgentFilters,
        pagination: PaginationParams,
    ): Promise<Order[]> => {
        return findOrdersByAgent(agentId, filters, pagination, db(region));
    };

    // PresenceService's online-resync and offline guard (agents.md §1, §2).
    countActiveDeliveriesForAgent = async (agentId: number, region: string): Promise<number> => {
        return countActiveOrdersForAgent(agentId, db(region));
    };

    // PresenceService.ping's position fan-out (agents.md §2).
    findActiveDeliveriesForAgent = async (agentId: number, region: string): Promise<Order[]> => {
        return findActiveOrdersByAgent(agentId, db(region));
    };

    // DeliveryTaskResponseDTO's itemsCount field — the agent module never touches
    // order_items directly.
    countItemsForOrder = async (orderId: number, region: string): Promise<number> => {
        return (await findItemsByOrderIds([orderId], db(region))).length;
    };

    flagPendingOrdersForReview = async (restaurantId: number): Promise<void> => {
        // No column exists yet to flag pending orders for review (that would be a
        // cross-shard scan by restaurant_id, out of scope for Phase 1) — surfaced as a
        // log line for ops to action manually instead.
        logger.warn("restaurant suspended — review its pending orders manually", { restaurantId });
    };

    // Resolved lazily for the same reason PaymentService is (see its own comment) —
    // avoids a load-order dependency between the order and agent modules' container
    // registrations.
    private assignmentService(): AssignmentService {
        return container.resolve<AssignmentService>(TOKENS.AssignmentService);
    }

    private deliveryService(): DeliveryService {
        return container.resolve<DeliveryService>(TOKENS.DeliveryService);
    }

    // Resolved lazily (not constructor-injected) because the socket.io server is
    // registered on TOKENS.WsServer in server.ts *after* the DI container has already
    // resolved this service via routes.ts — see src/server.ts boot order.
    private emitWs(room: string, event: string, order: Order): void {
        try {
            const io = container.resolve<{ to: (room: string) => { emit: (event: string, payload: unknown) => void } }>(
                TOKENS.WsServer,
            );
            io.to(room).emit(event, { id: order.publicId, status: order.status, ts: order.updatedAt.toISOString() });
        } catch (err) {
            logger.warn("ws emit skipped (server not ready)", { room, event, error: (err as Error).message });
        }
    }
}
