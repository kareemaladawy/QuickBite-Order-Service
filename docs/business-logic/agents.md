# Business Logic — Agents Module

Owner module: `app/agent/`

Covers agent presence (online/offline/ping), auto/manual delivery assignment, the delivery-status endpoints an agent drives, the agent's task list, and earnings reads. There is no separate Deliveries module and no `deliveries` table — a delivery is just the agent-handling phase of an order's own lifecycle (`orders.status`, `orders.delivery_agent_id`), and this module owns all of it end to end.

---

## 1. Presence model — Redis only, no Postgres table

There is **no `agent_presence` table**. Presence is a ~5-minute-TTL signal, not a durable record, so it lives entirely in Redis:

| Key                                | Purpose                                          | Updated by                          |
| ----------------------------------- | ------------------------------------------------ | ----------------------------------- |
| `presence:geo:<region>` (geo set)  | All online agents' coordinates (`GEOADD`/`GEOSEARCH`) | online/offline/ping endpoints       |
| `presence:busy:<region>` (set)     | Agents currently handling an order                | assignment/delivery service         |
| `presence:meta:<region>:<agentId>` | `lastSeenAt`                                      | online/offline/ping                 |

Staleness cutoff is **~5 minutes** (`PRESENCE_STALE_SEC=300`). A candidate whose `lastSeenAt` is older than that is treated as offline for assignment purposes even if its Redis key hasn't technically expired yet. There is no reconciliation job and no Postgres fallback to keep in sync — Redis is the only source of truth, which is exactly why there's no table for it.

---

## 2. Endpoints

| Endpoint                                     | Auth        |
| --------------------------------------------- | ----------- |
| `POST /agents/presence/online`                | agent       |
| `POST /agents/presence/offline`               | agent       |
| `POST /agents/presence/ping`                  | agent       |
| `GET /agents/tasks?status=`                   | agent       |
| `GET /agents/earnings?from=&to=`               | agent       |
| `POST /orders/{orderId}/delivery/assign`      | system_admin (or system, auto) |
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
- Remove from `presence:busy:<region>` if present (going online resets state — defensive; an agent shouldn't have been busy while offline).
- Response: `{ ok: true }`.

### POST /agents/presence/offline

- `ZREM presence:geo:<region> agentId`; delete the meta key.
- If the agent is the current `delivery_agent_id` on an order that isn't yet `delivered` → 409 `AgentInActiveDelivery`.
- Response: `{ ok: true }`.

### POST /agents/presence/ping

Body: same as online.

- Refreshes `presence:geo` (`GEOADD`, idempotent) and `presence:meta` (`lastSeenAt`, TTL reset). No-op + 409 `NotOnline` if the agent never went online.
- If the agent is the current `delivery_agent_id` on an active order, the ping's lat/lng is also fanned out to `customer:<id>:delivery.position`.

Frequency: clients ping every 30s while moving.

---

## 3. Assignment — the offer/accept flow

An auto or manual assignment never writes `orders` directly on the first attempt. It creates a **Redis-only offer** and waits for the agent to commit to it; this is what replaces the old "insert a `deliveries` row and let it be rejected/reassigned" design, without needing a table to hold the in-between state.

### POST /orders/{orderId}/delivery/assign

Two callers:
1. **System** (auto): triggered when `orders.status` becomes `ready` (hook registered in the Orders module — see §9).
2. **Admin** (manual, `agentId` in the body): skips the offer step entirely and commits directly (see §3.4).

### Algorithm (auto)

1. Resolve region and the order's branch `lat`/`lng` (via the core-client branch cache).
2. Validate the order is `ready` and `delivery_agent_id IS NULL` (no active assignment). Otherwise 409 `OrderAlreadyAssigned`.
3. **Find candidates**:
   - `GEOSEARCH presence:geo:<region> FROMLONLAT <branchLng> <branchLat> BYRADIUS <ASSIGNMENT_RADIUS_METERS> m ASC` — nearest-first, around the **branch's** location (not the agent's).
   - Drop any candidate whose `presence:meta:<region>:<agentId>.lastSeenAt` is older than the ~5-minute cutoff, or who is in `presence:busy:<region>`.
   - Take the nearest survivor.
4. Write the offer: `SET assignment:offer:<region>:<orderId> {agentId, expiresAt} EX AGENT_ACCEPT_TIMEOUT_SEC`. Mark the agent provisionally busy in Redis.
5. Push WS `agent:<id>:task.offered` with the task summary. The agent has `AGENT_ACCEPT_TIMEOUT_SEC` (default 30s) to call §3.3's `accept`.
6. If the offer expires unaccepted (checked lazily on the next relevant call, or by a short-lived timer in the assignment service — no background worker needed at this volume): clear the busy mark, increment `orders.reassignment_attempts`, and retry with the next candidate.
7. If candidates are exhausted → publish `assignment.unassigned_alert` to the admin WS channel; the order stays `ready` for manual assignment.

### Algorithm (manual)

