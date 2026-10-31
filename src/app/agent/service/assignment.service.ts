import { inject, injectable } from "tsyringe";
import { container } from "../../../lib/di/container";
import { TOKENS } from "../../../lib/di/tokens";
import { env } from "../../../lib/config/env";
import { db } from "../../../lib/knex/knex";
import { logger } from "../../../lib/logger/logger";
import { cacheProvider } from "../../../lib/cache/init";
import { publishToRoom } from "../../../lib/websocket/publish";
import type { OrderService } from "../../order/service/order.service";
import { OrderStatus, PaymentMethod } from "../../order/enums";
import { Order } from "../../order/entity/order.entity";
import { PresenceService } from "./presence.service";
import { buildDeliveryTaskDTO } from "../task-summary";
import { offerKey, offeredSetKey, presenceGeoKey, presenceLoadKey, presenceMetaKey, winnerKey } from "../redis-keys";
import { AssignmentCandidate } from "../types";
import {
    AgentAtCapacityError,
    MaxReassignmentAttemptsReachedError,
    OfferAlreadyTakenError,
    OfferExpiredError,
    OrderAlreadyAssignedError,
    OrderNotReadyError,
} from "../errors";
import { toMs } from "../../../pkg/utils/time";

// A short TTL purely to serialize the race between simultaneous `accept` calls — not a
// durable lock (agents.md §4).
const WINNER_LOCK_TTL_SEC = 10;

@injectable()
export class AssignmentService {
    constructor(@inject(TOKENS.PresenceService) private readonly presenceService: PresenceService) { }

    // Resolved lazily — cross-module (order.service.ts resolves this module's services
    // the same way); see presence.service.ts's comment for the full reasoning.
    private orderService(): OrderService {
        return container.resolve<OrderService>(TOKENS.OrderService);
    }

    // The low-latency fast path, invoked once in-process right after an order becomes
    // `ready` (order.service.ts's applyStatusTransition hook). Never touches
    // reassignment_attempts (agents.md §9).
    tryAssign = async (order: Order): Promise<void> => {
        await this.broadcast(order);
    };

    // The assignment-sweep worker's per-order check (agents.md §3.5): skip silently if
    // this `ready` order still has a live broadcast in flight (lib/jobs must never
    // reach into this module's Redis keys directly — CLAUDE.md §3 layering — so the
    // check lives here, not in the worker).
    tickSweepCandidate = async (order: Order): Promise<void> => {
        const stillOffered = await cacheProvider.exists(offeredSetKey(order.region, order.id));
        if (stillOffered) return;

        try {
            await this.reassign(order);
        } catch (err) {
            if (err === MaxReassignmentAttemptsReachedError) {
                logger.warn("assignment sweep: max reassignment attempts reached", { orderId: order.id, region: order.region });
                publishToRoom("admin", "assignment.exhausted", { orderPublicId: order.publicId });
                return;
            }
            throw err;
        }
    };

    // Admin-triggered, or the sweep worker once a broadcast fully empties out
    // (agents.md §5, §3.5). Always bumps reassignment_attempts — this is what
    // distinguishes a reassignment from the initial broadcast.
    reassign = async (order: Order): Promise<Order> => {
        if (order.reassignmentAttempts >= env.assignment.maxReassignmentAttempts) {
            throw MaxReassignmentAttemptsReachedError;
        }

        const conn = db(order.region);
        const updated = await this.orderService().bumpReassignmentAttempts(order, conn);
        await this.broadcast(updated);
        return updated;
    };

    // Admin manual override — skips the broadcast/accept flow entirely and commits
    // directly (agents.md §3 "Algorithm (manual)").
    assignManually = async (order: Order, agentId: number): Promise<Order> => {
        if (order.status !== OrderStatus.READY) throw OrderAlreadyAssignedError;

        const load = await this.presenceService.getLoad(order.region, agentId);
        if (load >= env.agents.maxConcurrentOrders) throw AgentAtCapacityError;

        const updated = await this.commitAssignment(order, agentId);
        await this.notifyAssigned(updated, agentId);
        return updated;
    };

    // First-to-accept wins (agents.md §4). Throws OfferExpiredError /
    // OfferAlreadyTakenError / AgentAtCapacityError / OrderNotReadyError as documented.
    acceptOffer = async (order: Order, agentId: number): Promise<Order> => {
        const hasOffer = await cacheProvider.exists(offerKey(order.region, order.id, agentId));
        if (!hasOffer) throw OfferExpiredError;

        const won = await cacheProvider.trySet(winnerKey(order.region, order.id), String(agentId), WINNER_LOCK_TTL_SEC);
        if (!won) throw OfferAlreadyTakenError;

        // Defensive — should already hold given the offer just existed, but the order
        // could theoretically have moved on (e.g. an admin force-assigned it) between
        // the broadcast and this accept.
        if (order.status !== OrderStatus.READY) throw OrderNotReadyError;
        const load = await this.presenceService.getLoad(order.region, agentId);
        if (load >= env.agents.maxConcurrentOrders) throw AgentAtCapacityError;

        const updated = await this.commitAssignment(order, agentId);
        await this.tearDownOffers(order.region, order.id, order.publicId, agentId);
        await this.notifyAssigned(updated, agentId);
        return updated;
    };

