import { Knex } from "knex";
import { AgentEarning } from "../entity/agent-earning.entity";
import { PaginationParams } from "../../../lib/http/pagination/types";
import { applyCursorPagination } from "../../../lib/http/pagination/cursor-pagination";

const AGENT_EARNING_COLUMNS = ["id", "region", "agent_id", "order_id", "order_created_at", "amount", "currency", "earned_at"];

function toEntity(row: any): AgentEarning {
    return new AgentEarning({
        id: Number(row.id),
        region: row.region,
        agentId: Number(row.agent_id),
        orderId: Number(row.order_id),
        orderCreatedAt: row.order_created_at,
        amount: row.amount,
        currency: row.currency,
        earnedAt: row.earned_at,
    });
}

// Unique on order_id makes this idempotent — called once, inside the trx delivery.service
// already owns, on an order's `delivered` transition (agents.md §7). `onConflict` is a
// defensive no-op guard, not the primary idempotency mechanism (the order can only reach
// `delivered` once; this matters if a crash mid-settlement is ever retried).
export async function insertEarning(
    data: {
        region: string;
        agentId: number;
        orderId: number;
        orderCreatedAt: Date;
        amount: number;
        currency: string;
    },
    conn: Knex,
): Promise<AgentEarning> {
    const rows = await conn("agent_earnings")
        .insert({
            region: data.region,
            agent_id: data.agentId,
            order_id: data.orderId,
            order_created_at: data.orderCreatedAt,
            amount: data.amount,
            currency: data.currency,
            earned_at: new Date(),
        })
        .onConflict("order_id")
        .ignore()
        .returning(AGENT_EARNING_COLUMNS);

    // ON CONFLICT DO NOTHING returns no row on a conflict (Postgres never re-runs
    // RETURNING against the pre-existing row) — re-read it so this stays idempotent
    // end-to-end for a retried settlement.
    if (rows.length === 0) {
        const existing = await conn("agent_earnings").where("order_id", data.orderId).select(AGENT_EARNING_COLUMNS).first();
        return toEntity(existing);
    }

    return toEntity(rows[0]);
}

export async function findByAgent(
    agentId: number,
    range: { from: Date; to: Date },
    pagination: PaginationParams,
    conn: Knex,
): Promise<AgentEarning[]> {
    let query = conn("agent_earnings")
        .where("agent_id", agentId)
        .where("earned_at", ">=", range.from)
        .where("earned_at", "<=", range.to)
        .select(AGENT_EARNING_COLUMNS);
    query = applyCursorPagination(query, pagination);
    return (await query).map(toEntity);
}

// Totals for the same range — one aggregate query, no app-side summation over a
// potentially-paginated result set.
export async function sumByAgent(
    agentId: number,
    range: { from: Date; to: Date },
    conn: Knex,
): Promise<{ count: number; sum: number }> {
    const row = await conn("agent_earnings")
        .where("agent_id", agentId)
        .where("earned_at", ">=", range.from)
        .where("earned_at", "<=", range.to)
        .select(conn.raw("COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::int AS sum"))
        .first<{ count: number; sum: number }>();
    return { count: row?.count ?? 0, sum: row?.sum ?? 0 };
}
