import { Knex } from "knex";
import { AgentLedgerEntry } from "../entity/agent-ledger-entry.entity";
import { AgentLedgerEntryType } from "../enums";
import { PaginationParams } from "../../../lib/http/pagination/types";
import { applyCursorPagination } from "../../../lib/http/pagination/cursor-pagination";
import { InsertAgentLedgerEntryRow } from "../types";

const AGENT_LEDGER_COLUMNS = [
    "id", "region", "agent_id", "currency", "entry_type", "amount", "balance_after",
    "order_id", "order_created_at", "treasury_ledger_id", "note", "created_at",
];

function toEntity(row: any): AgentLedgerEntry {
    return new AgentLedgerEntry({
        id: Number(row.id), region: row.region, agentId: Number(row.agent_id), currency: row.currency,
        entryType: row.entry_type, amount: row.amount, balanceAfter: row.balance_after,
        orderId: row.order_id === null ? null : Number(row.order_id), orderCreatedAt: row.order_created_at,
        treasuryLedgerId: row.treasury_ledger_id === null ? null : Number(row.treasury_ledger_id),
        note: row.note, createdAt: row.created_at,
    });
}

export async function insertLedgerEntry(data: InsertAgentLedgerEntryRow, conn: Knex): Promise<AgentLedgerEntry> {
    const [row] = await conn("agent_ledger")
        .insert({
            region: data.region, agent_id: data.agentId, currency: data.currency, entry_type: data.entryType,
            amount: data.amount, balance_after: data.balanceAfter, order_id: data.orderId ?? null,
            order_created_at: data.orderCreatedAt ?? null, treasury_ledger_id: data.treasuryLedgerId ?? null,
            note: data.note ?? null, created_at: new Date(),
        })
        .returning(AGENT_LEDGER_COLUMNS);
    return toEntity(row);
}

// Backed by idx_agent_ledger_agent_created_at — supports GET /agents/earnings, filtered
// to `earning_credit` rows (earnings reporting replaces the old agent_earnings table).
export async function findEarningsByAgent(
    agentId: number,
    range: { from: Date; to: Date },
    pagination: PaginationParams,
    conn: Knex,
): Promise<AgentLedgerEntry[]> {
    let query = conn("agent_ledger")
        .where("agent_id", agentId).where("entry_type", AgentLedgerEntryType.EARNING_CREDIT)
        .where("created_at", ">=", range.from).where("created_at", "<=", range.to)
        .select(AGENT_LEDGER_COLUMNS);
    query = applyCursorPagination(query, pagination);
    return (await query).map(toEntity);
}

export async function sumEarningsByAgent(agentId: number, range: { from: Date; to: Date }, conn: Knex): Promise<{ count: number; sum: number }> {
    const row = await conn("agent_ledger")
        .where("agent_id", agentId).where("entry_type", AgentLedgerEntryType.EARNING_CREDIT)
        .where("created_at", ">=", range.from).where("created_at", "<=", range.to)
        .select(conn.raw("COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::int AS sum"))
        .first<{ count: number; sum: number }>();
    return { count: row?.count ?? 0, sum: row?.sum ?? 0 };
}
