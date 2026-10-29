import { CreateSessionInput, CreateSessionOutput, RefundInput, RefundOutput, WebhookEvent, WebhookHeaders } from "./types";

// Framework- and app-agnostic. No imports from lib/ or app/, no env, no DI — see
// CLAUDE.md §3 layering rules. A second provider (e.g. a different PSP) would implement
// the same shape without touching anything above pkg/.
export interface IPaymentProvider {
    createSession(input: CreateSessionInput): Promise<CreateSessionOutput>;
    refund(input: RefundInput): Promise<RefundOutput>;

    /**
     * Verifies the HMAC signature and parses the provider's raw webhook body into a
     * normalized WebhookEvent. Throws PaymentSignatureError on a signature mismatch.
     * Takes the full request headers (not a pre-plucked signature string) because each
     * provider names its own signature header differently.
     */
    verifyWebhook(rawBody: Record<string, unknown>, headers: WebhookHeaders): WebhookEvent;

    /**
     * Pulls this provider's own signature value out of the raw headers, for the
     * caller's audit log — kept separate from verifyWebhook so callers never need to
     * know the header name themselves.
     */
    getSignatureHeaderValue(headers: WebhookHeaders): string | undefined;
}
