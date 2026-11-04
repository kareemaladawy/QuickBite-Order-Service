# Implementation Plan — `order-service`

Sequenced build order. **Every module is built end-to-end (migration → entity → DTOs → repo → service → controller → routes → mount) before the next module begins.** That keeps every checkpoint shippable and testable.

Acceptance for each phase: the relevant endpoints respond with the documented contract on a local Postgres + Redis stack, idempotency works, RBAC denies the right calls, and (where applicable) WebSocket clients receive the documented events.

> **Parallel work on `core-service`.** This service depends on new endpoints, new RBAC permissions, a new API-key / HMAC auth guard, and an outbound webhook publisher on `core-service`. Each phase below has a **"Core-service changes required"** section. Do not start a phase until its core-service counterpart is in place.

---

## Phase 0 — Scaffolding (no business logic)

Goal: a runnable Express app with the same conventions as `core-service` plus the new infra (country sharding, WS server, core-client, RabbitMQ consumer for inbound core events). No domain modules yet. Anything later phases might need is installed here so they only write business code.

### 0.1 Project bootstrap

1. `package.json` — copy core's deps; add `ws` and `amqplib`. No new lockfile beyond what's required.
2. `tsconfig.json` — copy core verbatim.
3. `.env` & `.env.example`:
   ```
   PORT=4000
   ACCESS_SECRET=...                  # MUST match core
   REFRESH_SECRET=...
   DB_MIGRATION_DIRECTORY=src/migrations
   DB_MIGRATION_EXTENSION=ts
   REGIONS=eg,sa
   DB_eg_HOST=localhost
   DB_eg_PORT=5432
   DB_eg_USERNAME=postgres
   DB_eg_PASSWORD=...
   DB_eg_NAME=order_service_eg
   DB_sa_HOST=...
   DB_sa_PORT=5432
   DB_sa_USERNAME=postgres
   DB_sa_PASSWORD=...
   DB_sa_NAME=order_service_sa
   DB_POOL_MAX=10
   # archive cluster — same shape, separate hosts; used starting Phase 5
   ARCHIVE_DB_eg_HOST=...
   ARCHIVE_DB_eg_NAME=order_service_archive_eg
   ARCHIVE_DB_sa_HOST=...
   ARCHIVE_DB_sa_NAME=order_service_archive_sa
   REDIS_HOST=localhost
   REDIS_PORT=6379
   # RabbitMQ (inbound core events)
   RABBITMQ_URL=amqp://order-service:<secret>@localhost:5672/quickbite
   RABBITMQ_CORE_EVENTS_EXCHANGE=core.events
   RABBITMQ_CORE_EVENTS_QUEUE=order-service.core-events
   RABBITMQ_CORE_EVENTS_BINDINGS="product.#,branch.#,restaurant.#,rbac.#"
   RABBITMQ_CORE_EVENTS_DLX=core.events.dlx
   RABBITMQ_CORE_EVENTS_DLQ=order-service.core-events.dlq
   RABBITMQ_PREFETCH=32
   # core-service integration
   CORE_SERVICE_BASE_URL=http://localhost:3000
   CORE_INTERNAL_API_KEY=...            # sent on every outbound sync call to core
   # kashier
   KASHIER_BASE_URL=https://api.kashier.io
   KASHIER_MERCHANT_ID=...
   KASHIER_API_KEY=...
   KASHIER_WEBHOOK_SECRET=...
   KASHIER_RETURN_URL=https://app.quickbite.io/checkout/return
   KASHIER_FAIL_URL=https://app.quickbite.io/checkout/failed
   PAYMENT_SESSION_TIMEOUT_MIN=15
   # deliveries/assignment
   ASSIGNMENT_RADIUS_METERS=5000
   ASSIGNMENT_CANDIDATE_POOL=20
   ASSIGNMENT_BROADCAST_SIZE=5
   ASSIGNMENT_SWEEP_CRON_SEC=15
   AGENT_ACCEPT_TIMEOUT_SEC=30
   AGENT_MAX_CONCURRENT_ORDERS=3
   LOAD_PENALTY_METERS=1500
   AGENT_EARNINGS_SHARE_PCT=80
   MAX_REASSIGNMENT_ATTEMPTS=3
   PRESENCE_STALE_SEC=90
   # websocket
   WS_HEARTBEAT_SEC=30
   ```
4. `src/lib/config/env.ts` — zod schema covering all of the above; parses `REGIONS` and pulls the per-region DB triples.

### 0.2 Copy-from-core infra (verbatim unless noted)

5. `src/lib/error/AppError.ts`, `errorHandler.ts`.
6. `src/lib/logger/logger.ts`.
7. `src/lib/correlation/correlationId.ts`.
8. `src/lib/http/response.ts`, `pagination/cursor-pagination.ts`, `pagination/parse-query.ts`.
9. `src/lib/validation/validate.ts`.
10. `src/lib/types/express.d.ts` — **extend** Request with `region?: string` and `user?` (no `region` claim on `user`).
11. `src/pkg/cache/cache.interface.ts`, `redis.ts`.
12. `src/pkg/utils/time.ts`. **Add** `money.ts` (`toMinor`, `fromMinor`, `sumMinor`) and `retry.ts` (exponential backoff).
13. `src/lib/cache/init.ts`, `withCache.ts`.
14. `src/lib/auth/guard.ts`, `rbac.ts`, `errors.ts`, `jwt.ts` — copy core. JWT secrets match so tokens issued by core are accepted here.
15. `src/lib/idempotency/idempotency.ts` — copy core. Leave the DB-fallback hook disabled until the `idempotency_keys` table lands in Phase 1.
16. `src/lib/di/tokens.ts`, `container.ts` — empty bootstrap; tokens and registrations are added by later phases.

