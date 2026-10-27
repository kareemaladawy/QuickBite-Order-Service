import { injectable } from "tsyringe";
import { v4 as uuidv4 } from "uuid";
import { container } from "../../../lib/di/container";
import { TOKENS } from "../../../lib/di/tokens";
import { db } from "../../../lib/knex/knex";
import { logger } from "../../../lib/logger/logger";
import { cacheProvider } from "../../../lib/cache/init";
import { JWTPayload } from "../../../lib/auth/types";
import { bpsOfMinor, multiplyMinor, sumMinor } from "../../../pkg/utils/money";
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
    createOrder,
    findOrderByPublicId,
    findOrdersByBranch,
    findOrdersByCustomer,
    updateOrderStatus,
} from "../repository/order.repo";
import { assertTransition, STATUS_TIMESTAMP_COLUMN } from "./order-status.service";
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
    FindOrdersByBranchFilters,
    GetOrderResult,
    OffendingOrderItem,
    OrderActorContext,
    PlaceOrderResult,
} from "../types";

// Flat 10% platform service fee, same across all regions until per-region/per-branch
// rates are configured.
const PLATFORM_SERVICE_RATE_BPS = 1000;

// Must match the mount in app.ts (`/api/v1`) + routes.ts (`/restaurant/orders`) — this
// is what withCache() keys GET /restaurant/orders under (see order.routes.ts).
const RESTAURANT_ORDERS_PATH = "/api/v1/restaurant/orders";

// GET /restaurant/orders is cached per exact query string (filters, pagination), so a
// single `del(key)` can't target every cached variant for a branch — glob-match every
// key containing this branch's id instead. Called after any write that changes what
// that list would return for the branch. Awaited by the caller so the list is
// guaranteed fresh by the time the write's response goes out.
async function invalidateRestaurantOrdersCache(region: string, branchId: number): Promise<void> {
    try {
        await cacheProvider.delByPattern(`${region}:GET:${RESTAURANT_ORDERS_PATH}*branchId=${branchId}*`);
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
        }

        return { order, items };
    };

    getOrder = async (publicId: string, region: string, actor: JWTPayload): Promise<GetOrderResult> => {
        const order = await findOrderByPublicId(publicId, db(region));
        if (!order) throw OrderNotFoundError;

        this.assertCanView(order, actor);

        const items = await findItemsByOrderIds([order.id], db(region));
        return { order, items };
    };

    listCustomerOrders = async (
        customerId: number,
        region: string,
        pagination: PaginationParams,
    ): Promise<Order[]> => {
        return findOrdersByCustomer(customerId, pagination, db(region));
    };

    listRestaurantOrders = async (
        branchId: number,
        region: string,
        filters: FindOrdersByBranchFilters,
        pagination: PaginationParams,
    ): Promise<Order[]> => {
        return findOrdersByBranch(branchId, filters, pagination, db(region));
    };

    updateStatus = async (
        publicId: string,
        region: string,
        actor: JWTPayload,
        data: UpdateOrderStatusRequestDTO,
    ): Promise<Order> => {
        const conn = db(region);
        const order = await findOrderByPublicId(publicId, conn);
        if (!order) throw OrderNotFoundError;

        this.assertCanView(order, actor);

        if (data.status === OrderStatus.CANCELLED && !data.reason) {
            throw MissingCancellationReasonError;
        }

        const actorContext: OrderActorContext = {
            type: this.actorTypeFor(order, actor),
            orderCreatedAt: order.createdAt,
            acceptedAt: order.acceptedAt,
        };
        assertTransition(order.status, data.status, actorContext);

        const updated = await updateOrderStatus(
            order.id,
            order.createdAt,
            {
                status: data.status,
                timestampColumn: STATUS_TIMESTAMP_COLUMN[data.status],
                cancellationReason: data.status === OrderStatus.CANCELLED ? data.reason : undefined,
            },
            conn,
        );

        await invalidateRestaurantOrdersCache(region, updated.branchId);

        this.emitWs(`customer:${order.customerId}`, "order.status_changed", updated);
        this.emitWs(`branch:${order.branchId}`, "order.status_changed", updated);

        return updated;
    };

    flagPendingOrdersForReview = async (restaurantId: number): Promise<void> => {
        // No column exists yet to flag pending orders for review (that would be a
        // cross-shard scan by restaurant_id, out of scope for Phase 1) — surfaced as a
        // log line for ops to action manually instead.
        logger.warn("restaurant suspended — review its pending orders manually", { restaurantId });
    };

    private actorTypeFor(order: Order, actor: JWTPayload): OrderActorContext["type"] {
        if (actor.role === "system_admin") return OrderActorType.ADMIN;
        if (actor.role === "restaurant_user") return OrderActorType.RESTAURANT;
        if (actor.userId === order.customerId) return OrderActorType.CUSTOMER;
        throw ForbiddenOrderAccessError;
    }

    private assertCanView(order: Order, actor: JWTPayload): void {
        if (actor.role === "system_admin") return;
        if (actor.role === "restaurant_user") {
            const isOwner = actor.restaurantRole === "owner" && actor.restaurantId === order.restaurantId;
            const isBranchMember = (actor.branchIds ?? []).includes(order.branchId);
            if (isOwner || isBranchMember) return;
            throw ForbiddenOrderAccessError;
        }
        if (order.isOwnedBy(actor.userId)) return;
        throw ForbiddenOrderAccessError;
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
