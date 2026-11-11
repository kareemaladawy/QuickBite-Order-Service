import { coreClient } from "./core-client";
import { cacheProvider } from "../cache/init";
import { toSeconds } from "../../pkg/utils/time";
import { CoreEnvelope, InternalRestaurantDTO } from "./types";

const RESTAURANT_CACHE_TTL_SEC = toSeconds(5, "m");

function restaurantCacheKey(restaurantId: number): string {
    return `core:restaurant:${restaurantId}`;
}

// Invalidated by the restaurant.suspended core-event handler (see
// app/order/controller/order-events.controller.ts) — the payload only carries the id,
// not the new status, so there's nothing to write in place of a delete.
export async function invalidateRestaurant(restaurantId: number): Promise<void> {
    await cacheProvider.del(restaurantCacheKey(restaurantId));
}

// Read-through cache. Note: the treasury/account ledgers (app/payment,
// app/restaurant-finance) key everything off `restaurantId` directly, never
// `ownerId` — `ownerId` here is only for callers that need the owning user's id for
// something outside the ledger (e.g. notifications).
export async function getRestaurant(restaurantId: number, correlationId?: string): Promise<InternalRestaurantDTO> {
    const key = restaurantCacheKey(restaurantId);
    const cached = await cacheProvider.get(key);
    if (cached) return JSON.parse(cached) as InternalRestaurantDTO;

    const res = await coreClient.request<CoreEnvelope<InternalRestaurantDTO>>({
        method: "GET",
        path: `/api/v1/internal/restaurants/${restaurantId}`,
        correlationId,
    });

    await cacheProvider.set(key, JSON.stringify(res.data), RESTAURANT_CACHE_TTL_SEC);
    return res.data;
}
