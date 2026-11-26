import {randomUUID} from "crypto";
import {db, dbArchive, destroyAll} from "../../../src/lib/knex/knex";
import {runArchivalWorker} from "../../../src/lib/jobs/archival.worker";
import {cacheProvider} from "../../../src/lib/cache/init";
import {truncateAll} from "../../helpers/db";

// runArchivalWorker() has no per-call options — it loops over every region in
// env.REGIONS and reads batch size / runtime cap / lock TTL from env (see
// .env.test: REGIONS=eg, ARCHIVAL_BATCH_SIZE=2 so these tests exercise the
// multi-batch path without needing a huge fixture).
const REGION = "eg";
const PRIOR = new Date(Date.UTC(2023, 5, 1, 12, 0, 0)); // 2023-06-01 — a prior year
const CURRENT = new Date(); // this year — stays hot

const hot = () => db(REGION);
const archive = () => dbArchive(REGION);

const RESTAURANT = 1;
const AGENT = 7;
const CUSTOMER = 500;

const SUBTOTAL = 10000;
const DELIVERY_FEE = 1500;
const SERVICE_FEE = 500;
const TOTAL = 12000;

async function seedOrder(createdAt: Date): Promise<{id: number; createdAt: Date}> {
    const [row] = await hot()("orders")
        .insert({
            region: REGION,
            public_id: randomUUID(),
            country_code: "EG",
            restaurant_id: RESTAURANT,
            branch_id: 1,
            customer_id: CUSTOMER,
            customer_address_id: 1,
            delivery_lat: 30.0,
            delivery_lng: 31.0,
            delivery_address_text_snapshot: "addr",
            pickup_lat: 30.1,
            pickup_lng: 31.1,
            pickup_address_text_snapshot: "branch addr",
            branch_name_snapshot: "Branch 1",
            status: "delivered",
            subtotal: SUBTOTAL,
            delivery_fee: DELIVERY_FEE,
            service_fee: SERVICE_FEE,
            total: TOTAL,
            commission: 1000,
            currency: "EGP",
            payment_method: "cod",
            created_at: createdAt,
            updated_at: createdAt,
        })
        .returning(["id", "created_at"]);
    return {id: Number(row.id), createdAt: row.created_at};
}

async function seedChildren(order: {id: number; createdAt: Date}, ts: Date): Promise<void> {
    await hot()("order_items").insert({
        region: REGION,
        order_id: order.id,
        order_created_at: order.createdAt,
        product_id: 10,
        quantity: 2,
        unit_price_snapshot: 5000,
        name_snapshot: "Burger",
        line_total: 10000,
        created_at: ts,
    });

    const [treasuryRow] = await hot()("treasury_ledger")
        .insert({
            region: REGION,
            order_id: order.id,
            order_created_at: order.createdAt,
            entry_type: "cod_collection",
            method: "cod",
            status: "succeeded",
            amount: TOTAL,
            currency: "EGP",
            customer_id: CUSTOMER,
            idempotency_key: `cod:${order.id}`,
            created_at: ts,
            updated_at: ts,
        })
        .returning(["id"]);

    await hot()("payment_sessions").insert({
        region: REGION,
        order_id: order.id,
        order_created_at: order.createdAt,
        provider_id: 1,
        provider_session_id: `sess-${order.id}`,
        redirect_url: "http://x",
        amount: TOTAL,
        currency: "EGP",
        status: "captured",
        raw_init_payload: JSON.stringify({k: "v", orderId: order.id}),
        created_at: ts,
        updated_at: ts,
    });

    // payment_webhook_events uses `created_at`, keyed by (provider_id, provider_event_id).
    await hot()("payment_webhook_events").insert({
        region: REGION,
        provider_id: 1,
        provider_event_id: `evt-${order.id}`,
        signature: "sig",
        payload: JSON.stringify({event: "pay", orderId: order.id}),
        created_at: ts,
    });

    await hot()("restaurant_ledger").insert({
        region: REGION,
        restaurant_id: RESTAURANT,
        currency: "EGP",
        entry_type: "settlement_credit",
        amount: SUBTOTAL,
        balance_after: SUBTOTAL,
        order_id: order.id,
        order_created_at: order.createdAt,
        treasury_ledger_id: treasuryRow.id,
        created_at: ts,
    });

    await hot()("agent_ledger").insert({
        region: REGION,
        agent_id: AGENT,
        currency: "EGP",
        entry_type: "earning_credit",
        amount: 1200,
        balance_after: 1200,
        order_id: order.id,
        order_created_at: order.createdAt,
        treasury_ledger_id: treasuryRow.id,
        created_at: ts,
    });
}

