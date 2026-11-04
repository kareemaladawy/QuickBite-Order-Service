import { OrderEventType } from "./event-types";

export interface OutboxEventInput {
    aggregateType: string;
    aggregateId: string;
    eventType: OrderEventType;
    payload: unknown;
}

export interface OutboxEventRow {
    id: number;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    eventId: string;
    payload: unknown;
    createdAt: Date;
    dispatchedAt: Date | null;
    attempts: number;
    lastError: string | null;
}

export interface OutboxEventEnvelope {
    eventId: string;
    eventType: string;
    occurredAt: string;
    payload: unknown;
}

// Mirrors core-service's lib/events/outbox.repo.ts OutboxFailure — one bulk UPDATE
// per drain tick instead of one query per failed event.
export interface OutboxFailure {
    id: number;
    error: string;
}