### 0.3 New infra (sharding, core-client, RabbitMQ consumer, WS)

17. `src/lib/sharding/regions.ts` — canonical country list (from env), helpers `isRegion(s)`.
18. `src/lib/sharding/region-resolver.ts` — Express middleware that sets `req.region` from the **`X-Region` header** only (no path/query/cookie/JWT fallback). `req.region = "all"` is allowed only for admin fan-out reads; writes require a concrete region. `requireRegion` throws `RegionNotResolvedError` (400) when unresolved.
19. `src/lib/knex/shards.ts` — builds `Map<region, Knex>` lazily for the **hot** cluster, and a parallel `Map<region, Knex>` for the **archive** cluster (will be consumed only in Phase 5; functions created now to avoid re-wiring later).
20. `src/lib/knex/knex.ts` — exports `db(region: string): Knex` and `dbArchive(region: string): Knex`. Exports `pingAll()` for health.
21. `src/lib/knex/knexfile.ts` — base config; wraps a script `npm run migrate:all` that iterates regions.
22. `src/lib/core-client/core-client.ts` — **base** `fetch` wrapper:
    - Sets `api-key: ${env.core.internalApiKey}` header on every request.
    - Forwards `X-CorrelationId`.
    - Retries 3x with exponential backoff on 5xx / network errors, capped at 500ms.
    - Translates non-2xx to `AppError`.
    - **Does not** yet import any endpoint wrappers — those (branch/product/permission/address clients) are added in their respective module phases. This file is the only addition in Phase 0.
23. `src/pkg/messaging/message-broker.interface.ts` — `IMessageBroker { connect, consume, close, declareTopology, publish }`. App-agnostic.
    `src/pkg/messaging/rabbitmq/rabbitmq.client.ts` — wraps `amqp-connection-manager`: auto-reconnect, publish buffering on disconnect, topology re-declaration on reconnect. No hand-rolled backoff loop.
24. `src/lib/messaging/init.ts` — singleton broker instance (`amqp-connection-manager`-based `RabbitMQClient`). Topology (`core.events` exchange, `order-service.core-events` durable queue with DLX args, bindings, DLQ) is declared inline by `startCoreEventsConsumer` at boot — no separate `topology.ts`.
25. `src/lib/core-events/consumer.ts` — the AMQP consumer loop:
    - On each message: `cache.trySet("core-events:dedupe:<eventId>", "1", 86400)` — SETNX in Redis.
    - If not fresh (key already exists) → ack, skip.
    - Else dispatch to a registry: `handlers[eventType](payload)`. Registry starts empty; modules register handlers in later phases.
    - On success → ack.
    - On handler throw → nack with `requeue=false` (message flows to DLQ).
26. `src/lib/core-events/types.ts` — `CoreEventEnvelope`, `CoreEventHandler` type alias `(payload) => Promise<void>`. No SQL log repo.
27. `src/lib/websocket/` — **socket.io scaffold**:
    - `ws-server.ts` — `attachWsServer(httpServer)` mounts a socket.io server on `/ws`, installs `@socket.io/redis-adapter` using the shared `redisClient` (+ a duplicate for the subscriber). Auth middleware validates the JWT handshake and stashes `socket.data.user` + `socket.data.allowed`.
    - `ws-auth.ts` — JWT verify + permitted-room derivation (`customer:<userId>`, `restaurant:<restaurantId>`, `branch:<branchId>` per branch, `agent:<agentId>`).
    - `errors.ts` — `WsNoTokenError` etc.
    - Services emit via `io.to(room).emit(event, payload)`; the Redis adapter does cross-worker fan-out. The `io` instance is registered at `TOKENS.WsServer` from `server.ts`.
28. `src/app/health/health.routes.ts` — `GET /api/health` calls `pingAll()` (hot clusters only for now).
29. `src/routes.ts` — mounts `/api/health`. (No inbound HTTP webhook route — core→order traffic is RabbitMQ.)
30. `src/app.ts`, `src/server.ts` — copy core. `server.ts` additionally:
    - Calls `pingAll()` at boot.
    - Attaches the socket.io server to the shared `http.Server`, registers `TOKENS.WsServer`.
    - Connects to RabbitMQ and starts the `core-events` consumer (`startCoreEventsConsumer` declares topology inline).

### 0.4 No migrations in Phase 0

Phase 0 creates no tables. Core-event dedupe lives in Redis; all domain tables land in the phase that consumes them.

### 0.5 `core-service` changes required before Phase 0 ships

These belong on `core-service` and must land before this service's Phase 0 is considered complete.

