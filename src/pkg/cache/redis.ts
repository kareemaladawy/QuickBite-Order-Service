import Redis from "ioredis";
import type {GeoSearchResult, ICacheProvider, IRedisPipeline} from "./cache.interface";

export class RedisCacheProvider implements ICacheProvider {
    /**
     * Exposed so integrations that need the raw ioredis connection (e.g. the
     * socket.io redis adapter) can reuse it instead of opening another one.
     * The adapter still needs its own subscriber via `client.duplicate()` —
     * once ioredis is in subscribe mode it can't serve get/set.
     */
    constructor(public readonly client: Redis) {}

    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        if (ttlSeconds) {
            await this.client.set(key, value, "EX", ttlSeconds);
        } else {
            await this.client.set(key, value);
        }
    }

    async del(key: string): Promise<number> {
        return this.client.del(key);
    }

    async trySet(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
        const res = ttlSeconds
            ? await this.client.set(key, value, "EX", ttlSeconds, "NX")
            : await this.client.set(key, value, "NX");
        return res === "OK";
    }

    async delByPattern(pattern: string): Promise<number> {
        let cursor = "0";
        let deleted = 0;

        do {
            const [next, keys] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 100);
            cursor = next;
            if (keys.length > 0) deleted += await this.client.del(...keys);
        } while (cursor !== "0");

        return deleted;
    }

    async exists(key: string): Promise<boolean> {
        return (await this.client.exists(key)) === 1;
    }

    async expire(key: string, ttlSeconds: number): Promise<void> {
        await this.client.expire(key, ttlSeconds);
    }

    async sAdd(key: string, ...members: string[]): Promise<void> {
        if (members.length === 0) return;
        await this.client.sadd(key, ...members);
    }

    async sIsMember(key: string, member: string): Promise<boolean> {
        return (await this.client.sismember(key, member)) === 1;
    }

    async sMembers(key: string): Promise<string[]> {
        return this.client.smembers(key);
    }

    async zAdd(key: string, score: number, member: string): Promise<void> {
        await this.client.zadd(key, score, member);
    }

    async zRem(key: string, member: string): Promise<void> {
        await this.client.zrem(key, member);
    }

    async zScore(key: string, member: string): Promise<number | null> {
        const score = await this.client.zscore(key, member);
        return score === null ? null : Number(score);
    }

    async zIncrBy(key: string, increment: number, member: string): Promise<number> {
        const score = await this.client.zincrby(key, increment, member);
        return Number(score);
    }

    async geoAdd(key: string, lng: number, lat: number, member: string): Promise<void> {
        await this.client.geoadd(key, lng, lat, member);
    }

    async geoSearchByRadius(key: string, fromLng: number, fromLat: number, radiusMeters: number, count: number): Promise<GeoSearchResult[]> {
        const raw = (await this.client.geosearch(
            key,
            "FROMLONLAT",
            fromLng,
            fromLat,
            "BYRADIUS",
            radiusMeters,
            "m",
            "ASC",
            "COUNT",
            count,
            "WITHDIST",
        )) as unknown as [string, string][];

        return raw.map(([member, distStr]) => ({member, distanceMeters: Number(distStr)}));
    }

    pipeline(): IRedisPipeline {
        const multi = this.client.multi();
        const batch: IRedisPipeline = {
            setEx(key, value, ttlSeconds) {
                multi.set(key, value, "EX", ttlSeconds);
                return batch;
            },
            del(key) {
                multi.del(key);
                return batch;
            },
            sAdd(key, ...members) {
                multi.sadd(key, ...members);
                return batch;
            },
            expire(key, ttlSeconds) {
                multi.expire(key, ttlSeconds);
                return batch;
            },
            async exec() {
                await multi.exec();
            },
        };
        return batch;
    }
}
