import { AgentLedgerEntryType } from "./enums";

export interface AssignmentCandidate {
    agentId: number;
    distanceMeters: number;
    loadCount: number;
    score: number;
}

export interface EarningsRange {
    from: Date;
    to: Date;
}

export interface InsertAgentLedgerEntryRow {
    region: string;
    agentId: number;
    currency: string;
    entryType: AgentLedgerEntryType;
    amount: number;
    balanceAfter: number;
    orderId?: number;
    orderCreatedAt?: Date;
    treasuryLedgerId?: number;
    note?: string;
}

export interface PayoutRow {
    id: number;
    amount: number;
    currency: string;
    status: string;
    providerReferenceId: string | null;
    createdAt: Date;
}
