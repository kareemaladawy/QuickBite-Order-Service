export interface KashierClientConfig {
    baseUrl: string;
    merchantId: string;
    apiKey: string; // "api-key" header on session create; also the webhook HMAC key
    secretKey: string; // "Authorization" header on session create + refund
}

// Only the fields we read from Kashier's responses/webhooks — not an exhaustive
// mirror of their schema (see docs/business-logic/payments.md §1 references).
export interface KashierCreateSessionResponse {
    status: string;
    sessionUrl: string;
    _id: string;
    [key: string]: unknown;
}

export interface KashierWebhookData {
    merchantOrderId?: string;
    kashierOrderId: string;
    orderReference: string;
    transactionId: string;
    status: "SUCCESS" | "FAILURE" | "PENDING";
    method: string;
    amount: number; // major units, e.g. 100 for 100.00 EGP
    currency: string;
    signatureKeys: string[];
    metaData?: Record<string, string>;
    transactionResponseMessage?: { en?: string; ar?: string };
    [key: string]: unknown;
}

export interface KashierWebhookPayload {
    event: string;
    data: KashierWebhookData;
}
