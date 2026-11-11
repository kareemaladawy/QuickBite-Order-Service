// Account ledger entry types — internal accounting concepts (commission, manual
// adjustment) live here, never in the treasury ledger (app/payment), which only
// records real-world money events.
export enum RestaurantLedgerEntryType {
    SETTLEMENT_CREDIT = "settlement_credit",
    COMMISSION_DEBIT = "commission_debit",
    REFUND_DEBIT = "refund_debit",
    PAYOUT_DEBIT = "payout_debit",
    ADJUSTMENT = "adjustment",
}
