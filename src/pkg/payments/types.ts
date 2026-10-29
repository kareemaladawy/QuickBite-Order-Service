export interface CreateSessionInput {
    merchantOrderId: string; // our order's public_id — becomes Kashier's `order` field
    amountMinor: number;
    currency: string;
    customerReference: string;
    returnUrl: string;
    expiresAt: Date;
    // Where this provider should POST async payment events for this session — not
    // every provider needs one up front (some are configured once in a merchant
    // dashboard instead), so it's optional.
    webhookUrl?: string;
    // Opaque passthrough — Kashier echoes it back verbatim in the webhook payload's
    // `data.metaData`. We use it to carry our own shard-routing/correlation info since
    // the webhook call itself arrives with no region or auth context of ours.
    metaData: Record<string, string>;
}

export interface CreateSessionOutput {
    providerSessionId: string;
    redirectUrl: string;
    status: string;
    raw: Record<string, unknown>;
}

export interface RefundInput {
    providerOrderId: string; // Kashier order id (the `data.kashierOrderId` from the capture webhook)
    amountMinor?: number; // omitted => full refund
    reason?: string;
}

export interface RefundOutput {
    status: string;
    raw: Record<string, unknown>;
}

// Raw inbound request headers, lowercased keys (as Express/Node hand them over) — each
// provider plucks its own signature header name out of this rather than the caller
// pre-selecting one on the provider's behalf.
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface WebhookEvent {
    eventType: string; // 'pay' | 'capture' | 'refund' | 'partial_refund' | 'void' | 'reject' | 'reversal' | 'idempotency'
    status: "SUCCESS" | "FAILURE" | "PENDING";
    providerOrderId: string; // data.kashierOrderId
    orderReference: string; // data.orderReference (our merchantOrderId echoed back)
    transactionId: string;
    amountMinor: number;
    currency: string;
    method: string;
    failureMessage?: string;
    metaData: Record<string, string>;
    raw: Record<string, unknown>;
}
