import { AppError } from "../../lib/error/AppError";

export const AgentInActiveDeliveryError = new AppError("You have an active delivery — go offline after it completes", 409);
export const NotOnlineError = new AppError("You are not online", 409);
export const OrderNotReadyError = new AppError("Order is not ready for delivery assignment", 409);
export const OrderAlreadyAssignedError = new AppError("Order already has an assigned agent", 409);
export const NoEligibleAgentsError = new AppError("No eligible agents found nearby", 409);
export const AgentAtCapacityError = new AppError("Agent is already at maximum concurrent orders", 409);
export const MaxReassignmentAttemptsReachedError = new AppError("Maximum reassignment attempts reached", 409);
export const OfferExpiredError = new AppError("This delivery offer has expired or does not exist", 409);
export const OfferAlreadyTakenError = new AppError("Another agent already accepted this delivery", 409);
export const ForbiddenDeliveryAccessError = new AppError("You are not the agent assigned to this delivery", 403);
export const AssignmentRequiresAgentIdError = new AppError(
    "agentId is required for a manual assignment — use POST .../reassign to re-run the broadcast",
    400,
);
export const InsufficientBalanceError = new AppError("Insufficient balance for this payout", 409);
export const MissingIdempotencyKeyError = new AppError("Missing Idempotency-Key header", 400);
