import { cacheProvider } from "../cache/init";

function restaurantCacheKey(restaurantId: number): string {
    return `core:restaurant:${restaurantId}`;
}

// Invalidated by the restaurant.suspended core-event handler (see
// app/order/controller/order-events.controller.ts) — the payload only carries the id,
// not the new status, so there's nothing to write in place of a delete.
export async function invalidateRestaurant(restaurantId: number): Promise<void> {
    await cacheProvider.del(restaurantCacheKey(restaurantId));
}
