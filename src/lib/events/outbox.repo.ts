import type { Knex } from "knex";
import { v4 as uuidv4 } from "uuid";
import { OutboxEventInput, OutboxEventRow, OutboxFailure } from "./types";

const EVENTS_OUTBOX_COLUMNS = [
    "id",
    "aggregate_type",
    "aggregate_id",
    "event_type",
    "event_id",
    "payload",
    "created_at",
    "dispatched_at",
    "attempts",
    "last_error",
];

function toEntity(row: Record<string, unknown>): OutboxEventRow {
    return {
        id: Number(row.id),
        aggregateType: row.aggregate_type as string,
        aggregateId: row.aggregate_id as string,
        eventType: row.event_type as string,
        eventId: row.event_id as string,
        payload: row.payload,
        createdAt: row.created_at as Date,
        dispatchedAt: (row.dispatched_at as Date | null) ?? null,
        attempts: Number(row.attempts),
        lastError: (row.last_error as string | null) ?? null,
    };
}

// Called by domain services inside the same DB transaction as the mutation they describe.
export async function insertOutboxEvent(conn: Knex, data: OutboxEventInput): Promise<void> {
    await conn("events_outbox").insert({
        aggregate_type: data.aggregateType,
        aggregate_id: data.aggregateId,
        event_type: data.eventType,
        event_id: uuidv4(),
        payload: JSON.stringify(data.payload),
    });
}

// Row-locks a batch for the draining worker; SKIP LOCKED makes concurrent worker
// instances (across regions and processes) safe.
export async function claimUndispatchedEvents(transaction: Knex.Transaction, limit: number): Promise<OutboxEventRow[]> {
    const rows = await transaction("events_outbox")
        .whereNull("dispatched_at")
        .orderBy("created_at", "asc")
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .select(EVENTS_OUTBOX_COLUMNS);

    return rows.map(toEntity);
}

export async function markEventsDispatched(transaction: Knex.Transaction, ids: number[]): Promise<void> {
    if (ids.length === 0) return;

    await transaction("events_outbox")
        .whereIn("id", ids)
        .update({ dispatched_at: new Date() });
}

// One UPDATE ... FROM (VALUES ...) for the whole batch instead of one query per failed event.
export async function markEventsFailed(transaction: Knex.Transaction, failures: OutboxFailure[]): Promise<void> {
    if (failures.length === 0) return;

    const values = failures.map(() => `(?::bigint, ?::text)`).join(", ");
    const bindings = failures.flatMap((f) => [f.id, f.error.slice(0, 2000)]);

    await transaction.raw(
        `
        UPDATE events_outbox eo
        SET attempts = eo.attempts + 1,
            last_error = v.last_error
        FROM (VALUES ${values}) AS v(id, last_error)
        WHERE eo.id = v.id
        `,
        bindings,
    );
}