1. **Seed new RBAC permissions** (new migration in `core-service/src/migrations/`):
   ```sql
   INSERT INTO permissions (resource, action, created_at) VALUES
     -- Orders
     ('orders',     'read',   NOW()),
     ('orders',     'accept', NOW()),
     ('orders',     'update',        NOW()),
     ('orders',     'cancel',        NOW()),
     -- Payments
     ('payments',   'read',          NOW()),
     ('payments',   'refund',        NOW()),
     -- Deliveries (admin-only)
     ('deliveries', 'assign',        NOW()),
     -- Finance
     ('finance',    'read',          NOW()),
     ('finance',    'payout_create', NOW())
   ON CONFLICT (resource, action) DO NOTHING;
   ```
   Role mapping (extend the existing seed):
   - `owner` → all of the above.
   - `branch_manager` → `orders:read, orders:accept, orders:update, orders:cancel, finance:read`.
   - `staff` → `orders:read, orders:update, orders:accept`.
   - `payments:refund` and `finance:payout_create` are admin-bypassed today; seeded for future extensibility.

2. **Add `branches.delivery_fee INT NOT NULL DEFAULT 0`** (minor units of the branch currency) in core. This service reads it via `GET /api/internal/branches/:id` at checkout.

3. **Internal API-key auth guard** (for sync HTTP calls **from** this service **to** core):
   - New env on core: `INTERNAL_API_KEY=<secret>` (single shared secret). Matched by `CORE_INTERNAL_API_KEY` on this service's side.
   - New middleware `src/lib/auth/api-key.ts` that compares the `api-key` request header against `env.internal.apiKey` (plain equality — the broker/gateway is the trust boundary).
   - Each domain module mounts its own internal routes inline in its `routes.ts` under the `/internal/...` prefix, guarded by `requireInternalApiKey`. There is **no** dedicated `app/internal/` module.

4. **Transactional outbox on core** (`src/lib/events/` in core):
   - New env on core: `RABBITMQ_URL`, `RABBITMQ_CORE_EVENTS_EXCHANGE=core.events`, `OUTBOX_DRAIN_CRON="* * * * * *"`, `OUTBOX_BATCH_SIZE=50`.
   - New migration: `events_outbox` table on core's DB (`id, aggregate_type, aggregate_id, event_type, event_id, payload JSONB, created_at, dispatched_at, attempts, last_error`).
   - **Service layer** (never repo) writes the outbox row in the same DB transaction as the domain write. Repos never call `insertOutboxEvent`.
   - The drain lives in a **separate worker process** (`src/worker.ts`), not in the API. `croner` schedules `drainOutbox()`; `drainOutbox` claims a batch with `FOR UPDATE SKIP LOCKED`, publishes with **publisher confirms**, stamps `dispatched_at` on broker ACK. SKIP LOCKED makes N workers safe in parallel.
   - The `core.events` topic exchange is declared by the worker at boot.

5. **Secrets hygiene**: `KASHIER_WEBHOOK_SECRET` (this service), `INTERNAL_API_KEY` (one shared secret between core and order-service today), and RabbitMQ credentials are three different secrets with three different lifecycles. Do not conflate them.

### Acceptance (Phase 0)

- `npm run dev` starts, `GET /api/health` returns OK against every configured shard.
- On boot, the `core-events` consumer declares the queue + bindings + DLQ and begins consuming. Publishing a test message to `core.events` with routing key `product.test` (unregistered type) is consumed, logged as "no handler, acking", and acked — unknown types are not sent to DLQ.
- Killing RabbitMQ and restarting this service: `amqp-connection-manager` reconnects automatically and re-declares topology; no crash.
- On the core side, `npm run worker:dev` boots the outbox worker; inserting a row into `events_outbox` is drained within ~1s and shows up in this service as a Redis dedupe key `core-events:dedupe:<eventId>`.
- A socket.io client connects to `ws://localhost:4000` with `path: "/ws", auth: {token}`, emits `subscribe(channel, ack)`, and a server-side `io.to(channel).emit(event, payload)` reaches the client.

---

## Phase 1 — Orders module (the spine)

### Migrations

- `20260418000020_create_orders.ts`
- `20260418000030_create_order_items.ts`
- `20260418000100_create_idempotency_keys.ts`

### Code

1. Migrations above (each in every region).
2. Entities: `OrderEntity`, `OrderItemEntity`.
3. Request DTOs: `CreateOrderRequestDTO`, `UpdateOrderStatusRequestDTO`, query DTOs (or use `parsePaginationQuery`).
4. Response DTOs: `OrderResponseDTO`, `OrderItemResponseDTO`, `OrderSummaryResponseDTO`, `OrderDetailResponseDTO`, `OrderStatusResponseDTO`.
5. Repos:
   - `order.repo.ts` — `createOrder`, `findOrderByPublicId`, `findOrdersByCustomer`, `findOrdersByBranch`, `updateOrderStatus`, `setDeliveryAgent`. Each accepts `conn: Knex`.
   - `order-item.repo.ts` — `bulkInsertItems`, `findItemsByOrderIds(orderIds[])` (batch — guards against N+1).
   - `idempotency-store.ts` — `tryGet`, `store`. Activate the DB-fallback hook in `lib/idempotency/idempotency.ts` now that the table exists.
6. `order-status.service.ts` — pure helper: `assertTransition(from, to, actor)` table-driven from `enums.ts`.
7. `order.service.ts` —
   - `placeOrder(...)` per Orders.md §2 (validate via core-client cached → compute money → trx → after-commit reserveStock).
   - `getOrder(...)`: by publicId; ownership check; loads items batch + payment summary (joins).
   - `listCustomerOrders(...)`, `listRestaurantOrders(...)` with cursor pagination.
   - `updateStatus(...)`: validates transition, stamps timestamp, publishes WS immediately via the Phase 0 publisher (`customer:<id>` / `branch:<id>` `order.status_changed`) — there is no separate WS-wiring phase; every phase wires its own events as it lands.
