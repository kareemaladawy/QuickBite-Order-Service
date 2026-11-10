import { Router } from "express";
import { authenticate } from "../../lib/auth/guard";
import { rbac, requireRestaurantMember } from "../../lib/auth/rbac";
import { idempotency } from "../../lib/idempotency/idempotency";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { requireRegion } from "../../lib/sharding/region-resolver";
import { PaymentController } from "./controller/payment.controller";
import { WebhookController } from "./controller/webhook.controller";

export const paymentRouter = Router();

const paymentController = container.resolve<PaymentController>(TOKENS.PaymentController);
const webhookController = container.resolve<WebhookController>(TOKENS.WebhookController);

// Retry-only — see docs/business-logic/payments.md §2. The first init for an online
// order always happens inline in POST /orders (OrderService.placeOrder).
paymentRouter.post(
    "/payments/init",
    authenticate,
    requireRegion,
    idempotency({ strict: true }),
    paymentController.init,
);

// Nested under the restaurant so ownership is enforced by middleware, not inside
// PaymentService (requireRestaurantMember 403s before the handler runs if the caller
// isn't system_admin or a member of this restaurantId; rbac() then checks the
// payments:read permission itself).
paymentRouter.get(
    "/restaurants/:restaurantId/payments/:paymentId",
    authenticate,
    requireRegion,
    requireRestaurantMember("restaurantId"),
    rbac({ resource: "core:payment", action: "read" }),
    paymentController.getById,
);

paymentRouter.post(
    "/payments/:paymentId/refund",
    authenticate,
    requireRegion,
    idempotency({ strict: true }),
    rbac({ resource: "core:payment", action: "refund" }),
    paymentController.refund,
);

// No auth — Kashier calls this unauthenticated per their webhook contract; the HMAC
// signature (verified inside PaymentWebhookService) is the only trust boundary.
paymentRouter.post("/payments/webhook/:provider", webhookController.handle);
