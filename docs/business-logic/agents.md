# Business Logic — Agents Module

Owner module: `app/agent/`

Covers agent presence (online/offline/ping), broadcast/manual delivery assignment with an accept/reject flow (no auto-assignment — see §3), a cron sweep worker that keeps retrying assignment for `ready` orders (§3.5), the delivery-status endpoints an agent drives, the agent's task list, and earnings reads. There is no separate Deliveries module and no `deliveries` table — a delivery is just the agent-handling phase of an order's own lifecycle (`orders.status`, `orders.delivery_agent_id`), and this module owns all of it end to end.

---

## 1. Presence model — Redis only, no Postgres table

There is **no `agent_presence` table**. Presence is a ~5-minute-TTL signal, not a durable record, so it lives entirely in Redis:

| Key                                | Purpose                                          | Updated by                          |
| ----------------------------------- | ------------------------------------------------ | ----------------------------------- |
| `presence:geo:<region>` (geo set)  | All online agents' coordinates (`GEOADD`/`GEOSEARCH`) | online/offline/ping endpoints       |
| `presence:load:<region>` (sorted set, score = in-flight order count) | How many **non-delivered** orders (`assigned`/`picked`) an agent currently holds | assignment/delivery service |
| `presence:meta:<region>:<agentId>` | `lastSeenAt`                                      | online/offline/ping                 |

Staleness cutoff is **~5 minutes** (`PRESENCE_STALE_SEC=300`). A candidate whose `lastSeenAt` is older than that is treated as offline for assignment purposes even if its Redis key hasn't technically expired yet. There is no reconciliation job and no Postgres fallback to keep in sync — Redis is the only source of truth, which is exactly why there's no table for it.

`presence:load:<region>` replaces the old boolean `presence:busy:<region>` set: agents are no longer single-order-at-a-time. An agent may hold up to `AGENT_MAX_CONCURRENT_ORDERS` (default 3) in-flight orders simultaneously. The score is incremented on offer-acceptance / manual-assign and decremented on `delivered`, cancellation-while-assigned, or reassignment — always via `ZINCRBY`, which is atomic.

---

## 2. Endpoints

| Endpoint                                     | Auth        |
| --------------------------------------------- | ----------- |
| `POST /agents/presence/online`                | agent       |
| `POST /agents/presence/offline`               | agent       |
| `POST /agents/presence/ping`                  | agent       |
| `GET /agents/tasks?status=`                   | agent       |
| `GET /agents/earnings?from=&to=`               | agent       |
| `POST /orders/{orderId}/delivery/assign`      | system_admin (or system, broadcast) |
| `POST /orders/{orderId}/delivery/reassign`    | system_admin |
| `POST /orders/{orderId}/delivery/accept`      | agent (offer holder) |
| `POST /orders/{orderId}/delivery/decline`     | agent (offer holder) |
| `PATCH /orders/{orderId}/delivery/status`     | agent (assigned agent) |

All authentication via the standard `authenticate` guard. The agent's `userId` is taken from the JWT.

### POST /agents/presence/online

Body:
```ts
class PresenceOnlineRequestDTO {
  lat: number;
  lng: number;
}
```

