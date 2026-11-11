/**
 * Single-shot reset+seed for the QuickBite test rig.
 *
 *   npx tsx scripts/reset-and-seed.ts
 *   CLEAN_ONLY=1 npx tsx scripts/reset-and-seed.ts   # just truncate, no seed
 *
 * What it does:
 *   1. Truncates every business table on:
 *        - core-service DB (quickbite_core)         — preserves the RBAC catalog
 *        - order-service hot shards (per env.regions)
 *      The RBAC catalog (roles + permissions + role_permissions) is preserved
 *      so we don't have to re-run the seed migrations every time.
 *
 *   2. Seeds core-service with a deterministic fixture so the Postman
 *      collection has matching IDs / emails / passwords (see TESTING_GUIDE.md).
 *
 *   3. Re-creates monthly partitions for the orders table on both order shards
 *      (cheap, idempotent — needs to happen because we just truncated everything).
 *
 *   4. Refreshes the payment_providers row on the EG shard (kashier).
 *
 * Designed to be run repeatedly between manual QA cycles — fast, deterministic,
 * and produces the same IDs every time because we RESTART IDENTITY on every
 * truncate so sequences come back to 1.
 */
import { Client } from "pg";
import bcrypt from "bcrypt";
import { env } from "../src/lib/config/env";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────
const PASSWORDS = {
    admin: "Admin@1234",
    customer: "Customer@1234",
    owner: "Owner@1234",
    manager: "Manager@1234",
    staff: "Staff@1234",
    agent: "Agent@1234",
};

const USERS = [
    { key: "admin", email: "admin@quickbite.test", phone: "0100000001", name: "Sys Admin", role: "system_admin" },
    { key: "customer", email: "customer@quickbite.test", phone: "0100000002", name: "Cathy Customer", role: "customer" },
    { key: "owner", email: "owner@quickbite.test", phone: "0100000003", name: "Olivia Owner", role: "restaurant_user" },
    { key: "manager", email: "manager@quickbite.test", phone: "0100000004", name: "Mike Manager", role: "restaurant_user" },
    { key: "staff", email: "staff@quickbite.test", phone: "0100000005", name: "Steve Staff", role: "restaurant_user" },
    { key: "agent_eg", email: "agent.eg@quickbite.test", phone: "0100000006", name: "Adam Agent EG", role: "delivery_agent" },
    { key: "agent_sa", email: "agent.sa@quickbite.test", phone: "0100000007", name: "Ali Agent SA", role: "delivery_agent" },
] as const;

type UserKey = (typeof USERS)[number]["key"];

const PWD_FOR_USER: Record<UserKey, keyof typeof PASSWORDS> = {
    admin: "admin",
    customer: "customer",
    owner: "owner",
    manager: "manager",
    staff: "staff",
    agent_eg: "agent",
    agent_sa: "agent",
};

const RESTAURANT = {
    name: "Tasty Bites",
    logo_url: "https://placehold.co/200x200?text=Tasty+Bites",
    primary_region: "eg",
};

// Branches (one per region)
const BRANCH_EG = {
    country_code: "eg",
    label: "Tasty Bites — Cairo Downtown",
    address_text: "12 Tahrir St, Downtown, Cairo",
    lat: 30.0444,
    long: 31.2357,
    opens_at: "08:00:00",
    closes_at: "23:59:00",
    delivery_radius: 15, // km
    delivery_fee: 1500,  // 15.00 EGP
    currency: "EGP",
    commission_percentage: 10,
};

const BRANCH_SA = {
    country_code: "sa",
    label: "Tasty Bites — Riyadh Olaya",
    address_text: "King Fahd Rd, Olaya, Riyadh",
    lat: 24.7136,
    long: 46.6753,
    opens_at: "08:00:00",
    closes_at: "23:59:00",
    delivery_radius: 20,
    delivery_fee: 800,  // 8.00 SAR
    currency: "SAR",
    commission_percentage: 10,
};

const CATEGORIES = ["Burgers", "Pizza", "Drinks"];

