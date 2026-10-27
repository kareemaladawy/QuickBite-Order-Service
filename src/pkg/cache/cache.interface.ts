export interface ICacheProvider {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;
    del(key: string): Promise<number>;

    /**
     * Atomic "set if absent". Returns true if the key was newly set, false if
     * it already existed. Used for dedupe / distributed locks.
     */
    trySet(key: string, value: string, ttlSeconds?: number): Promise<boolean>;

    /**
     * Deletes every key matching a glob pattern (e.g. `eg:GET:/api/v1/restaurant/orders*branchId=5*`).
     * For invalidating a `withCache()`-cached endpoint whose key varies by query string
     * (filters, pagination) in a way a single `del(key)` can't target. Must not block
     * Redis (SCAN, not KEYS).
     */
    delByPattern(pattern: string): Promise<number>;
}
