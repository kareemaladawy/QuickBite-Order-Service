// pkg/ cannot import lib/error/AppError (layering — see CLAUDE.md §3), so provider
// failures surface as plain errors; app/payment/* is responsible for translating these
// into AppError at the service boundary.

export class PaymentSignatureError extends Error {
    constructor(message = "Webhook signature verification failed") {
        super(message);
        this.name = "PaymentSignatureError";
    }
}

export class PaymentProviderError extends Error {
    statusCode: number;
    raw: unknown;

    constructor(message: string, statusCode: number, raw?: unknown) {
        super(message);
        this.name = "PaymentProviderError";
        this.statusCode = statusCode;
        this.raw = raw;
    }
}
