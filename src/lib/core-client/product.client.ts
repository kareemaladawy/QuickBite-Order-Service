import { cacheProvider } from "../cache/init";
import { toSeconds } from "../../pkg/utils/time";

// Matches the TTL documented for `core:product:price:*` / `core:product:stock:*` in
// docs/system-design.md §3 Layer A. Not read through today (getBranchProducts in
// branch.client.ts intentionally re-fetches from core-service on every order so
// price/stock/availability are never stale at order time) but kept warm here so a
// future cached read path is never seeded with stale data.
const PRODUCT_CACHE_TTL_SEC = toSeconds(30, "s");

function productPriceCacheKey(branchId: number, productId: number): string {
    return `core:product:price:${branchId}:${productId}`;
}

function productStockCacheKey(branchId: number, productId: number): string {
    return `core:product:stock:${branchId}:${productId}`;
}

// product.price.changed carries the new price, so write it straight through instead of
// deleting and forcing the next (future) read to round-trip to core-service.
export async function updateProductPriceCache(branchId: number, productId: number, price: number): Promise<void> {
    await cacheProvider.set(productPriceCacheKey(branchId, productId), JSON.stringify(price), PRODUCT_CACHE_TTL_SEC);
}

// product.stock.changed carries the new stock + availability, so write both through
// together — a stock decrement to zero also flips isAvailable, and the two must never
// be read back out of sync with each other.
export async function updateProductStockCache(
    branchId: number,
    productId: number,
    stock: number,
    isAvailable: boolean,
): Promise<void> {
    await cacheProvider.set(
        productStockCacheKey(branchId, productId),
        JSON.stringify({ stock, isAvailable }),
        PRODUCT_CACHE_TTL_SEC,
    );
}