async function count(conn: ReturnType<typeof hot>, table: string): Promise<number> {
    const row = await conn(table).count<{n: string}[]>("* as n").first();
    return Number(row?.n ?? 0);
}

const ARCHIVED_TABLES = ["restaurant_ledger", "agent_ledger", "payment_webhook_events", "payment_sessions", "treasury_ledger", "order_items", "orders"];

describe("cold archival worker", () => {
    beforeEach(async () => {
        await truncateAll(hot());
        await truncateAll(archive());
        // runArchivalWorker takes a per-region Redis lock (cacheProvider.trySet) with
        // a TTL derived from ARCHIVAL_MAX_RUNTIME_MIN; clear it so every test starts
        // able to acquire it rather than inheriting the previous test's lock.
        await cacheProvider.del(`archival:${REGION}:lock`);
    });

    afterAll(async () => {
        await destroyAll();
    });

    it("moves prior-year rows to archive and keeps current-year rows hot", async () => {
        const priorOrder = await seedOrder(PRIOR);
        await seedChildren(priorOrder, PRIOR);
        const currentOrder = await seedOrder(CURRENT);
        await seedChildren(currentOrder, CURRENT);

        await runArchivalWorker();

        for (const t of ARCHIVED_TABLES) {
            expect(await count(hot(), t)).toBe(1);
            expect(await count(archive(), t)).toBe(1);
        }

        // restaurant_balances / agent_balances are current running state, never archived.
        expect(await count(archive(), "restaurant_balances")).toBe(0);

        const hotOrder = await hot()("orders").select("id").first();
        const archivedOrder = await archive()("orders").select("id").first();
        expect(Number(hotOrder!.id)).toBe(currentOrder.id);
        expect(Number(archivedOrder!.id)).toBe(priorOrder.id);

        // JSONB survived the round-trip as real JSON (not "[object Object]").
        const movedSession = await archive()("payment_sessions").select("raw_init_payload").first();
        expect(movedSession!.raw_init_payload).toMatchObject({k: "v"});
    });

    it("is a no-op on a second run (nothing left to move)", async () => {
        const priorOrder = await seedOrder(PRIOR);
        await seedChildren(priorOrder, PRIOR);

        await runArchivalWorker();
        expect(await count(archive(), "orders")).toBe(1);

        await cacheProvider.del(`archival:${REGION}:lock`);
        await runArchivalWorker();

        expect(await count(hot(), "orders")).toBe(0);
        expect(await count(archive(), "orders")).toBe(1); // unchanged, not duplicated
    });

    it("does not duplicate rows when the same row is re-archived (ON CONFLICT DO NOTHING)", async () => {
        const priorOrder = await seedOrder(PRIOR);
        await seedChildren(priorOrder, PRIOR);

        // Simulate a crash that committed the archive copy but not the hot delete:
        // pre-copy the order into the archive, leave it in hot too.
        const hotRow = await hot()("orders").where({id: priorOrder.id}).first();
        const insertQuery = archive()("orders").insert(hotRow).onConflict(["id", "created_at"]).ignore();
        const {sql, bindings} = insertQuery.toSQL();
        // `orders.id` is GENERATED ALWAYS AS IDENTITY — knex has no builder API for
        // OVERRIDING SYSTEM VALUE, so splice it in, same as archival.worker.ts does.
        await archive().raw(sql.replace(/\)\s+values\s+\(/i, ") overriding system value values ("), bindings);
        expect(await count(archive(), "orders")).toBe(1);

        // Re-running must not throw and must not create a duplicate.
        await runArchivalWorker();
        expect(await count(archive(), "orders")).toBe(1);
        expect(await count(hot(), "orders")).toBe(0);
    });

    it("batches correctly across many rows (ARCHIVAL_BATCH_SIZE is small in .env.test)", async () => {
        for (let i = 0; i < 5; i++) {
            const o = await seedOrder(PRIOR);
            await seedChildren(o, PRIOR);
        }

        await runArchivalWorker();

        expect(await count(hot(), "orders")).toBe(0);
        expect(await count(archive(), "orders")).toBe(5);
    });
});
