import { PaymentSessionStatus, PayeeAccountType, TreasuryEntryType, TreasuryMethod, TreasuryStatus } from "./enums";
import { TreasuryLedgerEntry } from "./entity/treasury-ledger-entry.entity";

export interface OrderPayloadForPaymentInit {
    orderId: number; orderCreatedAt: Date; orderPublicId: string; customerId: number;
    amountMinor: number; currency: string; region: string;
}

export interface InitPaymentResult { redirectUrl: string; sessionId: string; expiresAt: string; }

export interface CreatePaymentSessionRow {
    region: string; orderId: number; orderCreatedAt: Date; providerId: number; providerSessionId: string;
    redirectUrl: string; amount: number; currency: string; status: PaymentSessionStatus; rawInitPayload: Record<string, unknown>;
}

export interface UpdatePaymentSessionInput { status: PaymentSessionStatus; rawLastPayload?: Record<string, unknown>; }

export interface CreateTreasuryEntryRow {
    region: string; orderId?: number; orderCreatedAt?: Date; entryType: TreasuryEntryType; method: TreasuryMethod;
    providerId?: number; providerReferenceId?: string; status: TreasuryStatus; amount: number; currency: string;
    customerId?: number; payeeAccountType?: PayeeAccountType; payeeAccountId?: number; idempotencyKey?: string;
}

export interface GetPaymentResult { transaction: TreasuryLedgerEntry; orderPublicId: string | null; refunds: TreasuryLedgerEntry[]; }

export interface UpdateTreasuryEntryInput {
    status?: TreasuryStatus; providerReferenceId?: string; isRefunded?: boolean; refundedEntryId?: number;
}

export interface PaymentOutboxPayload {
    treasuryLedgerId: number; region: string; orderId: number | null; orderCreatedAt: string | null;
    entryType: TreasuryEntryType; method: TreasuryMethod; providerId: number | null;
    status: TreasuryStatus; amount: number; currency: string; createdAt: string;
}
