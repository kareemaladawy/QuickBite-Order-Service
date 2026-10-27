import { AppError } from "../error/AppError";

export const MissingIdempotencyKeyError = new AppError("Missing idempotency key", 400);
export const IdempotencyServiceUnavailable = new AppError("Idempotency service unavailable", 503);
