import { IPaymentProvider } from "../payment.interface";
import { CreateSessionInput, CreateSessionOutput, RefundInput, RefundOutput, WebhookEvent, WebhookHeaders } from "../types";
import { PaymentProviderError, PaymentSignatureError } from "../errors";
import { isValidSignature } from "./kashier.signature";
import { KashierClientConfig, KashierCreateSessionResponse, KashierWebhookPayload } from "./kashier.types";
import { fromMinor, toMinor } from "../../utils/money";
import { retry } from "../../utils/retry";

// Kashier v3. Payment Sessions: https://developers.kashier.io/docs/accept-payments/payment-sessions
// Webhooks: https://developers.kashier.io/docs/webhooks
export class KashierClient implements IPaymentProvider {
    constructor(private readonly config: KashierClientConfig) {}

    async createSession(input: CreateSessionInput): Promise<CreateSessionOutput> {
        const body = {
            merchantId: this.config.merchantId,
            order: input.merchantOrderId,
            amount: fromMinor(input.amountMinor).toFixed(2),
            currency: input.currency,
            // Card + mobile wallet only, per product requirement — no other method.
            allowedMethods: "card,wallet",
            defaultMethod: "card",
            merchantRedirect: input.returnUrl,
            redirectMethod: "get",
            display: "en",
            expireAt: input.expiresAt.toISOString(),
            // Required by Kashier even though the docs page doesn't mark it so — a bare
            // request without `customer` is rejected with "customer is required".
            // `reference` is enough; we deliberately skip `email`.
            customer: { reference: input.customerReference },
            metaData: input.metaData,
            ...(input.webhookUrl ? { serverWebhook: input.webhookUrl } : {}),
        };

        const res = await this.request<KashierCreateSessionResponse>("POST", "/v3/payment/sessions", body, this.config.secretKey);

        return {
            providerSessionId: res._id,
            redirectUrl: res.sessionUrl,
            status: res.status,
            raw: res as unknown as Record<string, unknown>,
        };
    }

    async refund(input: RefundInput): Promise<RefundOutput> {
        const body: Record<string, unknown> = { apiOperation: "REFUND" };
        if (input.amountMinor !== undefined) {
            body.transaction = { amount: fromMinor(input.amountMinor).toFixed(2) };
        }
        if (input.reason) body.reason = input.reason;

        // Refunds hit a different host (fep.kashier.io) than session creation.
        const refundBaseUrl = this.config.baseUrl.includes("test-api")
            ? "https://test-fep.kashier.io"
            : "https://fep.kashier.io";

        const res = await this.request<Record<string, unknown>>(
            "PUT",
            `/v3/orders/${input.providerOrderId}`,
            body,
            this.config.secretKey,
            refundBaseUrl,
        );

        return { status: String(res.status ?? "PENDING"), raw: res };
    }

    getSignatureHeaderValue(headers: WebhookHeaders): string | undefined {
        const value = headers["x-kashier-signature"];
        return Array.isArray(value) ? value[0] : value;
    }

    verifyWebhook(rawBody: Record<string, unknown>, headers: WebhookHeaders): WebhookEvent {
        const payload = rawBody as unknown as KashierWebhookPayload;
        const data = payload.data;
        const signatureHeader = this.getSignatureHeaderValue(headers);

        if (!isValidSignature(data, data.signatureKeys ?? [], this.config.apiKey, signatureHeader)) {
            throw new PaymentSignatureError();
        }

        return {
            eventType: payload.event,
            status: data.status,
            providerOrderId: data.kashierOrderId,
            // `data.orderReference` is Kashier's own internal reference, not ours —
            // `data.merchantOrderId` is the `order` field we sent at session creation
            // (our order's public_id), which Kashier echoes back verbatim.
            orderReference: data.merchantOrderId ?? "",
            transactionId: data.transactionId,
            amountMinor: toMinor(data.amount),
            currency: data.currency,
            method: data.method,
            failureMessage: data.transactionResponseMessage?.en,
            metaData: data.metaData ?? {},
            raw: rawBody,
        };
    }

    private async request<T>(
        method: "POST" | "PUT",
        path: string,
        body: unknown,
        authorization: string,
        baseUrlOverride?: string,
    ): Promise<T> {
        const url = new URL(path, baseUrlOverride ?? this.config.baseUrl);

        return retry(
            async () => {
                const res = await fetch(url, {
                    method,
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: authorization,
                        "api-key": this.config.apiKey,
                    },
                    body: JSON.stringify(body),
                });

                const text = await res.text();
                let parsed: unknown;
                try {
                    parsed = text ? JSON.parse(text) : {};
                } catch {
                    parsed = { message: text };
                }

                if (!res.ok) {
                    const message = (parsed as { message?: string })?.message ?? `Kashier request failed (${res.status})`;
                    throw new PaymentProviderError(message, res.status, parsed);
                }

                return parsed as T;
            },
            {
                attempts: 3,
                initialDelayMs: 100,
                maxDelayMs: 500,
                isRetryable: (err) => err instanceof PaymentProviderError && err.statusCode >= 500,
            },
        );
    }
}
