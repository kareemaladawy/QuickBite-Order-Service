import { db } from "../knex/knex";
import { env } from "../config/env";
import { logger } from "../logger/logger";
import { messageBroker } from "../messaging/init";
import { claimUndispatchedEvents, markEventsDispatched, markEventsFailed } from "./outbox.repo";
import { OutboxEventEnvelope } from "./types";

// Drains one region's events_outbox into the `order.events` exchange — mirrors
// core-service's lib/events/ drain (src/worker.ts there), adapted to this service's
// per-region sharding and setInterval-based jobs (no croner here). The whole batch
// runs in one trx: rows are locked (FOR UPDATE SKIP LOCKED) until commit, so N drain
// ticks/processes per region can run concurrently without double-publishing the same
// row.
//
// A publish failure means the broker is sick, not that this one event is bad — mark
// it failed and stop working through the rest of the batch rather than hammering a
// down broker once per row. The remaining claimed-but-untouched rows are simply left
// alone (dispatched_at still null); committing releases their row locks so the next
// tick (here or on another process) picks them up again.
export async function drainOutboxForRegion(region: string): Promise<number> {
    const transaction = await db(region).transaction();

    try {
        const events = await claimUndispatchedEvents(transaction, env.outbox.batchSize);
        if (events.length === 0) {
            await transaction.commit();
            return 0;
        }

        const dispatchedIds: number[] = [];

        for (const event of events) {
            const envelope: OutboxEventEnvelope = {
                eventId: event.eventId,
                eventType: event.eventType,
                occurredAt: event.createdAt.toISOString(),
                payload: event.payload,
            };

            try {
                await messageBroker.publish(env.outbox.exchange, event.eventType, Buffer.from(JSON.stringify(envelope)));
                dispatchedIds.push(event.id);
            } catch (err) {
                const message = (err as Error).message;
                logger.error("outbox drain: publish failed — broker likely unreachable, bailing out of batch", {
                    region,
                    eventId: event.eventId,
                    eventType: event.eventType,
                    error: message,
                });
                await markEventsFailed(transaction, [{ id: event.id, error: message }]);
                break;
            }
        }

        await markEventsDispatched(transaction, dispatchedIds);
        await transaction.commit();
        return dispatchedIds.length;
    } catch (err) {
        await transaction.rollback();
        throw err;
    }
}
