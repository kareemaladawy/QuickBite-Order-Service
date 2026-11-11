// COD is a payment *method* (see TreasuryMethod.COD below), not a payment
// provider — it has no gateway, no session, no webhook, and no row in
// payment_providers. Only real payment gateways belong here.
export enum PaymentProviderName {
    KASHIER = "kashier",
}

export enum PaymentProviderId {
    KASHIER = 1,
}

export enum PaymentSessionStatus {
    INITIALIZED = "initialized",
    PENDING = "pending",
    AUTHORIZED = "authorized",
    CAPTURED = "captured",
    FAILED = "failed",
    EXPIRED = "expired",
    CANCELLED = "cancelled",
}

// Treasury ledger — one row per real-world money event. Commission and other
// internal-accounting-only concepts live in the account ledgers instead (see
// restaurant-finance/agent enums.ts), never here.
export enum TreasuryEntryType {
    CHARGE = "charge",
    REFUND = "refund",
    PAYOUT = "payout",
    COD_COLLECTION = "cod_collection",
}

export enum TreasuryMethod {
    ONLINE = "online",
    COD = "cod",
    BANK_TRANSFER = "bank_transfer",
}

export enum TreasuryStatus {
    PENDING = "pending",
    SUCCEEDED = "succeeded",
    FAILED = "failed",
    REVERSED = "reversed",
}

// Who a payout treasury entry was paid out to — resolves straight to
// `restaurants.id` / `agents.id`, never a core.users id (see types.ts note).
export enum PayeeAccountType {
    RESTAURANT = "restaurant",
    AGENT = "agent",
}
