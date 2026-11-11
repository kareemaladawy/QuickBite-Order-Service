import { Knex } from "knex";
import { AgentBalance } from "../entity/agent-balance.entity";

const AGENT_BALANCE_COLUMNS = ["agent_id", "region", "currency", "balance", "updated_at"];

function toEntity(row: any): AgentBalance {
    return new AgentBalance({
        agentId: Number(row.agent_id),
        region: row.region,
        currency: row.currency,
        balance: row.balance,
        updatedAt: row.updated_at,
    });
}

export async function findBalancesByAgent(agentId: number, conn: Knex): Promise<AgentBalance[]> {
    const rows = await conn("agent_balances").where("agent_id", agentId).select(AGENT_BALANCE_COLUMNS);
    return rows.map(toEntity);
}

// Same atomic-upsert shape as restaurant-finance's creditBalance — see that file's
// comment for why this is safe under concurrency without an explicit row lock.
export async function creditBalance(
    agentId: number,
    region: string,
    currency: string,
    deltaMinor: number,
    conn: Knex,
): Promise<AgentBalance> {
    const [row] = await conn("agent_balances")
        .insert({ agent_id: agentId, region, currency, balance: deltaMinor, updated_at: new Date() })
        .onConflict(["agent_id", "currency"])
        .merge({
            balance: conn.raw("agent_balances.balance + ?", [deltaMinor]),
            updated_at: new Date(),
        })
        .returning(AGENT_BALANCE_COLUMNS);
    return toEntity(row);
}

export async function debitIfSufficient(
    agentId: number,
    currency: string,
    amountMinor: number,
    conn: Knex,
): Promise<AgentBalance | undefined> {
    const [row] = await conn("agent_balances")
        .where({ agent_id: agentId, currency })
        .andWhere("balance", ">=", amountMinor)
        .update({ balance: conn.raw("balance - ?", [amountMinor]), updated_at: new Date() })
        .returning(AGENT_BALANCE_COLUMNS);
    return row ? toEntity(row) : undefined;
}
