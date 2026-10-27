import { AppError } from "../../lib/error/AppError";
import { OrderStatus } from "./enums";
import { OffendingOrderItem } from "./types";

export const OrderNotFoundError = new AppError("Order not found", 404);
export const ForbiddenOrderAccessError = new AppError("You do not have access to this order", 403);
export const BranchNotAcceptingOrdersError = new AppError("Branch is not accepting orders right now", 409);
export const EmptyOrderItemsError = new AppError("Order must contain at least one item", 400);
export const AddressNotOwnedError = new AppError("This address does not belong to you", 403);
export const MissingCancellationReasonError = new AppError("A cancellation reason is required", 400);
export const IdempotencyConflictError = new AppError(
    "Idempotency key reused with a different request body",
    409,
);
export const MissingIdempotencyKeyError = new AppError("Missing Idempotency-Key header", 400);
export const BranchIdRequiredError = new AppError("branchId is required", 400);

export function invalidStatusTransitionError(from: OrderStatus, to: OrderStatus): AppError {
    return new AppError(`Cannot transition order from "${from}" to "${to}"`, 409);
}

export function orderItemsUnavailableError(offending: OffendingOrderItem[]): AppError {
    return new AppError("One or more items are unavailable", 409, true, { items: offending });
}
