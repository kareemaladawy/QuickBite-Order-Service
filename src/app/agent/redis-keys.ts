// Shared Redis key builders for presence.service.ts and assignment.service.ts
// (agents.md §1, §3) — kept in one place so the two services can never drift on key
// shape. Keyed by the order's internal bigint id, not its public_id: this is
// server-side bookkeeping, never exposed to a client.

export function presenceGeoKey(region: string): string {
    return `presence:geo:${region}`;
}

export function presenceLoadKey(region: string): string {
    return `presence:load:${region}`;
}

export function presenceMetaKey(region: string, agentId: number): string {
    return `presence:meta:${region}:${agentId}`;
}

export function offerKey(region: string, orderId: number, agentId: number): string {
    return `assignment:offer:${region}:${orderId}:${agentId}`;
}

export function offeredSetKey(region: string, orderId: number): string {
    return `assignment:offered:${region}:${orderId}`;
}

export function winnerKey(region: string, orderId: number): string {
    return `assignment:winner:${region}:${orderId}`;
}

export function sweepLockKey(region: string): string {
    return `assignment:sweep:${region}:lock`;
}
