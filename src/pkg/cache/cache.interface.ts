export interface GeoSearchResult {
    member: string;
    distanceMeters: number;
}

/**
 * A batch of writes issued atomically via `MULTI`/`EXEC`. Kept to the generic
 * primitives callers need to compose — no business-specific method names.
 */
export interface IRedisPipeline {
    setEx(key: string, value: string, ttlSeconds: number): this;
    del(key: string): this;
    sAdd(key: string, ...members: string[]): this;
    expire(key: string, ttlSeconds: number): this;
    exec(): Promise<void>;
}

export interface ICacheProvider {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;
    del(key: string): Promise<number>;
    exists(key: string): Promise<boolean>;
    expire(key: string, ttlSeconds: number): Promise<void>;

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

    sAdd(key: string, ...members: string[]): Promise<void>;
    sIsMember(key: string, member: string): Promise<boolean>;
    sMembers(key: string): Promise<string[]>;

    zAdd(key: string, score: number, member: string): Promise<void>;
    zRem(key: string, member: string): Promise<void>;
    zScore(key: string, member: string): Promise<number | null>;
    zIncrBy(key: string, increment: number, member: string): Promise<number>;

    /** `GEOADD` — upserts a member's coordinates in a geo set. */
    geoAdd(key: string, lng: number, lat: number, member: string): Promise<void>;

    /** `GEOSEARCH ... BYRADIUS ... ASC WITHDIST` — nearest-first members within radius. */
    geoSearchByRadius(key: string, fromLng: number, fromLat: number, radiusMeters: number, count: number): Promise<GeoSearchResult[]>;

    /** Starts a `MULTI` batch; call `.exec()` to commit it atomically. */
    pipeline(): IRedisPipeline;
}
