import { TransactionMethod, TransactionStatus, TransactionType } from "../enums";

export class Transaction {
    id: number;
    region: string;
    orderId: number | null;
    orderCreatedAt: Date | null;
    transactionType: TransactionType;
    method: TransactionMethod;
    providerId: number | null;
    providerReferenceId: string | null;
    status: TransactionStatus;
    amount: number;
    currency: string;
    srcAccId: number | null;
    dstAccId: number | null;
    isRefunded: boolean;
    refundedPaymentId: number | null;
    idempotencyKey: string | null;
    createdAt: Date;
    updatedAt: Date;

    constructor(data: Partial<Transaction>) {
        this.id = data.id!;
        this.region = data.region!;
        this.orderId = data.orderId ?? null;
        this.orderCreatedAt = data.orderCreatedAt ?? null;
        this.transactionType = data.transactionType!;
        this.method = data.method!;
        this.providerId = data.providerId ?? null;
        this.providerReferenceId = data.providerReferenceId ?? null;
        this.status = data.status!;
        this.amount = data.amount!;
        this.currency = data.currency!;
        this.srcAccId = data.srcAccId ?? null;
        this.dstAccId = data.dstAccId ?? null;
        this.isRefunded = data.isRefunded ?? false;
        this.refundedPaymentId = data.refundedPaymentId ?? null;
        this.idempotencyKey = data.idempotencyKey ?? null;
        this.createdAt = data.createdAt!;
        this.updatedAt = data.updatedAt!;
    }
}
