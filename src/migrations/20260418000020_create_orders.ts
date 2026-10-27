import type { Knex } from "knex";
import { ensureOrderMonthPartitions } from "../lib/knex/partitioning";

const ORDER_STATUSES = [
    "pending_payment", "placed", "accepted", "rejected",
    "preparing", "ready", "assigned", "picked", "delivered", "cancelled",
];

// `orders` is partitioned by RANGE (created_at), monthly. Postgres requires every
// unique/PK constraint on a partitioned table to include the partition key, so:
//   - the PK is (id, created_at), not id alone.
//   - public_id's uniqueness is enforced as UNIQUE(public_id, created_at) — this still
//     fully supports single-row lookup by public_id (it's the leading column).
//   - any child table with a real FK into `orders` must carry a denormalized
//     created_at and use a composite FK (see order_items migration).
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE orders (
            id                              BIGINT GENERATED ALWAYS AS IDENTITY,
            region                          TEXT NOT NULL,
            public_id                       UUID NOT NULL,
            country_code                    TEXT NOT NULL,
            restaurant_id                   BIGINT NOT NULL,
            branch_id                       BIGINT NOT NULL,
            customer_id                     BIGINT NOT NULL,
            customer_address_id             BIGINT NOT NULL,
            delivery_lat                    DECIMAL(10,7) NOT NULL,
            delivery_lng                    DECIMAL(10,7) NOT NULL,
            delivery_address_text_snapshot  TEXT NOT NULL,
            status                          TEXT NOT NULL CHECK (status IN (${ORDER_STATUSES.map((s) => `'${s}'`).join(", ")})),
            subtotal                        INT NOT NULL,
            delivery_fee                    INT NOT NULL,
            service_fee                     INT NOT NULL,
            total                           INT NOT NULL,
            commission                      INT NOT NULL DEFAULT 0,
            currency                        TEXT NOT NULL,
            payment_method                  TEXT NOT NULL CHECK (payment_method IN ('online', 'cod')),
            delivery_agent_id               BIGINT NULL,
            cancellation_reason             TEXT NULL,
            created_at                      TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at                      TIMESTAMP NOT NULL DEFAULT NOW(),
            accepted_at                     TIMESTAMP NULL,
            rejected_at                     TIMESTAMP NULL,
            preparing_at                    TIMESTAMP NULL,
            ready_at                        TIMESTAMP NULL,
            assigned_at                     TIMESTAMP NULL,
            picked_at                       TIMESTAMP NULL,
            delivered_at                    TIMESTAMP NULL,
            cancelled_at                    TIMESTAMP NULL,
            PRIMARY KEY (id, created_at)
        ) PARTITION BY RANGE (created_at);

        -- supports GET /orders/{publicId} (publicId is the leading column, so this also
        -- serves as a plain lookup index; no separate idx_orders_public_id needed)
        CREATE UNIQUE INDEX uq_orders_public_id_created_at ON orders (public_id, created_at);
        -- supports GET /customer/orders?year=YYYY
        CREATE INDEX idx_orders_customer_id_created_at ON orders (customer_id, created_at DESC);
        -- supports GET /restaurant/orders?branchId=&status=&from=&to=
        CREATE INDEX idx_orders_branch_status_created_at ON orders (branch_id, status, created_at DESC);
        -- supports delivery auto-assignment scan for pending-assignment orders in a region
        CREATE INDEX idx_orders_status_created_at ON orders (status, created_at) WHERE status IN ('ready', 'assigned');
        -- supports GET /agents/tasks?status=
        CREATE INDEX idx_orders_delivery_agent_id_status ON orders (delivery_agent_id, status) WHERE delivery_agent_id IS NOT NULL;

        -- Catch-all for any row whose created_at falls outside the pre-created monthly
        -- range (clock skew, backfills). ensureOrderMonthPartitions keeps the next 12
        -- months pre-created, so this should stay empty in normal operation.
        CREATE TABLE orders_default PARTITION OF orders DEFAULT;
    `);

    await ensureOrderMonthPartitions(knex, 12);
}

export async function down(knex: Knex): Promise<void> {
    // Dropping the partitioned parent drops every partition (dated + default) with it.
    await knex.schema.dropTableIfExists("orders");
}
