import { coreClient } from "./core-client";
import { cacheProvider } from "../cache/init";
import { toSeconds } from "../../pkg/utils/time";
import { CoreEnvelope, InternalBranchDTO, InternalBranchProductDTO, ReserveStockItem } from "./types";

const BRANCH_CACHE_TTL_SEC = toSeconds(5, "m");
const BRANCH_REJECT_FLAG_TTL_SEC = toSeconds(1, "d");

function branchCacheKey(branchId: number): string {
    return `core:branch:${branchId}`;
}

function branchRejectFlagKey(branchId: number): string {
    return `core:branch:rejected:${branchId}`;
}

// Hard circuit breaker set by the branch.deactivated core-event handler (see
// src/app/order/order.events.ts) — independent of the read-through cache above, so a
// deactivated branch is rejected even if a placeOrder() call is mid-flight and about to
// repopulate `core:branch:{id}` with data read just before the event arrived. TTL is a
// safety net only, in case the matching branch.updated clear is ever missed.
export async function markBranchRejectingOrders(branchId: number): Promise<void> {
    await cacheProvider.set(branchRejectFlagKey(branchId), "1", BRANCH_REJECT_FLAG_TTL_SEC);
}

export async function clearBranchRejectingOrders(branchId: number): Promise<void> {
    await cacheProvider.del(branchRejectFlagKey(branchId));
}

export async function isBranchRejectingOrders(branchId: number): Promise<boolean> {
    return (await cacheProvider.get(branchRejectFlagKey(branchId))) !== null;
}

// Invalidated by the branch.updated/branch.deactivated core-event handlers (see
// app/order/controller/order-events.controller.ts) — the branch row changed, and its
// payload doesn't carry the new column values, so the only safe move is to drop the
// cache and let the next getBranch() read repopulate it.
export async function invalidateBranch(branchId: number): Promise<void> {
    await cacheProvider.del(branchCacheKey(branchId));
}

// Read-through cache — branch metadata is read on every order placement (hot path) but
// changes rarely. Invalidated by the branch.updated/branch.deactivated/restaurant.suspended
// core-event handlers (see app/order/controller/order-events.controller.ts).
export async function getBranch(branchId: number, correlationId?: string): Promise<InternalBranchDTO> {
    const key = branchCacheKey(branchId);
    const cached = await cacheProvider.get(key);
    if (cached) return JSON.parse(cached) as InternalBranchDTO;

    const res = await coreClient.request<CoreEnvelope<InternalBranchDTO>>({
        method: "GET",
        path: `/api/v1/internal/branches/${branchId}`,
        correlationId,
    });

    await cacheProvider.set(key, JSON.stringify(res.data), BRANCH_CACHE_TTL_SEC);
    return res.data;
}

// Not cached: price/stock/availability must be fresh at order time; the atomic
// reserve-stock decrement in core-service is the real safety net against staleness.
export async function getBranchProducts(
    branchId: number,
    productIds: number[],
    correlationId?: string,
): Promise<InternalBranchProductDTO[]> {
    if (productIds.length === 0) return [];
    const ids = productIds.join(",");
    const res = await coreClient.request<CoreEnvelope<InternalBranchProductDTO[]>>({
        method: "GET",
        path: `/api/v1/internal/branches/${branchId}/products?ids=${ids}`,
        correlationId,
    });
    return res.data;
}

// Atomic decrement in core-service; throws (409, with `details.items`) on underflow.
export async function reserveStock(
    branchId: number,
    items: ReserveStockItem[],
    idempotencyKey: string,
    correlationId?: string,
): Promise<void> {
    await coreClient.request<unknown>({
        method: "POST",
        path: `/api/v1/internal/branches/${branchId}/reserve-stock`,
        body: { items },
        idempotencyKey,
        correlationId,
    });
}

// Undoes a reservation made with the same idempotencyKey — needed because
// placeOrder() reserves stock before the order/items are persisted (see
// order.service.ts); if that persistence fails, the reservation must be released rather
// than left stuck against stock that was never actually ordered.
export async function releaseStock(
    branchId: number,
    items: ReserveStockItem[],
    idempotencyKey: string,
    correlationId?: string,
): Promise<void> {
    await coreClient.request<unknown>({
        method: "POST",
        path: `/api/v1/internal/branches/${branchId}/release-stock`,
        body: { items },
        idempotencyKey,
        correlationId,
    });
}
