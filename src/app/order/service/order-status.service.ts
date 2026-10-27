import { OrderActorType, OrderStatus } from "../enums";
import { invalidStatusTransitionError } from "../errors";
import { OrderActorContext } from "../types";

// docs/business-logic/orders.md §1 "Allowed transitions matrix"
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
    [OrderStatus.PENDING_PAYMENT]: [OrderStatus.PLACED, OrderStatus.CANCELLED],
    [OrderStatus.PLACED]: [OrderStatus.ACCEPTED, OrderStatus.REJECTED, OrderStatus.CANCELLED],
    [OrderStatus.ACCEPTED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
    [OrderStatus.PREPARING]: [OrderStatus.READY, OrderStatus.CANCELLED],
    [OrderStatus.READY]: [OrderStatus.ASSIGNED, OrderStatus.CANCELLED],
    [OrderStatus.ASSIGNED]: [OrderStatus.PICKED, OrderStatus.CANCELLED],
    [OrderStatus.PICKED]: [OrderStatus.DELIVERED],
    [OrderStatus.REJECTED]: [],
    [OrderStatus.DELIVERED]: [],
    [OrderStatus.CANCELLED]: [],
};

// Keyed `${from}->${to}`. "system" covers both the webhook-driven pending_payment->placed
// transition (Phase 2) and the auto-assignment ready->assigned transition (Phase 3) —
// neither is reachable through PATCH /orders/{id}/status in this phase, but the matrix
// stays complete so order-status.service.ts has one source of truth for the whole machine.
const TRANSITION_ACTORS: Record<string, OrderActorContext["type"][]> = {
    "pending_payment->placed": [OrderActorType.SYSTEM],
    "pending_payment->cancelled": [OrderActorType.CUSTOMER, OrderActorType.SYSTEM],
    "placed->accepted": [OrderActorType.RESTAURANT],
    "placed->rejected": [OrderActorType.RESTAURANT],
    "placed->cancelled": [OrderActorType.CUSTOMER, OrderActorType.SYSTEM],
    "accepted->preparing": [OrderActorType.RESTAURANT],
    "accepted->cancelled": [OrderActorType.RESTAURANT, OrderActorType.ADMIN],
    "preparing->ready": [OrderActorType.RESTAURANT],
    "preparing->cancelled": [OrderActorType.RESTAURANT, OrderActorType.ADMIN],
    "ready->assigned": [OrderActorType.SYSTEM],
    "ready->cancelled": [OrderActorType.RESTAURANT, OrderActorType.ADMIN],
    "assigned->picked": [OrderActorType.AGENT],
    "assigned->cancelled": [OrderActorType.ADMIN],
    "picked->delivered": [OrderActorType.AGENT],
};

// snake_case DB column stamped alongside each target status — whitelisted here so the
// repository never interpolates a caller-supplied column name.
export const STATUS_TIMESTAMP_COLUMN: Partial<Record<OrderStatus, string>> = {
    [OrderStatus.ACCEPTED]: "accepted_at",
    [OrderStatus.REJECTED]: "rejected_at",
    [OrderStatus.PREPARING]: "preparing_at",
    [OrderStatus.READY]: "ready_at",
    [OrderStatus.ASSIGNED]: "assigned_at",
    [OrderStatus.PICKED]: "picked_at",
    [OrderStatus.DELIVERED]: "delivered_at",
    [OrderStatus.CANCELLED]: "cancelled_at",
};

const CUSTOMER_CANCEL_WINDOW_MS = 60_000;

export function assertTransition(from: OrderStatus, to: OrderStatus, actor: OrderActorContext): void {
    const allowedTargets = ALLOWED_TRANSITIONS[from] ?? [];
    if (!allowedTargets.includes(to)) {
        throw invalidStatusTransitionError(from, to);
    }

    const allowedActors = TRANSITION_ACTORS[`${from}->${to}`] ?? [];
    if (!allowedActors.includes(actor.type)) {
        throw invalidStatusTransitionError(from, to);
    }

    // Customer cancel window: only while pending_payment/placed, and only within 60s of
    // order creation, and only before the restaurant has accepted.
    if (to === OrderStatus.CANCELLED && actor.type === OrderActorType.CUSTOMER) {
        const withinWindow = Date.now() - actor.orderCreatedAt.getTime() <= CUSTOMER_CANCEL_WINDOW_MS;
        if (actor.acceptedAt || !withinWindow) {
            throw invalidStatusTransitionError(from, to);
        }
    }
}
