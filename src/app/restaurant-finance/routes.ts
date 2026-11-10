import { Router } from "express";
import { authenticate } from "../../lib/auth/guard";
import { rbac } from "../../lib/auth/rbac";
import { idempotency } from "../../lib/idempotency/idempotency";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { requireRegion } from "../../lib/sharding/region-resolver";
import { FinanceController } from "./controller/finance.controller";

export const financeRouter = Router();

const financeController = container.resolve<FinanceController>(TOKENS.FinanceController);

financeRouter.get(
    "/restaurant/balance",
    authenticate,
    requireRegion,
    rbac({ resource: "core:finance", action: "read" }),
    financeController.getBalance,
);

financeRouter.get(
    "/restaurant/payouts",
    authenticate,
    requireRegion,
    rbac({ resource: "core:finance", action: "read" }),
    financeController.listPayouts,
);

// system_admin only — finance:payout_create is admin-bypassed today (rbac.md §1), not
// mapped to any non-admin role, so rbac()'s normal "restaurant_user with the permission"
// branch never actually grants this to anyone but matches the pattern used by
// payments:refund (see app/payment/routes.ts).
financeRouter.post(
    "/restaurant/payouts",
    authenticate,
    requireRegion,
    idempotency({ strict: true }),
    rbac({ resource: "core:finance", action: "payout_create" }),
    financeController.createPayout,
);