const PRODUCTS: Array<{ name: string; description: string; image_url: string; category: string; price_eg: number; price_sa: number; stock: number }> = [
    { name: "Classic Burger", description: "Beef patty, lettuce, tomato, special sauce", image_url: "https://placehold.co/300?text=Burger", category: "Burgers", price_eg: 5000, price_sa: 2500, stock: 50 },
    { name: "Cheese Burger", description: "Classic burger + double cheddar", image_url: "https://placehold.co/300?text=Cheese", category: "Burgers", price_eg: 6500, price_sa: 3200, stock: 40 },
    { name: "Pepperoni Pizza", description: "12-inch, pepperoni, mozzarella, tomato sauce", image_url: "https://placehold.co/300?text=Pizza", category: "Pizza", price_eg: 12000, price_sa: 6000, stock: 30 },
    { name: "Margherita Pizza", description: "12-inch, mozzarella, basil, tomato sauce", image_url: "https://placehold.co/300?text=Margh", category: "Pizza", price_eg: 10000, price_sa: 5000, stock: 30 },
    { name: "Cola 500ml", description: "Chilled", image_url: "https://placehold.co/300?text=Cola", category: "Drinks", price_eg: 1500, price_sa: 800, stock: 100 },
];

// Customer addresses (close to branches so they fall within delivery_radius)
const ADDRESSES = [
    { label: "Home — Cairo", country: "eg", city: "Cairo", street: "10 Talaat Harb", building: "B3", apartment_number: "5", type: "home", lat: 30.0500, long: 31.2400, is_default: true },
    { label: "Office — Riyadh", country: "sa", city: "Riyadh", street: "Olaya St 22", building: "A1", apartment_number: "3", type: "office", lat: 24.7200, long: 46.6800, is_default: false },
];

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────
function coreClient(): Client {
    return new Client({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 5432),
        user: process.env.DB_USERNAME ?? "postgres",
        password: process.env.DB_PASSWORD ?? "root",
        database: process.env.CORE_DB_NAME ?? "quickbite-core",
    });
}

function orderClient(region: string): Client {
    const shard = env.hotShards[region];
    if (!shard) throw new Error(`No hot shard for region "${region}"`);
    return new Client({
        host: shard.host,
        port: shard.port,
        user: shard.username,
        password: shard.password,
        database: shard.name,
    });
}

