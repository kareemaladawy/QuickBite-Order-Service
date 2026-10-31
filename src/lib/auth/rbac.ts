import { Request, Response, NextFunction } from "express";
import { NotAuthenticated } from "./errors";
import { RBACOptions } from "./types";
import { container } from "../di/container";
import { TOKENS } from "../di/tokens";
import { PermissionCacheService } from "./permission-cache.service";

// Role constants kept minimal here; the permission lookup is wired later via a
// cached projection from core-service (Phase 1+ handler).
const SYSTEM_ADMIN = "system_admin";
const RESTAURANT_USER = "restaurant_user";

/**
 * Resolved per-request (not at module load) so this middleware can be constructed by
 * routes.ts before/after container.ts finishes registering — matches the pattern in
 * `lib/cache/withCache.ts` and `lib/idempotency/idempotency.ts`.
 */
export function rbac(_options: RBACOptions) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.user) throw NotAuthenticated;
            const { allowSystemAdmin = true, resource, action } = _options;
            if (allowSystemAdmin && req.user.role === SYSTEM_ADMIN) return next();
            if (req.user.role === RESTAURANT_USER && req.user.restaurantRole) {
                const permissionCache = container.resolve<PermissionCacheService>(TOKENS.PermissionCacheService);
                const allowed = await permissionCache.hasPermission(
                    req.user.restaurantRole,
                    `${resource}:${action}`,
                    req.correlationId,
                );
                if (allowed) return next();
            }
            return res.status(403).json({ error: "Permission denied" });
        } catch (err) {
            next(err);
        }
    };
}

export function requireRestaurantMember(paramName: string = "restaurantId") {
    return (req: Request, res: Response, next: NextFunction) => {
        const restaurantId = Number(req.params[paramName]);
        if (!restaurantId) return res.status(400).json({ error: `missing ${paramName}` });
        if (req.user?.role === SYSTEM_ADMIN) return next();
        if (Number(req.user?.restaurantId) !== restaurantId) {
            return res.status(403).json({ error: "Permission denied" });
        }
        next();
    };
}

export function requireBranchAccess(paramName: string = "branchId") {
    return (req: Request, res: Response, next: NextFunction) => {
        if (req.user?.role === SYSTEM_ADMIN) return next();
        if (req.user?.restaurantRole === "owner") return next();

        const branchId =
            Number(req.params[paramName]) || Number(req.query[paramName]);
        if (!branchId) return next(); // endpoint doesn't scope to a specific branch

        const userBranchIds = req.user?.branchIds ?? [];
        if (!userBranchIds.includes(branchId)) {
            return res.status(403).json({ error: "You do not have access to this branch" });
        }
        next();
    };
}
