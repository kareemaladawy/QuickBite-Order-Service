import path from "path";
import { config } from "dotenv";
import { z } from "zod";
import { ShardConfig } from "./types";

// `TIMESTAMP` (no tz) columns don't carry a time zone — Postgres ignores any offset on
// the value it's given and stores/compares the literal digits. If this process' local
// zone isn't UTC, `new Date()` on write and `.toISOString()` on read disagree by that
// offset (e.g. cursor-pagination comparisons silently return the wrong rows). Forcing
// the process to UTC makes "local wall clock" and "UTC" the same digits, everywhere.
process.env.TZ = "UTC";

// C:\Users\ABDULLAH\Desktop\quickbite\order-service\.env
config({ path: path.resolve(__dirname, "../../../.env") });

const baseSchema = z.object({
    PORT: z.string().default("4000"),
    NODE_ENV: z.string().default("development"),

    ACCESS_SECRET: z.string(),
    REFRESH_SECRET: z.string(),
    ACCESS_EXPIRES_IN: z.string().default("3600"),
    REFRESH_EXPIRES_IN: z.string().default("604800"),

    CORS_ORIGINS: z.string().default("http://localhost:3000"),

    REGIONS: z.string().min(1),

    DB_POOL_MAX: z.string().default("10"),
    DB_MIGRATION_DIRECTORY: z.string().default("src/migrations"),
    DB_MIGRATION_EXTENSION: z.string().default("ts"),

    REDIS_HOST: z.string().default("localhost"),
    REDIS_PORT: z.string().default("6379"),
    REDIS_PASSWORD: z.string().default(""),

    RABBITMQ_URL: z.string(),
    RABBITMQ_CORE_EVENTS_EXCHANGE: z.string().default("core.events"),
    RABBITMQ_CORE_EVENTS_QUEUE: z.string().default("order-service.core-events"),
    RABBITMQ_CORE_EVENTS_BINDINGS: z
        .string()
        .default("product.#,branch.#,restaurant.#,rbac.#"),
    RABBITMQ_CORE_EVENTS_DLX: z.string().default("core.events.dlx"),
    RABBITMQ_CORE_EVENTS_DLQ: z.string().default("order-service.core-events.dlq"),
    RABBITMQ_PREFETCH: z.string().default("32"),

    CORE_SERVICE_BASE_URL: z.string(),
    CORE_INTERNAL_API_KEY: z.string(),

    WS_HEARTBEAT_SEC: z.string().default("30"),

    KASHIER_BASE_URL: z.string().default("https://test-api.kashier.io"),
    KASHIER_MERCHANT_ID: z.string(),
    KASHIER_API_KEY: z.string(),
    KASHIER_SECRET_KEY: z.string(),
    KASHIER_RETURN_URL: z.string(),
    // Public URL Kashier should POST payment events to — optional because a merchant
    // can instead register one in the Kashier dashboard's webhook management module,
    // and because it's meaningless against an unreachable localhost dev box.
    KASHIER_WEBHOOK_URL: z.string().optional(),
    // Named per-provider, not a global default — each provider configured in
    // lib/payments/init.ts carries its own returnUrl/sessionTimeoutMin, since a
    // different PSP isn't guaranteed to use the same redirect flow or session TTL.
    KASHIER_SESSION_TIMEOUT_MIN: z.string().default("15"),
    // region:providerName pairs — which online payment provider (if any) serves each
    // region. Kashier only settles in Egypt today; a second region gets its own
    // provider by adding one more pair here (see lib/payments/registry.ts).
    PAYMENT_PROVIDERS_BY_REGION: z.string().default("eg:kashier"),

    // docs/business-logic/orders.md §9 / payments.md §9 — a pending_payment order
    // whose online payment never completed is auto-cancelled (and its stock reserved
    // for it released) after this many minutes, by a background sweep.
    ORDER_PENDING_PAYMENT_TIMEOUT_MIN: z.string().default("15"),
    ORDER_SWEEP_INTERVAL_SEC: z.string().default("60"),

    // docs/business-logic/payments.md §9 — a succeeded charge whose order is still
    // stuck in pending_payment (the post-charge transition failed or never ran) gets
    // its `pending_payment -> placed` transition retried by a background reconciler.
    // `GRACE_SEC` keeps it from racing the webhook's own synchronous retry of that
    // same transition for a charge that only just succeeded.
    PAYMENT_RECONCILER_GRACE_SEC: z.string().default("120"),
    PAYMENT_RECONCILER_INTERVAL_SEC: z.string().default("60"),

    // docs/business-logic/agents.md §3 — broadcast/accept delivery assignment.
    ASSIGNMENT_RADIUS_METERS: z.string().default("5000"),
    ASSIGNMENT_CANDIDATE_POOL: z.string().default("20"),
    ASSIGNMENT_BROADCAST_SIZE: z.string().default("5"),
    ASSIGNMENT_SWEEP_CRON_SEC: z.string().default("15"),
    AGENT_ACCEPT_TIMEOUT_SEC: z.string().default("30"),
    LOAD_PENALTY_METERS: z.string().default("1500"),
    MAX_REASSIGNMENT_ATTEMPTS: z.string().default("5"),

    // docs/business-logic/agents.md §1 — agent presence & capacity.
    AGENT_MAX_CONCURRENT_ORDERS: z.string().default("3"),
    PRESENCE_STALE_SEC: z.string().default("300"),

    // docs/business-logic/agents.md §7 — flat share of the order's delivery fee.
    AGENT_EARNINGS_SHARE_PCT: z.string().default("80"),

    // docs/implementation-plan.md Phase 5 — nightly cold-archival worker (moves
    // prior-year rows from the hot cluster to the per-region archive cluster).
    ARCHIVAL_BATCH_SIZE: z.string().default("1000"),
    ARCHIVAL_MAX_RUNTIME_MIN: z.string().default("60"),
    ARCHIVAL_INTERVAL_SEC: z.string().default("86400"),
});