8. `order.controller.ts` — wire `validateBody`, `sendSuccess`/`sendPaginated`, response DTOs.
9. `routes.ts` — `authenticate`, `idempotency({strict:true})` on `POST /orders`, `withCache(10)` on `GET /restaurant/orders` per branch+status.
10. Register controller + service in DI container. Mount in `src/routes.ts`.
11. **Core-client endpoint wrappers added now**:
    - `branch.client.ts` — `getBranch`, `getBranchProducts(branchId, productIds[])`, `reserveStock(branchId, items[])`.
    - `address.client.ts` — `getCustomerAddress(id)`.
12. **Register core-event handlers** (in the Phase 0 consumer registry):
    - `product.stock.changed` → invalidate `core:product:price:*` and `core:product:stock:*` for the affected branch+product.
    - `product.price.changed` → invalidate `core:product:price:<branchId>:<productId>`.
    - `branch.updated` / `branch.deactivated` → invalidate `core:branch:<branchId>`; `branch.deactivated` additionally sets a Redis flag that the orders service checks to reject new orders to that branch.
    - `restaurant.suspended` → invalidate `core:restaurant:<id>`; mark pending orders for that restaurant for review.

### Core-service changes required

All of the following go under `/api/internal/*` (guarded by the API-key middleware from Phase 0) unless noted.

- `GET /api/internal/branches/:id` — branch metadata: `{ id, region, restaurantId, restaurantStatus, acceptOrders, isActive, deliveryFee, commissionBps, currency, lat, lng, name, addressText }`. Lives on the branch module's router (inline internal route).
- `GET /api/internal/branches/:id/products?ids=1,2,3` — batch price + stock + availability + name + image URL for the requested product IDs. Lives on the product module's router.
- `POST /api/internal/branches/:id/reserve-stock` — body `{ items: [{ productId, quantity }] }`. Atomic decrement inside one core-service DB trx; returns 409 with offending items on underflow. Idempotent via `Idempotency-Key`. Lives on the product module's router.
- `GET /api/internal/customer-addresses/:id` — returns `{ id, userId, lat, lng, addressText, city, country, building, apartmentNumber, label }` for the delivery snapshot. Lives on the customer-address module's router.
- `GET /api/internal/agents/:id` — returns `{ id, name, phone }` for an agent. Lives on the user module's router.
- `GET /api/internal/rbac/permissions?role=<name>` — returns the permission list for a role (used by the RBAC cache). Lives on the rbac module's router.
- **Wire outbox inserts in the service layer** (never the repo): in the same DB trx as every mutation to `products`, `product_branch_details`, `branches`, `restaurants` and `role_permissions`, the owning service calls `insertOutboxEvent(trx, ...)` with the corresponding `event_type` — `product.stock.changed`, `product.price.changed`, `branch.updated`, `branch.deactivated`, `restaurant.suspended`, `rbac.permissions_changed`. The worker process drains and publishes to `core.events`.

### Acceptance

- `POST /orders` with COD creates an order, returns 201, items are persisted.
- Same idempotency key returns the same response; different body → 409.
- `PATCH /orders/{id}/status` accept→preparing→ready works; reject from preparing fails; customer cancel after `accepted_at + 60s` fails.
- `GET /restaurant/orders?branchId=&status=placed` returns expected list; `EXPLAIN` shows index usage.
- Triggering `product.stock.changed` in core (service mutation → outbox insert in same trx → worker drains → `core.events`) is consumed here and deletes the right Redis keys. Replay of the same `eventId` is a no-op (dedupe via Redis SETNX on `core-events:dedupe:<eventId>`).

---

## Phase 2 — Payments module

### Migrations

- `20260418000010_create_payment_providers.ts` (with seed `kashier`, eg region only — COD is a payment method, not a provider row).
- `20260418000040_create_payment_sessions.ts`.
- `20260418000050_create_transactions.ts`.
- `20260418000110_create_payment_webhook_events.ts`.

### Code

1. Kashier provider in `pkg/`:
   - `pkg/payments/payment.interface.ts` (`createSession`, `refund`, `verifyWebhook`).
   - `pkg/payments/kashier/kashier.client.ts` — HTTP client for Kashier v3.
   - `pkg/payments/kashier/kashier.signature.ts` — HMAC.
   - `pkg/payments/kashier/kashier.types.ts` — provider DTOs.
