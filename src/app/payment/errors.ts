import { AppError } from "../../lib/error/AppError";

export const PaymentNotFoundError = new AppError("Payment not found", 404);
export const ForbiddenPaymentAccessError = new AppError("You do not have access to this payment", 403);
export const OrderNotPendingPaymentError = new AppError("Order is not awaiting payment", 409);
export const PaymentProviderDisabledError = new AppError("This payment provider is currently unavailable", 503);
export const OnlinePaymentUnavailableInRegionError = new AppError(
    "Online payment is not available in this region yet — use cash on delivery",
    409,
);
export const AlreadyRefundedError = new AppError("This payment has already been fully refunded", 409);
export const RefundExceedsChargeError = new AppError("Refund amount exceeds the original charge amount", 400);
export const PaymentNotRefundableError = new AppError("Only a succeeded charge or COD collection can be refunded", 409);
export const InvalidWebhookSignatureError = new AppError("Invalid webhook signature", 401);
export const UnsupportedPaymentProviderError = new AppError("Unsupported payment provider", 404);
export const WebhookMissingRegionError = new AppError("Webhook payload is missing region metadata", 400);
export const PaymentSessionNotFoundError = new AppError("Payment session not found for this webhook", 404);
export const WebhookProcessingFailedError = new AppError("Webhook processing failed", 500);
export const MissingIdempotencyKeyError = new AppError("Missing Idempotency-Key header", 400);

export function paymentProviderUpstreamError(message: string): AppError {
    return new AppError(`Payment provider error: ${message}`, 502);
}
