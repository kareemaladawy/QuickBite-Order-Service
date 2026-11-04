import { PaymentSessionStatus, TransactionMethod, TransactionStatus, TransactionType } from "./enums";
import { Transaction } from "./entity/transaction.entity";

// Deliberately not the order module's `Order` entity — keeps this module decoupled
// from order's internal shape (module boundary; see CLAUDE.md §3). OrderService builds
// this from its own entity before calling PaymentService.
export interface OrderPayloadForPaymentInit {
    orderId: number;
    orderCreatedAt: Date;
    orderPublicId: string;
    customerId: number;
    amountMinor: number;
    currency: string;
    region: string;
}

export interface InitPaymentResult {
    redirectUrl: string;
    sessionId: string;
    expiresAt: string;
}

export interface CreatePaymentSessionRow {
    region: string;
    orderId: number;
    orderCreatedAt: Date;
    providerId: number;
    providerSessionId: string;
    redirectUrl: string;
    amount: number;
    currency: string;
    status: PaymentSessionStatus;
    rawInitPayload: Record<string, unknown>;
}

export interface UpdatePaymentSessionInput {
    status: PaymentSessionStatus;
    rawLastPayload?: Record<string, unknown>;
}

export interface CreateTransactionRow {
    region: string;
    orderId?: number;
    orderCreatedAt?: Date;
    transactionType: TransactionType;
    method: TransactionMethod;
    providerId?: number;
    providerReferenceId?: string;
    status: TransactionStatus;
    amount: number;
    currency: string;
    srcAccId?: number;
    dstAccId?: number;
    idempotencyKey?: string;
}

export interface GetPaymentResult {
    transaction: Transaction;
    orderPublicId: string | null;
    refunds: Transaction[];
}

export interface UpdateTransactionInput {
    status?: TransactionStatus;
    providerReferenceId?: string;
    isRefunded?: boolean;
    refundedPaymentId?: number;
}

// Rich outbox payload for analytics-service (see outbox-events.ts) — a flattened
// snapshot of the charge transaction, not a public response DTO.
export interface PaymentOutboxPayload {
    transactionId: number;
    region: string;
    orderId: number | null;
    orderCreatedAt: string | null;
    transactionType: TransactionType;
    method: TransactionMethod;
    providerId: number | null;
    status: TransactionStatus;
    amount: number;
    currency: string;
    createdAt: string;
}