2. Entities: `PaymentSessionEntity`, `TransactionEntity`, `PaymentProviderEntity`.
3. Request DTOs: `InitPaymentRequestDTO`, `RefundRequestDTO`.
4. Response DTOs: `PaymentInitResponseDTO`, `PaymentResponseDTO`.
5. Repos: `payment-session.repo.ts`, `transaction.repo.ts`, `payment-webhook-event.repo.ts`, `payment-provider.repo.ts`.
6. `kashier-webhook.service.ts` — verify signature, dedupe by `(provider_id, provider_event_id)`, advance session/transaction/order in trx. On `captured` (after commit): publish `customer:<id>:order.status_changed` (to `placed`) and `branch:<id>:order.created` via the Phase 0 WS publisher. On `failed`: publish `customer:<id>:payment.failed`. Wired here, not in a later phase.
7. `payment.service.ts` — `init`, `getById`, `refund`.
8. Controllers: `payment.controller.ts` (auth'd) and `webhook.controller.ts` (no auth).
9. `routes.ts` — `/payments/init`, `/payments/webhook/:provider` (no auth), `/payments/:id`, `/payments/:id/refund`. Idempotency strict on init and refund.
10. **Cross-module update** in Orders: on `paymentMethod='online'`, optionally invoke `payment.service.init` to attach the `redirectUrl` on the `POST /orders` response. Clients may also call `POST /payments/init` separately.

### Core-service changes required

- None strictly required for this phase. If we want core to be notified of `payment.refunded` or `payment.captured` later, that's a separate change; we don't emit anything outbound in this milestone.

### Acceptance

- `POST /payments/init` creates a Kashier session (mock in tests), persists `payment_sessions`.
- Webhook end-to-end: signed payload → order moves to `placed`, transaction recorded. Duplicate webhook → 200 with no side effect.
- Refund flow: POST → Kashier mock 2xx → transaction `pending` → simulated webhook → `succeeded`, charge marked `is_refunded`.

---

## Phase 3 — Agents, delivery status & assignment (broadcast/accept, no auto-assignment)

Goal: get an order from `ready` to `delivered` using agents only. Per the db design decision, there is **no separate delivery entity** — delivery state lives directly on `orders` (status machine + `delivery_agent_id`, both already in place from Phase 1), and agent presence lives **entirely in Redis**, not Postgres, since it's only ever needed for the last ~5 minutes, not as a durable record. Don't reintroduce either table; the only new table this phase needs is the earnings ledger.

There is **no automatic single-agent assignment**. Every assignment attempt broadcasts a simultaneous offer to up to `ASSIGNMENT_BROADCAST_SIZE` candidate agents (ranked by a distance + current-order-count score — see `agents.md` §3), and agents accept or reject over the existing offer/accept endpoints. Agents may now hold up to `AGENT_MAX_CONCURRENT_ORDERS` in-flight orders at once (tracked by a `presence:load:<region>` Redis sorted set, not a boolean busy flag). A new **cron sweep worker** keeps re-broadcasting `ready` orders that still need an agent — see §4 below — so assignment isn't solely dependent on the in-request hook firing once.

### Migrations

- `20260418000090_create_agent_earnings.ts` — per-delivery earnings snapshot, FK'd to `orders` (composite FK per §3.2's `(order_id, order_created_at) REFERENCES orders(id, created_at)` rule, same as `order_items`).

No `deliveries` table. No `agent_presence` table.

### Code

1. Entity: `AgentEarningEntity` only (no `DeliveryEntity`, no `AgentPresenceEntity`).
2. Request DTOs: `AssignDeliveryRequestDTO` (manual override), `PresenceOnlineRequestDTO` (lat, lng — reused for ping), `UpdateDeliveryStatusRequestDTO` (drives the same order-status machine from Phase 1: `assigned → picked → delivered`).
3. Response DTOs: `DeliveryTaskResponseDTO`, `AgentEarningsResponseDTO`.
4. Repos:
   - `agent-earning.repo.ts` — `insertEarning(conn, ...)`, `findByAgent(agentId, cursor)`.
   - Extend `order.repo.ts` (no new repo file for deliveries): flesh out `setDeliveryAgent`, add `findTasksByAgent(agentId, cursor)` using the existing `idx_orders_delivery_agent_id_status` index.
5. `presence.service.ts` — **Redis only, no Postgres table**:
   - `goOnline(agentId, region, lat, lng)` → `GEOADD presence:geo:<region> lng lat agentId` + `SET presence:meta:<region>:<agentId> {lastSeenAt} EX <cutoff>` + resync `presence:load:<region>` for this agent from `COUNT(orders WHERE delivery_agent_id=agentId AND status IN ('assigned','picked'))`.
   - `ping(agentId, lat, lng)` refreshes geo + meta keys (does not touch `presence:load`).
   - `goOffline(agentId)` → `ZREM` from the geo set + delete the meta key; rejected if the agent currently holds **any** order (`delivery_agent_id`) that isn't yet `delivered` (there may be more than one now).
   - Staleness cutoff is **~5 minutes** — bump `PRESENCE_STALE_SEC` from the Phase 0 default of 90 to 300 to match. An agent not pinged within that window is excluded from assignment even if its Redis key technically hasn't expired yet.