- `GEOADD presence:geo:<region> lng lat agentId`.
- `SET presence:meta:<region>:<agentId> {lastSeenAt} EX <PRESENCE_STALE_SEC>`.
- Reset `presence:load:<region>` for this agent to the **actual** count of `orders WHERE delivery_agent_id = agentId AND status IN ('assigned','picked')` (defensive resync — don't trust whatever score was left in Redis from before the agent went offline).
- Response: `{ ok: true }`.

### POST /agents/presence/offline

- `ZREM presence:geo:<region> agentId`; delete the meta key.
- If the agent is the current `delivery_agent_id` on **any** order that isn't yet `delivered` → 409 `AgentInActiveDelivery`.
- Response: `{ ok: true }`.

### POST /agents/presence/ping

Body: same as online.

- Refreshes `presence:geo` (`GEOADD`, idempotent) and `presence:meta` (`lastSeenAt`, TTL reset). No-op + 409 `NotOnline` if the agent never went online.
- If the agent is the current `delivery_agent_id` on an active order, the ping's lat/lng is also fanned out to `customer:<id>:delivery.position`.

Frequency: clients ping every 30s while moving.

---

## 3. Assignment — broadcast + accept/reject (no auto-assignment)

There is **no automatic single-agent assignment** anymore. An assignment attempt always **broadcasts a simultaneous offer to up to `ASSIGNMENT_BROADCAST_SIZE` (default 5) candidate agents** and lets the first one to accept win; this is what replaces both the old "insert a `deliveries` row" design and the earlier sequential nearest-agent-only offer. All offer state is Redis-only — nothing is written to `orders` until an agent accepts or an admin force-assigns.

### POST /orders/{orderId}/delivery/assign

Two callers:
1. **System**: triggered when `orders.status` becomes `ready` (hook registered in the Orders module — see §9), and retried by the sweep worker (§3.5) for any `ready` order still missing capacity.
2. **Admin** (manual, `agentId` in the body): skips the broadcast entirely and commits directly (see §3.3).

### Algorithm (broadcast)

1. Resolve region and the order's branch `lat`/`lng` (via the core-client branch cache).
2. Validate the order is `ready`. Unlike the old design, `delivery_agent_id` is **not** a single-slot guard anymore — re-broadcasting a `ready` order whose current agent count is below what's needed is expected (it's how the sweep worker keeps trying). Skip if the order is no longer `ready` (already fully picked up, cancelled, etc).
3. **Find and rank candidates**:
   - `GEOSEARCH presence:geo:<region> FROMLONLAT <branchLng> <branchLat> BYRADIUS <ASSIGNMENT_RADIUS_METERS> m ASC COUNT <ASSIGNMENT_CANDIDATE_POOL>` (default pool 20) — nearest-first, around the **branch's** location (not the agent's).
   - Drop any candidate whose `presence:meta:<region>:<agentId>.lastSeenAt` is older than the ~5-minute cutoff.
   - Drop any candidate whose `presence:load:<region>` score is already `>= AGENT_MAX_CONCURRENT_ORDERS` (default 3) — an agent at capacity is not offered more work.
   - Drop any candidate who already holds an outstanding offer for this specific order (prevents re-offering the same order to someone who just declined it in the same sweep tick).
   - Score survivors by a weighted combination of **distance** (from `GEOSEARCH`, ascending) and **current load** (from `presence:load`, ascending — agents doing less are preferred, which is the "number of orders" fairness criterion): `score = distanceMeters + (loadCount × LOAD_PENALTY_METERS)` (`LOAD_PENALTY_METERS` env-configurable, default 1500 — roughly "one extra in-flight order costs as much as 1.5km of extra distance").
   - Take the `ASSIGNMENT_BROADCAST_SIZE` lowest-scoring candidates.
4. If zero candidates → publish `assignment.unassigned_alert` to the admin WS channel; the order stays `ready` for the next sweep tick or manual assignment.
5. Write one offer key per candidate: `SET assignment:offer:<region>:<orderId>:<agentId> 1 EX AGENT_ACCEPT_TIMEOUT_SEC` (default 30s), plus a tracking set `SADD assignment:offered:<region>:<orderId> <agentId>...` with the same TTL so the service can enumerate who was offered.
6. Push WS `agent:<id>:task.offered` **simultaneously** to all broadcast candidates, with the task summary and `expiresAt`.
7. Offers that go unaccepted (declined or timed out) are simply left to expire — no retry-on-decline inline. The sweep worker (§3.5) is what re-broadcasts a `ready` order that still needs an agent; there is no in-request chained retry anymore.

### Algorithm (manual)

- Admin specifies `agentId` directly — no broadcast, no candidate scoring, but the same capacity check applies: 409 `AgentAtCapacity` if that agent's `presence:load` is already `>= AGENT_MAX_CONCURRENT_ORDERS`. Otherwise, in one trx: `orders.delivery_agent_id = agentId`, `status = 'assigned'`, `assigned_at = NOW()`. `ZINCRBY presence:load:<region> 1 agentId`. Publishes `agent:<id>:task.assigned` and `customer:<id>` / `branch:<id>` `delivery.status_changed`.

### Idempotency