const parsed = baseSchema.parse(process.env);

function parseRegions(raw: string): string[] {
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function parseRegionProviderMap(raw: string): Record<string, string> {
    const map: Record<string, string> = {};
    for (const pair of raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
        const [region, provider] = pair.split(":").map((s) => s.trim());
        if (region && provider) map[region] = provider;
    }
    return map;
}

function readShardConfig(region: string, prefix: "DB" | "ARCHIVE_DB"): ShardConfig {
    const hostKey = `${prefix}_${region}_HOST`;
    const portKey = `${prefix}_${region}_PORT`;
    const userKey = `${prefix}_${region}_USERNAME`;
    const passKey = `${prefix}_${region}_PASSWORD`;
    const nameKey = `${prefix}_${region}_NAME`;

    const host = process.env[hostKey];
    const port = process.env[portKey];
    const username = process.env[userKey];
    const password = process.env[passKey];
    const name = process.env[nameKey];

    if (!host || !port || !username || name === undefined) {
        throw new Error(
            `Missing ${prefix} env for region "${region}". Expected: ${hostKey}, ${portKey}, ${userKey}, ${passKey}, ${nameKey}`,
        );
    }

    return {
        host,
        port: Number(port),
        username,
        password: password ?? "",
        name,
    };
}

const regions = parseRegions(parsed.REGIONS);
const hotShards: Record<string, ShardConfig> = {};
const archiveShards: Record<string, ShardConfig> = {};

for (const region of regions) {
    hotShards[region] = readShardConfig(region, "DB");
    archiveShards[region] = readShardConfig(region, "ARCHIVE_DB");
}

export const env = {
    port: Number(parsed.PORT),
    isProduction: parsed.NODE_ENV === "production",
    cors: { origins: parsed.CORS_ORIGINS.split(",").map((s) => s.trim()) },

    jwt: {
        accessSecret: parsed.ACCESS_SECRET,
        refreshSecret: parsed.REFRESH_SECRET,
        accessExpiresIn: parsed.ACCESS_EXPIRES_IN,
        refreshExpiresIn: parsed.REFRESH_EXPIRES_IN,
    },

    db: {
        poolMax: Number(parsed.DB_POOL_MAX),
        migrationDirectory: path.resolve(
            __dirname,
            "../../../",
            parsed.DB_MIGRATION_DIRECTORY,
        ),
        migrationExtension: parsed.DB_MIGRATION_EXTENSION,
    },

    regions,
    hotShards,
    archiveShards,

    redis: {
        host: parsed.REDIS_HOST,
        port: Number(parsed.REDIS_PORT),
        password: parsed.REDIS_PASSWORD || undefined,
    },

    rabbitmq: {
        url: parsed.RABBITMQ_URL,
        exchange: parsed.RABBITMQ_CORE_EVENTS_EXCHANGE,
        queue: parsed.RABBITMQ_CORE_EVENTS_QUEUE,
        bindings: parsed.RABBITMQ_CORE_EVENTS_BINDINGS.split(",").map((s) => s.trim()),
        dlx: parsed.RABBITMQ_CORE_EVENTS_DLX,
        dlq: parsed.RABBITMQ_CORE_EVENTS_DLQ,
        prefetch: Number(parsed.RABBITMQ_PREFETCH),
    },

    core: {
        baseUrl: parsed.CORE_SERVICE_BASE_URL,
        internalApiKey: parsed.CORE_INTERNAL_API_KEY,
    },

    ws: {
        heartbeatSec: Number(parsed.WS_HEARTBEAT_SEC),
    },

    // Kashier's webhook signature is HMAC-SHA256 over `data` fields using the Payment
    // API key (same value as `apiKey` below) — there is no separate webhook secret on
    // Kashier's side, so unlike the plan draft we don't carry a KASHIER_WEBHOOK_SECRET.
    kashier: {
        baseUrl: parsed.KASHIER_BASE_URL,
        merchantId: parsed.KASHIER_MERCHANT_ID,
        apiKey: parsed.KASHIER_API_KEY,
        secretKey: parsed.KASHIER_SECRET_KEY,
        returnUrl: parsed.KASHIER_RETURN_URL,
        webhookUrl: parsed.KASHIER_WEBHOOK_URL,
        sessionTimeoutMin: Number(parsed.KASHIER_SESSION_TIMEOUT_MIN),
    },

    payments: {
        regionProviderMap: parseRegionProviderMap(parsed.PAYMENT_PROVIDERS_BY_REGION),
    },

    orders: {
        pendingPaymentTimeoutMin: Number(parsed.ORDER_PENDING_PAYMENT_TIMEOUT_MIN),
        sweepIntervalSec: Number(parsed.ORDER_SWEEP_INTERVAL_SEC),
    },

    paymentReconciler: {
        graceSec: Number(parsed.PAYMENT_RECONCILER_GRACE_SEC),
        intervalSec: Number(parsed.PAYMENT_RECONCILER_INTERVAL_SEC),
    },

    assignment: {
        radiusMeters: Number(parsed.ASSIGNMENT_RADIUS_METERS),
        candidatePool: Number(parsed.ASSIGNMENT_CANDIDATE_POOL),
        broadcastSize: Number(parsed.ASSIGNMENT_BROADCAST_SIZE),
        sweepCronSec: Number(parsed.ASSIGNMENT_SWEEP_CRON_SEC),
        acceptTimeoutSec: Number(parsed.AGENT_ACCEPT_TIMEOUT_SEC),
        loadPenaltyMeters: Number(parsed.LOAD_PENALTY_METERS),
        maxReassignmentAttempts: Number(parsed.MAX_REASSIGNMENT_ATTEMPTS),
    },

    agents: {
        maxConcurrentOrders: Number(parsed.AGENT_MAX_CONCURRENT_ORDERS),
        presenceStaleSec: Number(parsed.PRESENCE_STALE_SEC),
        earningsSharePct: Number(parsed.AGENT_EARNINGS_SHARE_PCT),
    },

    archival: {
        batchSize: Number(parsed.ARCHIVAL_BATCH_SIZE),
        maxRuntimeMin: Number(parsed.ARCHIVAL_MAX_RUNTIME_MIN),
        intervalSec: Number(parsed.ARCHIVAL_INTERVAL_SEC),
    },
};