6. `assignment.service.ts` — implements `agents.md` §3's broadcast/accept algorithm, Redis-only (there is no Postgres fallback to maintain without an `agent_presence` table):
   - Look up the order's branch `lat`/`lng` via the already-cached `GET /api/internal/branches/:id` core-client call from Phase 1.
   - `GEOSEARCH presence:geo:<region> FROMLONLAT <branchLng> <branchLat> BYRADIUS <ASSIGNMENT_RADIUS_METERS> m ASC COUNT <ASSIGNMENT_CANDIDATE_POOL>` → nearest-first candidate pool around the **branch's** location.
   - Drop stale presence and any candidate at `presence:load >= AGENT_MAX_CONCURRENT_ORDERS`; rank survivors by `distanceMeters + loadCount × LOAD_PENALTY_METERS` and take the lowest `ASSIGNMENT_BROADCAST_SIZE`.
   - Write one `assignment:offer:<region>:<orderId>:<agentId>` key per candidate (TTL `AGENT_ACCEPT_TIMEOUT_SEC`) plus an `assignment:offered:<region>:<orderId>` tracking set, and push `agent:<id>:task.offered` to all of them simultaneously. No candidates → publish `assignment.unassigned_alert` and leave the order `ready`.
   - `acceptOffer(orderId, agentId)` — atomic win-claim (`SET assignment:winner:... NX`), then commits `delivery_agent_id`/`status='assigned'` in a trx and `ZINCRBY presence:load 1`; tears down the losing offers and pushes `task.offer_lost` to them.
   - `declineOffer(orderId, agentId)` — just deletes that agent's own offer key; does **not** trigger an inline retry (see worker below).
7. `assignment-sweep.worker.ts` (new, in `lib/jobs/`) — `setInterval(ASSIGNMENT_SWEEP_CRON_SEC * 1000)` (default 15s), same pattern as the Phase 5 archival worker (no new scheduling library — `setInterval` + a Redis lock is the established convention here), one instance per region process, guarded by a short-TTL Redis lock `assignment:sweep:<region>:lock` to prevent overlapping/duplicate ticks:
   - Finds `orders WHERE status='ready'` on each region's shard connection (reuses `idx_orders_status_created_at`) with no live `assignment:offered:<region>:<orderId>` set, and re-invokes `assignment.service.tryAssign` for each, incrementing `orders.reassignment_attempts` per broadcast beyond the first (enforcing `MAX_REASSIGNMENT_ATTEMPTS`).
   - This is **the** "always try to assign ready-for-delivery orders" loop — the in-process hook (step 9) is just the fast path; this worker is the actual retry mechanism, and every broadcast it issues is still delivered to agents over WS in real time.
