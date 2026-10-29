import { toMs } from "../../../pkg/utils/time";
import { PaymentSessionStatus } from "../enums";

export class PaymentSession {
    id: number;
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
    rawLastPayload: Record<string, unknown> | null;
    createdAt: Date;
    updatedAt: Date;

    constructor(data: Partial<PaymentSession>) {
        this.id = data.id!;
        this.region = data.region!;
        this.orderId = data.orderId!;
        this.orderCreatedAt = data.orderCreatedAt!;
        this.providerId = data.providerId!;
        this.providerSessionId = data.providerSessionId!;
        this.redirectUrl = data.redirectUrl!;
        this.amount = data.amount!;
        this.currency = data.currency!;
        this.status = data.status!;
        this.rawInitPayload = data.rawInitPayload!;
        this.rawLastPayload = data.rawLastPayload ?? null;
        this.createdAt = data.createdAt!;
        this.updatedAt = data.updatedAt!;
    }

    isExpired(timeoutMin: number): boolean {
        return Date.now() - this.createdAt.getTime() > toMs(timeoutMin, "m");
    }
}
