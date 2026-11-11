import { AgentLedgerEntryType } from "../enums";

export class AgentLedgerEntry {
    id: number;
    region: string;
    agentId: number;
    currency: string;
    entryType: AgentLedgerEntryType;
    amount: number; // signed minor units — positive = credit, negative = debit
    balanceAfter: number; // snapshot of agent_balances.balance right after this row
    orderId: number | null;
    orderCreatedAt: Date | null;
    treasuryLedgerId: number | null;
    note: string | null;
    createdAt: Date;

    constructor(data: Partial<AgentLedgerEntry>) {
        this.id = data.id!;
        this.region = data.region!;
        this.agentId = data.agentId!;
        this.currency = data.currency!;
        this.entryType = data.entryType!;
        this.amount = data.amount!;
        this.balanceAfter = data.balanceAfter!;
        this.orderId = data.orderId ?? null;
        this.orderCreatedAt = data.orderCreatedAt ?? null;
        this.treasuryLedgerId = data.treasuryLedgerId ?? null;
        this.note = data.note ?? null;
        this.createdAt = data.createdAt!;
    }
}