8. `delivery.service.ts` (operates on `orders` directly, not a `deliveries` table):
   - `assign(orderId, agentId?)` — manual override (capacity-checked against `AGENT_MAX_CONCURRENT_ORDERS`), or delegates to `assignment.service.tryAssign`.
   - `updateStatus(orderId, agentId, toStatus)` — reuses the Phase 1 order-status machine; checks the caller is the assigned agent.
   - `reassign(orderId)` — increments `reassignment_attempts` and re-invokes `assignment.service.tryAssign` (no `delivery_agent_id` to clear — it's only ever set by a *winning* accept/manual-assign); enforces `MAX_REASSIGNMENT_ATTEMPTS`.
   - On `delivered`: inserts the `agent_earnings` row with `amount = floor(order.deliveryFee × AGENT_EARNINGS_SHARE_PCT / 100)` (flat 80% of the order's delivery fee), `ZINCRBY presence:load -1`, and calls **`finance.service.recordDeliverySettlement(orderId, trx)`** (Phase 4) inside the same trx it owns — Phase 4 is responsible for inserting the (COD-only) `cod_collection` transaction directly as `succeeded` (no pending row exists to flip — placement never wrote one), commission calculation, and the restaurant-balance credit.
9. Controller + routes: `/agents/presence`, `/agents/tasks`, `/orders/:id/delivery` (assign / accept / decline / reassign / status).
10. **Cross-module hook** (fast path, unchanged in spirit from the original plan): `order.service.updateStatus` for target `ready` enqueues `assignment.service.tryAssign(orderId)` in-process after commit. The sweep worker (step 7) is the backstop that doesn't depend on this hook having fired.
11. **WS wiring, done here**: `assignment.service` publishes `agent:<id>:task.offered` (broadcast) and `task.offer_lost`/`task.assigned` on resolution; `delivery.service.updateStatus` publishes `customer:<id>` / `branch:<id>` `delivery.status_changed` on every transition; `presence.service.ping` publishes `customer:<id>:delivery.position` when the pinging agent has an active delivery. All via the Phase 0 WS publisher — no separate wiring phase follows this one.
12. `server.ts` — starts `assignment-sweep.worker.ts` alongside the HTTP/WS server at boot (same pattern Phase 5 uses for the archival worker).

### Core-service changes required

- `GET /api/internal/agents/:id` — returns `{ id, name, phone }` for display when a delivery is assigned. (Same endpoint referenced in Phase 1; confirm `delivery_agent` is a `system_role` in core's seed.)

### Acceptance

- Order moved to `ready` triggers a **broadcast**: up to `ASSIGNMENT_BROADCAST_SIZE` candidates within `ASSIGNMENT_RADIUS_METERS` of the **branch's** lat/lng, with presence pinged within the last ~5 minutes and under `AGENT_MAX_CONCURRENT_ORDERS`, each receive `task.offered` over WS simultaneously; manual `agentId` override also works (capacity-checked).
- First agent to call `accept` wins; the rest receive `task.offer_lost`; a losing agent's own `accept` after that returns 409 `OfferAlreadyTaken`.
- An agent can hold more than one in-flight order at a time, up to `AGENT_MAX_CONCURRENT_ORDERS`; a 4th offer to an at-capacity agent is never sent (verify via `presence:load`).
- Agent flow `assigned → picked → delivered` works per order; only the assigned agent can advance it.
- Going offline rejects if the agent holds any undelivered order.
- Stopping the API process entirely (so the in-process `ready` hook never fires) still results in the order being broadcast within one `ASSIGNMENT_SWEEP_CRON_SEC` tick once the sweep worker runs — confirms the cron worker is a real, independent retry path, not just the hook under another name.
- On `delivered`: `agent_earnings.amount` equals `floor(order.deliveryFee × 0.8)`; `finance.service.recordDeliverySettlement` is invoked and inserts a `succeeded` `cod_collection` row for COD orders (there was never a pending one); the balance/commission effects are verified in Phase 4's acceptance.
- Reassignment (via the sweep worker, once a broadcast fully empties out) increments `reassignment_attempts`; `MAX_REASSIGNMENT_ATTEMPTS` enforced.
- A customer subscribed to `customer:<id>` receives `delivery.status_changed` without polling; an agent subscribed to `agent:<id>` receives `task.offered` on broadcast and `task.assigned` on winning.

---

## Phase 4 — Restaurant finance (balance, commission, payouts)

### Migrations

- `20260418000060_create_restaurant_balances.ts` — moved here from the old deliveries phase: balance and commission accounting belong with finance, not assignment.

### Code

1. Entity: `RestaurantBalanceEntity`; reuse `TransactionEntity`.
2. DTOs: `RestaurantBalanceResponseDTO`, `PayoutResponseDTO`, `CreatePayoutRequestDTO`.
3. Repos: `restaurant-balance.repo.ts` (with a `forUpdate` helper for the settlement/payout row lock); extend `transaction.repo.ts` with `findPayouts(restaurantId, from, to, paginationParams)`.
4. `finance.service.ts`:
   - `getBalance`, `listPayouts`, `recordPayout` (admin) — as before.
   - **`recordDeliverySettlement(orderId, trx)`** — new. Called by `delivery.service` (Phase 3 §7) on `delivered`, inside the trx `delivery.service` already owns (per §8's "the service that opens the trx passes it through" convention — this is a cross-module *service* call, never a repo reach-through). Computes commission from the order's `commission_bps` snapshot × `subtotal`, inserts the `transactions(commission)` row, and credits `restaurant_balances.balance` by `subtotal - commission`. **This is where order commission calculation lives** — not in the orders or delivery module.
5. Controller + routes for `/restaurant/balance`, `/restaurant/payouts`. Idempotency strict on `POST /restaurant/payouts`.

### Core-service changes required

- The `finance:read` permission must already be seeded (from Phase 0 core seed). Mapped to `owner` and `branch_manager`.

### Acceptance

- Owner and manager can read balance + payouts; staff cannot.
- Admin can record a payout; balance decrements; same idempotency key returns the same payout.
- Payout > balance → 409 `InsufficientBalance`.
- An order moving to `delivered` in Phase 3 results in `restaurant_balances.balance` increasing by `subtotal - commission` and a `transactions(commission)` row appearing — this closes the loop on the settlement hookup described in Phase 3.

---

## Phase 5 — Cold archival worker (the second background worker, after Phase 3's assignment sweep)

### Goal

Every night, move rows whose `created_at` is in a **prior year** from the hot cluster to the archive cluster per region. Keep the hot DB small enough that current-year queries stay fast.

### Migrations

- None in the hot cluster. The archive cluster runs the same migration set as the hot cluster (hot cluster schema == archive cluster schema). Run `npm run migrate:all -- --cluster=archive` once per region.

### Code

1. `lib/jobs/archival.worker.ts` — one instance per region, scheduled nightly (simple `setInterval` + guard on a Redis lock `archival:<region>:lock` to avoid duplicate runs if multiple processes start):
   - Walk tables in FK-safe order: `agent_earnings → payment_webhook_events → payment_sessions → transactions → order_items → orders`.
   - For each table, loop in batches of 1000 rows where `created_at < date_trunc('year', NOW())`:
     - Begin trx on hot + trx on archive.
     - `SELECT ... FROM hot WHERE id IN (...)` / `INSERT ... INTO archive` / `DELETE FROM hot WHERE id IN (...)`.
     - Commit archive first, then hot (so a crash mid-move leaves the row in both places, which is safer than in neither; a re-run then re-inserts with `ON CONFLICT DO NOTHING`).
   - Respect a max runtime per night (env `ARCHIVAL_MAX_RUNTIME_MIN`, default 60).
   - Emit structured log lines per batch (rows moved, table, region, duration).
2. **Read-path routing** updates:
   - The archive cluster is **admin/restaurant-only** — a customer-authenticated request never reads it, by design (customers only ever see current-year orders).
   - `GET /restaurant/orders?from&to`: if the requested range is entirely in prior years → route reads to `dbArchive(region)` instead of `db(region)`. If the range straddles the boundary → split the query in the service, merge results in the DTO layer (rare path; document the fan-out).
   - `GET /customer/orders?year=YYYY`: always reads `db(region)` regardless of `year` — a prior-year request simply comes back empty once those orders are archived off the hot cluster.
   - `GET /orders/{publicId}`: try hot first; if not found and the caller is `system_admin`, retry on archive. A customer never gets the archive fallback, so a customer's own archived order reads as not found. Keep this path off the critical customer-order-tracking flow.
3. Archive-cluster knex connections registered in `lib/knex/shards.ts` (slot already reserved since Phase 0).

### Core-service changes required

- None.

### Acceptance

- Seed 5,000 orders in the hot cluster, half of them dated prior year.
- Run the archival worker once.
- Hot cluster has only current-year rows; archive cluster has the prior-year rows.
- `GET /customer/orders?year=<priorYear>` returns rows from the archive cluster; `EXPLAIN` shows it's hitting the archive.
- Re-running the worker is a no-op (nothing left to move; logs say `moved=0`).
- Killing the worker mid-batch and restarting it does not duplicate rows (archive inserts use `ON CONFLICT DO NOTHING`).

---

## Phase 6 — Outbound event outbox (for `analytics-service`)

### Goal

Emit order lifecycle (`placed`, `accepted`, `rejected`, `delivered`, `cancelled`) and payment outcome (`completed`, `failed`) events to a new `order.events` topic exchange, reliably, via a transactional outbox — same pattern `core-service` uses on its own domain mutations (see §5 Reliability requirement on `core-service` in `docs/system-design.md`), adapted to this service's per-region sharding and plain `setInterval` jobs (no `croner` here).

### Migrations

- `events_outbox` table, per shard (`aggregate_type, aggregate_id, event_type, event_id, payload JSONB, created_at, dispatched_at, attempts, last_error` — no `region` column; the shard itself is the region), run via the existing `migrate:all` path.

### Code

1. `pkg/messaging/message-broker.interface.ts` / `rabbitmq.client.ts` — `declareExchange(exchange)`, a publish-only exchange declare (existing `declareTopology` is consumer-shaped).
2. `lib/events/event-types.ts` — `OrderEventType` enum (mirrors core-service's `lib/events/event-types.ts`'s `CoreEventType`).
3. `lib/events/types.ts` — `OutboxEventInput`/`OutboxEventRow`/`OutboxEventEnvelope`/`OutboxFailure`.
4. `lib/events/outbox.repo.ts` — `insertOutboxEvent`, `claimUndispatchedEvents` (`FOR UPDATE SKIP LOCKED`), `markEventsDispatched`, `markEventsFailed` (bulk) — same function names/shape as core-service's `lib/events/outbox.repo.ts`.
5. `lib/events/outbox-drain.ts` — `drainOutboxForRegion(region)`: one trx per batch, publish with confirms, stamp `dispatched_at` (the per-region equivalent of core's `worker.ts`-embedded `drainOutbox`); a publish failure marks that row failed and stops the batch early rather than hammering a down broker row-by-row.
6. `lib/events/jobs.ts` — `registerOutboxDrainJobs()`: `setInterval` + per-region Redis lock, same shape as `lib/jobs/pending-payment-sweep.ts`; the drain iterates every region each tick. Called from `worker.ts` next to the other job registrations (which now also connects `messageBroker` at boot, since only `server.ts` did before).
7. Insertion call sites, each in the same trx as the domain mutation: `OrderService.placeOrder` (COD only, right after `bulkInsertItems` → `order.placed`, a leaner dedicated payload — see `app/order/outbox-events.ts`'s `insertOrderPlacedOutboxEvent`), `OrderService.markPlacedBySystem` (online only, the `pending_payment → placed` transition on a captured payment → `order.placed`, same leaner payload, items re-fetched via `findItemsByOrderIds` since this path doesn't already hold them in memory), `OrderService.applyStatusTransition` (`order.accepted`/`order.rejected`/`order.cancelled`), `OrderService.sweepStalePendingPaymentOrders` (system cancel → `order.cancelled`), `OrderService.transitionByAgent` (delivered → `order.delivered`), `PaymentWebhookService.handleCapture` (`payment.completed`/`payment.failed`). `order.placed` fires exactly once per order either way — `placeOrder` only fires it for COD; an online order isn't meaningfully "placed" until payment clears, so it waits for `markPlacedBySystem`.

### Core-service changes required

- None.

### Acceptance

- Bind a throwaway test queue to `order.events` with key `#`; placing a COD order produces one `order.placed` message; the matching `events_outbox` row's `dispatched_at` gets set within one drain tick.
- Full order lifecycle (placed → accepted → ready → assigned → picked → delivered) and a cancellation each produce exactly one matching event.
- Placing an online order produces no `order.placed` yet (still `pending_payment`); its capture webhook produces `payment.completed`, then `order.placed` (from `markPlacedBySystem`) — in that order, not the other way round.
- Killing `worker.ts` mid-batch and restarting it re-sends only the rows whose `dispatched_at` never committed (no gaps, at-least-once duplicates acceptable).

---

## Build cadence summary

```
Phase 0  Scaffolding (WS base, core-client base, inbound core webhook route)
Phase 1  Orders                      ───►  COD orders end-to-end
Phase 2  Payments + Kashier          ───►  online orders end-to-end
Phase 3  Agents + delivery + broadcast assignment ───►  full delivery lifecycle on Redis presence + sweep worker
Phase 4  Restaurant finance          ───►  commission/balance settlement + owner/admin financial views
Phase 5  Cold archival worker        ───►  hot DB stays small
Phase 6  Outbound event outbox       ───►  order/payment events reach analytics-service
```

Each phase is shippable. No phase mixes modules. No phase is started until the previous phase's acceptance is checked AND the matching **"Core-service changes required"** for that phase (listed inline above) are in place. WebSocket events are wired inline as each phase lands (see each phase's own "WS wiring" step) — there is no dedicated WS phase.
