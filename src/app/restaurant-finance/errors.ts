import { AppError } from "../../lib/error/AppError";

export const InsufficientBalanceError = new AppError("Insufficient balance for this payout", 409);
export const MissingIdempotencyKeyError = new AppError("Missing Idempotency-Key header", 400);
