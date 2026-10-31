import { injectable } from "tsyringe";
import { container } from "../../../lib/di/container";
import { TOKENS } from "../../../lib/di/tokens";
import { env } from "../../../lib/config/env";
import { cacheProvider } from "../../../lib/cache/init";
import { publishToRoom } from "../../../lib/websocket/publish";
import type { OrderService } from "../../order/service/order.service";
import { presenceGeoKey, presenceLoadKey, presenceMetaKey } from "../redis-keys";
import { AgentInActiveDeliveryError, NotOnlineError } from "../errors";

// Redis-only presence model — no Postgres table (agents.md §1). `presence:meta`'s TTL
// *is* the staleness cutoff: once it expires, the agent is treated as offline for
// assignment purposes even though `presence:geo`/`presence:load` entries are untouched
// until the agent explicitly goes offline or a candidate scan lazily evicts them.
@injectable()
export class PresenceService {
    // Resolved lazily rather than constructor-injected — same reasoning as
    // order.service.ts's own lazy resolvers: avoids a load-order dependency between the
    // order and agent modules' container registrations (and, since this class is
    // decorated, a constructor parameter typed with a cross-module class needs a real
    // (non `import type`) import for emitDecoratorMetadata, which is exactly the
    // coupling this pattern avoids).
    private orderService(): OrderService {
        return container.resolve<OrderService>(TOKENS.OrderService);
    }

    goOnline = async (agentId: number, region: string, lat: number, lng: number): Promise<void> => {
        await cacheProvider.geoAdd(presenceGeoKey(region), lng, lat, String(agentId));
        await cacheProvider.set(presenceMetaKey(region, agentId), new Date().toISOString(), env.agents.presenceStaleSec);

        // Defensive resync — never trust whatever `presence:load` score was left over
        // from before this agent went offline.
        const activeCount = await this.orderService().countActiveDeliveriesForAgent(agentId, region);
        await cacheProvider.zAdd(presenceLoadKey(region), activeCount, String(agentId));
    };

    ping = async (agentId: number, region: string, lat: number, lng: number): Promise<void> => {
        const wasOnline = await cacheProvider.exists(presenceMetaKey(region, agentId));
        if (!wasOnline) throw NotOnlineError;

        await cacheProvider.geoAdd(presenceGeoKey(region), lng, lat, String(agentId));
        await cacheProvider.set(presenceMetaKey(region, agentId), new Date().toISOString(), env.agents.presenceStaleSec);

        const activeOrders = await this.orderService().findActiveDeliveriesForAgent(agentId, region);
        const ts = new Date().toISOString();
        for (const order of activeOrders) {
            publishToRoom(`customer:${order.customerId}`, "delivery.position", { orderPublicId: order.publicId, lat, lng, ts });
        }
    };

    goOffline = async (agentId: number, region: string): Promise<void> => {
        const activeCount = await this.orderService().countActiveDeliveriesForAgent(agentId, region);
        if (activeCount > 0) throw AgentInActiveDeliveryError;

        await cacheProvider.zRem(presenceGeoKey(region), String(agentId));
        await cacheProvider.del(presenceMetaKey(region, agentId));
    };

    getLoad = async (region: string, agentId: number): Promise<number> => {
        const score = await cacheProvider.zScore(presenceLoadKey(region), String(agentId));
        return score ?? 0;
    };

    incrementLoad = async (region: string, agentId: number): Promise<void> => {
        await cacheProvider.zIncrBy(presenceLoadKey(region), 1, String(agentId));
    };

    // Floored at 0 — a decrement racing a resync (goOnline) should never push a score
    // negative.
    decrementLoad = async (region: string, agentId: number): Promise<void> => {
        const newScore = await cacheProvider.zIncrBy(presenceLoadKey(region), -1, String(agentId));
        if (newScore < 0) await cacheProvider.zAdd(presenceLoadKey(region), 0, String(agentId));
    };
}