async function withClient<T>(c: Client, fn: (c: Client) => Promise<T>): Promise<T> {
    await c.connect();
    try {
        return await fn(c);
    } finally {
        await c.end();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Truncate everything
// ─────────────────────────────────────────────────────────────────────────────
async function cleanCore(c: Client): Promise<void> {
    console.log("[core] truncating business tables (preserving RBAC catalog)");
    await c.query(`
        TRUNCATE TABLE
            product_branch,
            products,
            product_categories,
            member_branch,
            restaurant_members,
            branches,
            restaurants,
            customer_addresses,
            password_resets,
            events_outbox,
            users
        RESTART IDENTITY CASCADE;
    `);
}

async function cleanOrderShard(c: Client, region: string): Promise<void> {
    console.log(`[order/${region}] truncating order tables`);
    // payment_providers + restaurant_balances/agent_balances are tiny lookups/aggregates;
    // we wipe them too so a fresh seed cycle is fully deterministic.
    await c.query(`
        TRUNCATE TABLE
            agent_ledger,
            restaurant_ledger,
            treasury_ledger,
            payment_webhook_events,
            payment_sessions,
            order_items,
            orders,
            restaurant_balances,
            agent_balances,
            events_outbox,
            payment_providers
        RESTART IDENTITY CASCADE;
    `);

    // Drop existing month partitions so create-partitions can re-make them.
    const { rows } = await c.query<{ partition: string }>(`
        SELECT inhrelid::regclass::text AS partition
        FROM pg_inherits
        WHERE inhparent = 'orders'::regclass AND inhrelid::regclass::text <> 'orders_default'
    `);
    for (const r of rows) {
        await c.query(`DROP TABLE IF EXISTS ${r.partition} CASCADE`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed core
// ─────────────────────────────────────────────────────────────────────────────
async function seedCore(c: Client): Promise<{ userIds: Record<UserKey, number>; restaurantId: number; branchEgId: number; branchSaId: number; productIds: number[]; addressIds: number[] }> {
    console.log("[core] seeding users, restaurant, branches, products, addresses");

    const userIds = {} as Record<UserKey, number>;
    for (const u of USERS) {
        const passwordPlain = PASSWORDS[PWD_FOR_USER[u.key]];
        const hash = await bcrypt.hash(passwordPlain, 10);
        const res = await c.query<{ id: number }>(
            `INSERT INTO users (email, phone, name, password_hash, system_role, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,NOW(),NOW()) RETURNING id`,
            [u.email, u.phone, u.name, hash, u.role],
        );
        userIds[u.key] = res.rows[0].id;
    }

    const restRes = await c.query<{ id: number }>(
        `INSERT INTO restaurants (owner_id, name, logo_url, status, primary_region, created_at, updated_at, status_updated_at)
         VALUES ($1,$2,$3,'active',$4,NOW(),NOW(),NOW()) RETURNING id`,
        [userIds.owner, RESTAURANT.name, RESTAURANT.logo_url, RESTAURANT.primary_region],
    );
    const restaurantId = restRes.rows[0].id;

    // Branches (active + accepting). location is auto-generated from lat/long.
    const insertBranch = async (b: typeof BRANCH_EG): Promise<number> => {
        const r = await c.query<{ id: number }>(
            `INSERT INTO branches
                (restaurant_id, country_code, address_text, label, lat, long,
                 is_active, opens_at, closes_at, accepts_orders, created_at, updated_at,
                 delivery_radius, currency, commission_percentage)
             VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8,TRUE,NOW(),NOW(),$9,$10,$11) RETURNING id`,
            [restaurantId, b.country_code, b.address_text, b.label, b.lat, b.long,
                b.opens_at, b.closes_at, b.delivery_radius, b.currency, b.commission_percentage],
        );
        return r.rows[0].id;
    };
    const branchEgId = await insertBranch(BRANCH_EG);
    const branchSaId = await insertBranch(BRANCH_SA);

    // delivery_fee is a separate column on this schema — set it explicitly.
    await c.query(`UPDATE branches SET delivery_fee=$1 WHERE id=$2`, [BRANCH_EG.delivery_fee, branchEgId]);
    await c.query(`UPDATE branches SET delivery_fee=$1 WHERE id=$2`, [BRANCH_SA.delivery_fee, branchSaId]);

    // Restaurant members
    // owner is auto wired (we DIY here because we wiped the DB; the
    // /auth/register flow normally does this in one trx).
    const ownerRoleId = (await c.query<{ id: number }>(`SELECT id FROM roles WHERE name='owner'`)).rows[0].id;
    const managerRoleId = (await c.query<{ id: number }>(`SELECT id FROM roles WHERE name='branch_manager'`)).rows[0].id;
    const staffRoleId = (await c.query<{ id: number }>(`SELECT id FROM roles WHERE name='staff'`)).rows[0].id;

    const insertMember = async (userId: number, roleId: number): Promise<number> => {
        const r = await c.query<{ id: number }>(
            `INSERT INTO restaurant_members (restaurant_id, user_id, role_id, status, created_at, updated_at)
             VALUES ($1,$2,$3,'active',NOW(),NOW()) RETURNING id`,
            [restaurantId, userId, roleId],
        );
        return r.rows[0].id;
    };
    /* ownerMemberId */ await insertMember(userIds.owner, ownerRoleId);
    const managerMemberId = await insertMember(userIds.manager, managerRoleId);
    const staffMemberId = await insertMember(userIds.staff, staffRoleId);

    // member_branch: manager + staff both bound to EG branch
    await c.query(`INSERT INTO member_branch (member_id, branch_id) VALUES ($1,$2)`, [managerMemberId, branchEgId]);
    await c.query(`INSERT INTO member_branch (member_id, branch_id) VALUES ($1,$2)`, [staffMemberId, branchEgId]);

    // Categories per restaurant
    const categoryIds: Record<string, number> = {};
    for (const name of CATEGORIES) {
        const r = await c.query<{ id: number }>(
            `INSERT INTO product_categories (restaurant_id, name, created_at, updated_at)
             VALUES ($1,$2,NOW(),NOW()) RETURNING id`,
            [restaurantId, name],
        );
        categoryIds[name] = r.rows[0].id;
    }

    // Products. The trigger auto-fills product_branch with
    // (price=0, stock=0, is_available=false) for every branch — we then UPDATE
    // each pbd row to set real price/stock and flip is_available=true.
    const productIds: number[] = [];
    for (const p of PRODUCTS) {
        const r = await c.query<{ id: number }>(
            `INSERT INTO products (name, description, image_url, restaurant_id, category_id, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,NOW(),NOW()) RETURNING id`,
            [p.name, p.description, p.image_url, restaurantId, categoryIds[p.category]],
        );
        const productId = r.rows[0].id;
        productIds.push(productId);

        await c.query(
            `UPDATE product_branch SET price=$1, stock=$2, is_available=TRUE WHERE branch_id=$3 AND product_id=$4`,
            [p.price_eg, p.stock, branchEgId, productId],
        );
        await c.query(
            `UPDATE product_branch SET price=$1, stock=$2, is_available=TRUE WHERE branch_id=$3 AND product_id=$4`,
            [p.price_sa, p.stock, branchSaId, productId],
        );
    }

    // Customer addresses
    const addressIds: number[] = [];
    for (const a of ADDRESSES) {
        const r = await c.query<{ id: number }>(
            `INSERT INTO customer_addresses
                (user_id, label, country, city, street, building, apartment_number, type, lat, long, is_default, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) RETURNING id`,
            [userIds.customer, a.label, a.country, a.city, a.street, a.building, a.apartment_number, a.type, a.lat, a.long, a.is_default],
        );
        addressIds.push(r.rows[0].id);
    }

    return { userIds, restaurantId, branchEgId, branchSaId, productIds, addressIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed order shards (just the payment_providers lookup row for EG)
// ─────────────────────────────────────────────────────────────────────────────
async function seedOrderShard(c: Client, region: string): Promise<void> {
    if (region === "eg") {
        await c.query(`INSERT INTO payment_providers (id, name, is_enabled, priority) VALUES (1, 'kashier', TRUE, 10) ON CONFLICT DO NOTHING`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-create month partitions
// ─────────────────────────────────────────────────────────────────────────────
function pad(n: number): string {
    return String(n).padStart(2, "0");
}

async function recreatePartitions(c: Client, region: string): Promise<void> {
    const now = new Date();
    const months = 12;
    const ranges: Array<{ name: string; from: string; to: string }> = [];
    const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    for (let i = 0; i < months; i++) {
        const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
        ranges.push({
            name: `orders_${cursor.getUTCFullYear()}_${pad(cursor.getUTCMonth() + 1)}`,
            from: `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-01`,
            to: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-01`,
        });
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    for (const r of ranges) {
        await c.query(`CREATE TABLE IF NOT EXISTS ${r.name} PARTITION OF orders FOR VALUES FROM ('${r.from}') TO ('${r.to}')`);
        console.log(`[order/${region}] partition ${r.name}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    const cleanOnly = process.env.CLEAN_ONLY === "1";

    // 1. Core
    const cc = coreClient();
    let seedResult: Awaited<ReturnType<typeof seedCore>> | null = null;
    await withClient(cc, async (c) => {
        await cleanCore(c);
        if (!cleanOnly) {
            seedResult = await seedCore(c);
        }
    });

    // 2. Order shards (clean → re-partition → tiny seed)
    for (const region of env.regions) {
        const oc = orderClient(region);
        await withClient(oc, async (c) => {
            await cleanOrderShard(c, region);
            await recreatePartitions(c, region);
            if (!cleanOnly) {
                await seedOrderShard(c, region);
            }
        });
    }

    if (cleanOnly || !seedResult) {
        console.log("\n✓ DB cleaned (no seed).");
        return;
    }

    // 3. Pretty-print the IDs Postman needs
    const ids = seedResult;
    console.log("\n──────────────────────────────────────────────────────────────");
    console.log("Seed complete. Postman environment variables:");
    console.log("──────────────────────────────────────────────────────────────");
    const out = {
        // services
        coreBaseUrl: "http://localhost:3000/api",
        orderBaseUrl: "http://localhost:4000/api",
        internalApiKey: process.env.INTERNAL_API_KEY ?? "dev-order-service-key-change-me",

        // accounts (passwords)
        adminEmail: "admin@quickbite.test", adminPassword: PASSWORDS.admin,
        customerEmail: "customer@quickbite.test", customerPassword: PASSWORDS.customer,
        ownerEmail: "owner@quickbite.test", ownerPassword: PASSWORDS.owner,
        managerEmail: "manager@quickbite.test", managerPassword: PASSWORDS.manager,
        staffEmail: "staff@quickbite.test", staffPassword: PASSWORDS.staff,
        agentEgEmail: "agent.eg@quickbite.test", agentEgPassword: PASSWORDS.agent,
        agentSaEmail: "agent.sa@quickbite.test", agentSaPassword: PASSWORDS.agent,

        // ids
        adminUserId: ids.userIds.admin,
        customerUserId: ids.userIds.customer,
        ownerUserId: ids.userIds.owner,
        managerUserId: ids.userIds.manager,
        staffUserId: ids.userIds.staff,
        agentEgUserId: ids.userIds.agent_eg,
        agentSaUserId: ids.userIds.agent_sa,
        restaurantId: ids.restaurantId,
        branchEgId: ids.branchEgId,
        branchSaId: ids.branchSaId,
        productIds: ids.productIds,
        addressEgId: ids.addressIds[0],
        addressSaId: ids.addressIds[1],
    };
    console.log(JSON.stringify(out, null, 2));
    console.log("──────────────────────────────────────────────────────────────");
    console.log("Open postman/QuickBite.postman_environment.json — IDs already wired.");
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
