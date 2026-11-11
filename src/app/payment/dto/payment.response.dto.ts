import { TreasuryLedgerEntry } from "../entity/treasury-ledger-entry.entity";
import { InitPaymentResult } from "../types";
import { PaymentProviderId, PaymentProviderName, TreasuryEntryType, TreasuryMethod, TreasuryStatus } from "../enums";

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
    status!: TreasuryStatus;
    createdAt!: string;

    static from(entry: TreasuryLedgerEntry): RefundSummaryDTO {
        const dto = new RefundSummaryDTO();
        dto.id = String(entry.id);
        dto.amount = entry.amount;
        dto.status = entry.status;
        dto.createdAt = entry.createdAt.toISOString();
        return dto;
    }
}

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

export class PaymentResponseDTO {
    id!: string;
    orderId!: string | null;
    type!: TreasuryEntryType;
    method!: TreasuryMethod;
    provider!: PaymentProviderName | null;
    status!: TreasuryStatus;
    amount!: number;
    currency!: string;
    providerReferenceId!: string | null;
    isRefunded!: boolean;
    createdAt!: string;
    updatedAt!: string;
    refunds!: RefundSummaryDTO[];

    static from(entry: TreasuryLedgerEntry, orderPublicId: string | null, refunds: TreasuryLedgerEntry[] = []): PaymentResponseDTO {
        const dto = new PaymentResponseDTO();
        dto.id = String(entry.id);
        dto.orderId = orderPublicId;
        dto.type = entry.entryType;
        dto.method = entry.method;
        dto.provider = providerName(entry.providerId);
        dto.status = entry.status;
        dto.amount = entry.amount;
        dto.currency = entry.currency;
        dto.providerReferenceId = entry.providerReferenceId;
        dto.isRefunded = entry.isRefunded;
        dto.createdAt = entry.createdAt.toISOString();
        dto.updatedAt = entry.updatedAt.toISOString();
        dto.refunds = refunds.map(RefundSummaryDTO.from);
        return dto;
    }
}
