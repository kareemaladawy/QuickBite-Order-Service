// Account ledger entry types for an agent's balance — mirrors
// app/restaurant-finance/enums.ts's RestaurantLedgerEntryType. No refund_debit here:
// agent earnings aren't clawed back on a customer refund (out of scope — restaurant
// clawback only, see restaurant-finance.service.ts::recordRefundClawback).
export enum AgentLedgerEntryType {
    EARNING_CREDIT = "earning_credit",
    PAYOUT_DEBIT = "payout_debit",
    ADJUSTMENT = "adjustment",
}
