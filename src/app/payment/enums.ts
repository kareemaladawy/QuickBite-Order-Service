// COD is a payment *method* (see TransactionMethod.COD below), not a payment
// provider — it has no gateway, no session, no webhook, and no row in
// payment_providers. Only real payment gateways belong here.
export enum PaymentProviderName {
    KASHIER = "kashier",
}

// Matches the seed in 20260418000010_create_payment_providers.ts — hardcoded rather
// than read through on every hot-path write; the table itself exists for the
// is_enabled kill-switch (checked in PaymentService.init) and future admin tooling.
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

export enum TransactionType {
    CHARGE = "charge",
    REFUND = "refund",
    COMMISSION = "commission",
    PAYOUT = "payout",
    COD_COLLECTION = "cod_collection",
    ADJUSTMENT = "adjustment",
}

export enum TransactionMethod {
    ONLINE = "online",
    COD = "cod",
    BANK_TRANSFER = "bank_transfer",
    SYSTEM = "system",
}

export enum TransactionStatus {
    PENDING = "pending",
    SUCCEEDED = "succeeded",
    FAILED = "failed",
    REVERSED = "reversed",
}
