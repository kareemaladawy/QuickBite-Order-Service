import { Transaction } from "../entity/transaction.entity";
import { InitPaymentResult } from "../types";
import { PaymentProviderId, PaymentProviderName, TransactionMethod, TransactionStatus, TransactionType } from "../enums";

// Stays a pure, DB-free DTO mapper. COD has no entry here — it's a payment method
// (tx.method), not a provider, and its transactions carry providerId: null. A new
// seeded provider adds one more entry here.
const PROVIDER_NAME_BY_ID: Partial<Record<PaymentProviderId, PaymentProviderName>> = {
    [PaymentProviderId.KASHIER]: PaymentProviderName.KASHIER,
};

function providerName(providerId: number | null): PaymentProviderName | null {
    if (providerId === null) return null;
    return PROVIDER_NAME_BY_ID[providerId as PaymentProviderId] ?? null;
}

export class RefundSummaryDTO {
    id!: string;
    amount!: number;
    status!: TransactionStatus;
    createdAt!: string;

    static from(tx: Transaction): RefundSummaryDTO {
        const dto = new RefundSummaryDTO();
        dto.id = String(tx.id);
        dto.amount = tx.amount;
        dto.status = tx.status;
        dto.createdAt = tx.createdAt.toISOString();
        return dto;
    }
}

// POST /orders (online) response fragment + POST /payments/init response.
export class PaymentInitResponseDTO {
    redirectUrl!: string;
    sessionId!: string;
    expiresAt!: string;

    static from(result: InitPaymentResult): PaymentInitResponseDTO {
        const dto = new PaymentInitResponseDTO();
        dto.redirectUrl = result.redirectUrl;
        dto.sessionId = result.sessionId;
        dto.expiresAt = result.expiresAt;
        return dto;
    }
}

// GET /payments/{id} and POST /payments/{id}/refund response — a "payment" in the
// public API is a transactions row (see docs/business-logic/payments.md §1).
export class PaymentResponseDTO {
    id!: string;
    orderId!: string | null;
    type!: TransactionType;
    method!: TransactionMethod;
    provider!: PaymentProviderName | null;
    status!: TransactionStatus;
    amount!: number;
    currency!: string;
    providerReferenceId!: string | null;
    isRefunded!: boolean;
    createdAt!: string;
    updatedAt!: string;
    refunds!: RefundSummaryDTO[];

    static from(tx: Transaction, orderPublicId: string | null, refunds: Transaction[] = []): PaymentResponseDTO {
        const dto = new PaymentResponseDTO();
        dto.id = String(tx.id);
        dto.orderId = orderPublicId;
        dto.type = tx.transactionType;
        dto.method = tx.method;
        dto.provider = providerName(tx.providerId);
        dto.status = tx.status;
        dto.amount = tx.amount;
        dto.currency = tx.currency;
        dto.providerReferenceId = tx.providerReferenceId;
        dto.isRefunded = tx.isRefunded;
        dto.createdAt = tx.createdAt.toISOString();
        dto.updatedAt = tx.updatedAt.toISOString();
        dto.refunds = refunds.map(RefundSummaryDTO.from);
        return dto;
    }
}