- `orders.delivery_agent_id IS NOT NULL` guards against re-broadcasting an order that already has a committed agent (the service checks `status != 'ready'` before broadcasting, per step 2). Attempting to broadcast an already-`assigned` order returns 409 `OrderAlreadyAssigned`.

---

## 4. POST /orders/{orderId}/delivery/accept · /decline

**Accept** — first-to-accept wins, enforced atomically so two agents racing on the same broadcast can't both win:
1. Verify an unexpired `assignment:offer:<region>:<orderId>:<agentId>` key exists for the caller. Otherwise 403 / 409 `OfferExpired`.
2. Atomically (Lua script, or `SET assignment:winner:<region>:<orderId> agentId NX EX <short TTL>`) claim the win. If the `SET ... NX` fails, another agent already won this broadcast → 409 `OfferAlreadyTaken`.
3. Having won: in one trx, verify the order is still `ready` (defensive — it should be) and the agent is still under `AGENT_MAX_CONCURRENT_ORDERS`, then set `orders.delivery_agent_id = agentId`, `status = 'assigned'`, `assigned_at = NOW()`. `ZINCRBY presence:load:<region> 1 agentId`.
4. Delete this order's remaining `assignment:offer:<region>:<orderId>:*` keys and the `assignment:offered:<region>:<orderId>` tracking set; for every other agent that was offered, push WS `agent:<id>:task.offer_lost` so their client removes the stale offer card.
5. Publish `agent:<id>:task.assigned` (to the winner) and `customer:<id>` / `branch:<id>` `delivery.status_changed`.

**Decline**: delete the caller's own `assignment:offer:<region>:<orderId>:<agentId>` key. No reassignment is triggered inline — the remaining broadcast candidates (if any) are still live, and if the broadcast fully empties out, the sweep worker (§3.5) picks the order back up on its next tick. `orders.reassignment_attempts` is **not** incremented by a decline or a timeout; it's only incremented when the sweep worker issues a brand-new broadcast for a still-unassigned order (§5).

---

### 3.5 Sweep worker — `lib/jobs/assignment-sweep.worker.ts`

The real-time path (§3's broadcast on `orders.status → 'ready'`, §9) covers the common case, but a broadcast can fully empty out (all 5 candidates declined or timed out) with nobody left to retry it inline — nothing in the request/response cycle owns that retry. A small **cron-like worker**, ticking every **15s** (`ASSIGNMENT_SWEEP_CRON_SEC=15`) via `setInterval` — the same scheduling approach as the Phase 5 archival worker, so no new scheduling library is introduced — (one instance per region process, guarded by a Redis lock `assignment:sweep:<region>:lock` with a short TTL so overlapping ticks across workers don't double-broadcast), is the thing that actually keeps trying:

