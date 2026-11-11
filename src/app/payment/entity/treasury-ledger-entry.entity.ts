import { PayeeAccountType, TreasuryEntryType, TreasuryMethod, TreasuryStatus } from "../enums";

export class TreasuryLedgerEntry {
    id: number;
    region: string;
    orderId: number | null;
    orderCreatedAt: Date | null;
    entryType: TreasuryEntryType;
    method: TreasuryMethod;
    providerId: number | null;
    providerReferenceId: string | null;
    status: TreasuryStatus;
    amount: number;
    currency: string;
    customerId: number | null;
    payeeAccountType: PayeeAccountType | null;
    payeeAccountId: number | null;
    isRefunded: boolean;
    refundedEntryId: number | null;
    idempotencyKey: string | null;
    createdAt: Date;
    updatedAt: Date;

    constructor(data: Partial<TreasuryLedgerEntry>) {
        this.id = data.id!;
        this.region = data.region!;
        this.orderId = data.orderId ?? null;
        this.orderCreatedAt = data.orderCreatedAt ?? null;
        this.entryType = data.entryType!;
        this.method = data.method!;
        this.providerId = data.providerId ?? null;
        this.providerReferenceId = data.providerReferenceId ?? null;
        this.status = data.status!;
        this.amount = data.amount!;
        this.currency = data.currency!;
        this.customerId = data.customerId ?? null;
        this.payeeAccountType = data.payeeAccountType ?? null;
        this.payeeAccountId = data.payeeAccountId ?? null;
        this.isRefunded = data.isRefunded ?? false;
        this.refundedEntryId = data.refundedEntryId ?? null;
        this.idempotencyKey = data.idempotencyKey ?? null;
        this.createdAt = data.createdAt!;
        this.updatedAt = data.updatedAt!;
    }
}