    // Deletes the caller's own offer only — no inline retry. The sweep worker picks the
    // order back up once the whole broadcast has emptied out (agents.md §4).
    declineOffer = async (order: Order, agentId: number): Promise<void> => {
        await cacheProvider.del(offerKey(order.region, order.id, agentId));
    };

    private commitAssignment = async (order: Order, agentId: number): Promise<Order> => {
        const conn = db(order.region);
        const trx = await conn.transaction();
        let updated: Order;
        try {
            updated = await this.orderService().assignAgent(order, agentId, trx);
            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }
        await this.presenceService.incrementLoad(order.region, agentId);
        return updated;
    };

    private notifyAssigned = async (order: Order, agentId: number): Promise<void> => {
        const task = await buildDeliveryTaskDTO(order, this.orderService());
        publishToRoom(`agent:${agentId}`, "task.assigned", task);
        const payload = { orderPublicId: order.publicId, status: order.status, ts: order.updatedAt.toISOString() };
        publishToRoom(`customer:${order.customerId}`, "delivery.status_changed", payload);
        publishToRoom(`branch:${order.branchId}`, "delivery.status_changed", payload);
    };

    private tearDownOffers = async (region: string, orderId: number, orderPublicId: string, winnerAgentId: number): Promise<void> => {
        const offered = await cacheProvider.sMembers(offeredSetKey(region, orderId));
        if (offered.length > 0) {
            const pipeline = cacheProvider.pipeline();
            for (const idStr of offered) pipeline.del(offerKey(region, orderId, Number(idStr)));
            pipeline.del(offeredSetKey(region, orderId));
            await pipeline.exec();
        }
        for (const idStr of offered) {
            if (Number(idStr) === winnerAgentId) continue;
            publishToRoom(`agent:${idStr}`, "task.offer_lost", { orderPublicId });
        }
    };

    // The broadcast core — shared by tryAssign (fast path) and reassign (admin/sweep
    // retry). Silently no-ops if the order is no longer `ready` (agents.md §3 step 2).
    private broadcast = async (order: Order): Promise<void> => {
        if (order.status !== OrderStatus.READY) return;

        const candidates = await this.findCandidates(order.region, order.id, order.pickupLat, order.pickupLng);

        if (candidates.length === 0) {
            publishToRoom("admin", "assignment.unassigned_alert", { orderPublicId: order.publicId });
            logger.warn("assignment broadcast found no eligible agents", { orderId: order.id, region: order.region });
            return;
        }

        const ttlSec = env.assignment.acceptTimeoutSec;
        const agentIds = candidates.map((c) => c.agentId);

        const pipeline = cacheProvider.pipeline();
        for (const agentId of agentIds) {
            pipeline.setEx(offerKey(order.region, order.id, agentId), "1", ttlSec);
        }
        pipeline.sAdd(offeredSetKey(order.region, order.id), ...agentIds.map(String));
        pipeline.expire(offeredSetKey(order.region, order.id), ttlSec);
        await pipeline.exec();

        const expiresAt = new Date(Date.now() + toMs(ttlSec, 's')).toISOString();
        const offerPayload = {
            orderPublicId: order.publicId,
            pickup: { lat: order.pickupLat, lng: order.pickupLng, addressText: order.pickupAddressTextSnapshot, branchName: order.branchNameSnapshot },
            dropoff: { lat: order.deliveryLat, lng: order.deliveryLng, addressText: order.deliveryAddressTextSnapshot },
            payment: {
                method: order.paymentMethod,
                currency: order.currency,
                amountDue: order.paymentMethod === PaymentMethod.COD ? order.total : 0,
            },
            expiresAt,
        };
        for (const agentId of agentIds) {
            publishToRoom(`agent:${agentId}`, "task.offered", offerPayload);
        }
    };

    // GEOSEARCH around the branch, filtered by staleness/capacity/already-offered, then
    // re-ranked by distance+load (agents.md §3 step 3).
    private findCandidates = async (
        region: string,
        orderId: number,
        branchLat: number,
        branchLng: number,
    ): Promise<AssignmentCandidate[]> => {
        const raw = await cacheProvider.geoSearchByRadius(
            presenceGeoKey(region),
            branchLng,
            branchLat,
            env.assignment.radiusMeters,
            env.assignment.candidatePool,
        );

        const scored: AssignmentCandidate[] = [];

        for (const { member: idStr, distanceMeters } of raw) {
            const agentId = Number(idStr);

            const isFresh = await cacheProvider.exists(presenceMetaKey(region, agentId));
            if (!isFresh) {
                // Lazy eviction — the agent went stale without an explicit offline call.
                await cacheProvider.zRem(presenceGeoKey(region), idStr);
                continue;
            }

            const alreadyOffered = await cacheProvider.sIsMember(offeredSetKey(region, orderId), idStr);
            if (alreadyOffered) continue;

            const loadScore = await cacheProvider.zScore(presenceLoadKey(region), idStr);
            const loadCount = loadScore ?? 0;
            if (loadCount >= env.agents.maxConcurrentOrders) continue;

            scored.push({
                agentId,
                distanceMeters,
                loadCount,
                score: distanceMeters + loadCount * env.assignment.loadPenaltyMeters,
            });
        }

        scored.sort((a, b) => a.score - b.score);
        return scored.slice(0, env.assignment.broadcastSize);
    };
}