1. Query `orders WHERE status = 'ready'` on the region's shard connection (backed by the existing `idx_orders_status_created_at` partial index — see `database-design.md` §4).
2. For each, check whether it currently has **zero outstanding offers** (`assignment:offered:<region>:<orderId>` doesn't exist / is empty) — if it still has live offers from a broadcast that hasn't expired yet, skip it this tick.
3. For orders with no live offers: re-run §3's broadcast algorithm. If this is not the order's first broadcast, increment `orders.reassignment_attempts`; stop broadcasting (and alert admins, per §3 step 4) once `orders.reassignment_attempts >= MAX_REASSIGNMENT_ATTEMPTS`.
4. This worker is the **only** place `reassignment_attempts` increments for the auto path — accept/decline/expiry never touch that counter (see §4).

This is the "always try to assign ready-for-delivery orders" loop: the sweep worker is the actual retry mechanism now, and the initial broadcast on `ready` is just the low-latency fast path so most orders never have to wait for a sweep tick. Every broadcast this worker issues is still delivered to agents over WS in real time, same as the initial one — the cron only decides *when* to broadcast, not how.

---

## 5. POST /orders/{orderId}/delivery/reassign

- Admin-triggered, or automatic via the sweep worker (§3.5) once a broadcast fully empties out with the order still `ready`. Increments `orders.reassignment_attempts`, re-runs §3's broadcast algorithm (it does **not** need to clear `orders.delivery_agent_id` first — under the multi-order model that column is only ever set by a winning `accept`/manual-assign, never speculatively).
- Limit: `MAX_REASSIGNMENT_ATTEMPTS` total per order (checked against the counter directly — no chain to traverse). Beyond that → 409 `MaxReassignmentAttemptsReached` + admin alert.

---

## 6. PATCH /orders/{orderId}/delivery/status

Single endpoint for the assigned agent's remaining actions. Body: `{ status }`. Allowed transitions (reuses the shared order-status machine — see `orders.md` §7):

| Current  | Target     | Actor   |
| -------- | ---------- | ------- |
| assigned | picked     | agent (must be `orders.delivery_agent_id`) |
| picked   | delivered  | agent (must be `orders.delivery_agent_id`) |

Anything else → 409 `InvalidStatusTransition`.

### Side effects

- `picked` → stamp `picked_at`; WS `customer:<id>` / `branch:<id>` `delivery.status_changed`.
- `delivered` → stamp `delivered_at`; **money settlement** (see §7); WS to all parties.

---

## 7. Settlement on `delivered`

In the same DB trx as the status flip:

1. Insert `agent_earnings(agent_id, order_id, order_created_at, amount, currency)` — `earning = floor(order.delivery_fee × AGENT_EARNINGS_SHARE_PCT / 100)`, i.e. a flat **80%** of the order's delivery fee (`AGENT_EARNINGS_SHARE_PCT=80`, env-configurable; the platform keeps the remaining 20%). Unique on `order_id` makes this idempotent.
2. For online: ensure the `transactions(type='charge', status='succeeded')` exists (must, by design — written at capture, long before `delivered`).
3. Call **`finance.service.recordDeliverySettlement(orderId, trx)`** (Restaurant Finance module), passing through the trx this service already owns. That call inserts the `transactions(type='cod_collection', status='succeeded')` row for COD orders (there is no pending row to flip — placement never wrote one), computes commission, writes the `transactions(type='commission')` row, and credits `restaurant_balances.balance` — **all of this is Restaurant Finance's responsibility, not this module's**; see `restaurant-finance.md` §7.
4. `ZINCRBY presence:load:<region> -1 agentId` (floor at 0).
5. (No outbound events; clients are notified via WebSocket.)

All in one trx, owned by this module's `delivery.service`, passed into `finance.service.recordDeliverySettlement`. Failure rolls back the whole thing — no partial settlement.

---

## 8. Cancellation while assigned

- If the order is cancelled while `status` is `assigned` (agent not yet `picked`):
  - Clear `orders.delivery_agent_id`; `ZINCRBY presence:load:<region> -1 agentId` (floor at 0).
  - WS to agent (`task.cancelled`).
- If cancelled after `picked`: forbidden by the order-status validator (food already with the agent) — handled via a future "issue" flow, not in scope.

---

## 9. Cross-module hook

`order.service.updateStatus` for target `ready` enqueues `assignment.service.tryAssign(orderId)` in-process after commit (a service call into this module, not a repo reach-through) — this is the low-latency fast path. The sweep worker (§3.5) is the backstop that keeps retrying on a fixed cadence regardless of whether this hook ever fired or its broadcast was fully declined/timed out.

---

## 10. GET /agents/tasks?status=

- Lists orders where `delivery_agent_id = callingAgentId`, optionally filtered by status (`assigned|picked|delivered`).
- Cursor pagination by `assigned_at DESC`.
- Response: `DeliveryTaskResponseDTO[]` with order summary (subtotal, item count) + customer drop-off summary.
- Backed by `idx_orders_delivery_agent_id_status` (on `orders`, not a `deliveries` table).
- Cached `withCache(5)` per-user; invalidated on every status transition for the agent.

---

## 11. GET /agents/earnings?from=&to=

- Sums and lists `agent_earnings` rows in the date range.
- Defaults: `from = first day of current month`, `to = NOW()`.
- Returns:
  ```ts
  class AgentEarningsResponseDTO {
    range: { from: string; to: string };
    totals: { count: number; sum: number; currency: string };
    items: Array<{
      orderPublicId: string;
      amount: number;
      currency: string;
      earnedAt: string;
    }>;
    nextCursor: string | null;
  }
  ```
- Backed by `idx_agent_earnings_agent_earned_at`.
- For older ranges (prior years) the query is routed to the archive cluster (Phase 5).

---

## 12. Invariants

1. `presence:geo:<region>` contains an agent ⇔ the agent is online; there's no second source to drift out of sync with, since Postgres holds nothing.
2. `presence:load:<region>` score for an agent == `COUNT(orders WHERE delivery_agent_id = agentId AND status IN ('assigned','picked'))`, and is always `≤ AGENT_MAX_CONCURRENT_ORDERS`. No candidate above that cap is ever offered a new broadcast.
3. An order has at most one **committed** agent at a time (`orders.delivery_agent_id`), but may have **multiple simultaneous outstanding offers** while a broadcast is live — that's the point of the broadcast. Once one offer is accepted, every other offer for that order is torn down (§4 step 4); a committed `delivery_agent_id` and a live broadcast for the same order never coexist.
4. `orders.status = 'delivered'` implies `agent_earnings(order_id)` exists and `restaurant_balances.balance` was incremented atomically (same trx).
5. `orders.reassignment_attempts ≤ MAX_REASSIGNMENT_ATTEMPTS`.
6. Going offline while `delivery_agent_id` points at any non-`delivered` order (there may be more than one now) is forbidden.
7. No agent is ever assigned (manually, by broadcast-accept, or by reassignment) while already at `AGENT_MAX_CONCURRENT_ORDERS`.

---

## 13. RBAC

| Action                                               | Role                                              |
| ----------------------------------------------------- | -------------------------------------------------- |
| `POST /orders/{id}/delivery/assign` (manual)          | `system_admin` (permission `deliveries:assign`)    |
| `POST /orders/{id}/delivery/reassign`                 | `system_admin` (permission `deliveries:assign`)    |
| `POST /orders/{id}/delivery/accept` · `/decline`      | the agent holding the offer                        |
| `PATCH /orders/{id}/delivery/status`                  | the assigned `delivery_agent` (`orders.delivery_agent_id`) |
| `POST /agents/presence/*`, `GET /agents/tasks`, `GET /agents/earnings` | `delivery_agent` role, self only |

Agents are not RBAC-permissioned for their own tasks — ownership check happens in the service, same pattern as elsewhere in this service.

---

## 14. Performance notes

- Assignment's proximity scan is **Redis-only** — `GEOSEARCH` around the branch's lat/lng (bounded by `ASSIGNMENT_CANDIDATE_POOL`), filtered by last-seen cutoff and capacity, then re-ranked in-process by the distance+load score. There is no Postgres fallback to maintain (and nothing to fall back to without an `agent_presence` table).
- `idx_orders_delivery_agent_id_status` covers both the agent task list and (now) the sweep worker's per-order "any live offers?" short-circuit check against Redis before touching Postgres at all.
- Offers live entirely in Redis with a TTL — no cleanup job needed; an expired key is simply gone. The winner-lock key (`assignment:winner:<region>:<orderId>`) only needs a TTL of a few seconds — it exists purely to serialize the race between simultaneous `accept` calls.
- The sweep worker's query (`WHERE status = 'ready'`, on the region's shard connection) is bounded — `ready` orders are a small, transient slice of the hot table — and the per-order Redis offer check keeps it from re-broadcasting orders that already have a live broadcast in flight.

---

## 15. WebSocket events emitted

| Event                      | Channel                        | Payload (response DTO)                              |
| --------------------------- | ------------------------------- | ---------------------------------------------------- |
| `task.offered`              | `agent:<id>`                    | `{ orderPublicId, pickup, dropoff, expiresAt }` — sent to all broadcast candidates (up to `ASSIGNMENT_BROADCAST_SIZE`) at once |
| `task.offer_lost`            | `agent:<id>`                    | `{ orderPublicId }` — sent to every candidate who didn't win, right after another agent accepts |
| `task.assigned`              | `agent:<id>`                    | `DeliveryTaskResponseDTO`                             |
| `task.cancelled`              | `agent:<id>`                    | `{ orderPublicId, reason }`                           |
| `delivery.status_changed`    | `customer:<id>`, `branch:<id>`  | `{ orderPublicId, status, ts, agent: { id, name, phone? } }` |
| `delivery.position`          | `customer:<id>`                 | `{ orderPublicId, lat, lng, ts }` (from ping)          |