- Admin specifies `agentId` directly — no offer, no candidate scoring. In one trx: `orders.delivery_agent_id = agentId`, `status = 'assigned'`, `assigned_at = NOW()`. Marks the agent busy in Redis. Publishes `agent:<id>:task.assigned` and `customer:<id>` / `branch:<id>` `delivery.status_changed`.

### Idempotency

- `orders.delivery_agent_id IS NOT NULL` is the natural guard: an already-assigned order can't be re-assigned. Returns 409 `OrderAlreadyAssigned`.

---

## 4. POST /orders/{orderId}/delivery/accept · /decline

**Accept** (agent currently holding the offer):
1. Verify the caller's `agentId` matches `assignment:offer:<region>:<orderId>` and it hasn't expired. Otherwise 403 / 409 `OfferExpired`.
2. In one trx: `orders.delivery_agent_id = agentId`, `status = 'assigned'`, `assigned_at = NOW()`.
3. Delete the offer key; confirm the agent's busy mark.
4. Publish `agent:<id>:task.assigned` and `customer:<id>` / `branch:<id>` `delivery.status_changed`.

**Decline**: delete the offer key, clear the agent's busy mark, and run the same reassignment path as an expired offer (§3's step 6) — without double-incrementing `orders.reassignment_attempts` for the same offer.

---

## 5. POST /orders/{orderId}/delivery/reassign

- Admin-triggered (or auto, after all candidates/offers are exhausted). Clears `orders.delivery_agent_id`, increments `orders.reassignment_attempts`, re-runs §3's algorithm.
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

1. Insert `agent_earnings(agent_id, order_id, order_created_at, amount, currency)` — `earning = base_fee + per_km × distance_km` (env-configurable rate; today simply `branch.delivery_fee × agentShareRate`). Unique on `order_id` makes this idempotent.
2. For online: ensure the `transactions(type='charge', status='succeeded')` exists (must, by design — written at capture, long before `delivered`).
3. Call **`finance.service.recordDeliverySettlement(orderId, trx)`** (Restaurant Finance module), passing through the trx this service already owns. That call inserts the `transactions(type='cod_collection', status='succeeded')` row for COD orders (there is no pending row to flip — placement never wrote one), computes commission, writes the `transactions(type='commission')` row, and credits `restaurant_balances.balance` — **all of this is Restaurant Finance's responsibility, not this module's**; see `restaurant-finance.md` §7.
4. Release the agent from `presence:busy:<region>`.
5. (No outbound events; clients are notified via WebSocket.)

All in one trx, owned by this module's `delivery.service`, passed into `finance.service.recordDeliverySettlement`. Failure rolls back the whole thing — no partial settlement.

---

## 8. Cancellation while assigned

- If the order is cancelled while `status` is `assigned` (agent not yet `picked`):
  - Clear `orders.delivery_agent_id`; release the agent from `presence:busy:<region>`.
  - WS to agent (`task.cancelled`).
- If cancelled after `picked`: forbidden by the order-status validator (food already with the agent) — handled via a future "issue" flow, not in scope.

---

## 9. Cross-module hook

`order.service.updateStatus` for target `ready` enqueues `assignment.service.tryAssign(orderId)` in-process after commit (a service call into this module, not a repo reach-through).

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
2. An agent in `presence:busy:<region>` always has `orders.delivery_agent_id = agentId` on an order not yet `delivered`.
3. An order has at most one agent "in flight" at a time: either an outstanding Redis offer, or a committed `delivery_agent_id` — never both.
4. `orders.status = 'delivered'` implies `agent_earnings(order_id)` exists and `restaurant_balances.balance` was incremented atomically (same trx).
5. `orders.reassignment_attempts ≤ MAX_REASSIGNMENT_ATTEMPTS`.
6. Going offline while `delivery_agent_id` points at a non-`delivered` order is forbidden.

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

- Assignment's proximity scan is **Redis-only** — `GEOSEARCH` around the branch's lat/lng, filtered by last-seen cutoff. There is no Postgres fallback to maintain (and nothing to fall back to without an `agent_presence` table).
- `idx_orders_delivery_agent_id_status` covers both the agent task list and the "does this order have an active agent" check.
- Offers live entirely in Redis with a TTL — no cleanup job needed; an expired key is simply gone.

---

## 15. WebSocket events emitted

| Event                      | Channel                        | Payload (response DTO)                              |
| --------------------------- | ------------------------------- | ---------------------------------------------------- |
| `task.offered`              | `agent:<id>`                    | `{ orderPublicId, pickup, dropoff, expiresAt }`       |
| `task.assigned`              | `agent:<id>`                    | `DeliveryTaskResponseDTO`                             |
| `task.cancelled`              | `agent:<id>`                    | `{ orderPublicId, reason }`                           |
| `delivery.status_changed`    | `customer:<id>`, `branch:<id>`  | `{ orderPublicId, status, ts, agent: { id, name, phone? } }` |
| `delivery.position`          | `customer:<id>`                 | `{ orderPublicId, lat, lng, ts }` (from ping)          |
