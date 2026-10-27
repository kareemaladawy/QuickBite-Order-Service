import { injectable } from "tsyringe";
import { coreClient } from "../core-client/core-client";
import { cacheProvider } from "../cache/init";
import { toSeconds } from "../../pkg/utils/time";
import { CoreEnvelope, InternalRolePermissionsDTO } from "../core-client/types";

const PERMISSIONS_CACHE_TTL_SEC = toSeconds(5, "m");
const PERMISSIONS_CACHE_PREFIX = "core:rbac:perms:";

function permissionsCacheKey(roleName: string): string {
    return `${PERMISSIONS_CACHE_PREFIX}${roleName}`;
}

// Read-through cache in front of core-service's permission catalog — permissions are
// checked on every rbac()-guarded request (hot path) but change rarely. Invalidated in
// bulk by the rbac.permissions_changed core-event handler (see rbac.events.ts), since a
// catalog change can affect any number of cached roles at once.
@injectable()
export class PermissionCacheService {
    async getPermissions(roleName: string, correlationId?: string): Promise<string[]> {
        const key = permissionsCacheKey(roleName);
        const cached = await cacheProvider.get(key);
        if (cached) return JSON.parse(cached) as string[];

        // core-service's internal RBAC endpoint takes the role as a query param, not a
        // path segment — see core-service/src/app/rbac/routes.ts
        // (`GET /internal/rbac/permissions?role=`).
        const res = await coreClient.request<CoreEnvelope<InternalRolePermissionsDTO>>({
            method: "GET",
            path: `/api/v1/internal/rbac/permissions?role=${encodeURIComponent(roleName)}`,
            correlationId,
        });

        await cacheProvider.set(key, JSON.stringify(res.data.permissions), PERMISSIONS_CACHE_TTL_SEC);
        return res.data.permissions;
    }

    async hasPermission(roleName: string, permission: string, correlationId?: string): Promise<boolean> {
        const permissions = await this.getPermissions(roleName, correlationId);
        return permissions.includes(permission);
    }

    async invalidate(roleName: string): Promise<void> {
        await cacheProvider.del(permissionsCacheKey(roleName));
    }

    // A single permission catalog edit (e.g. adding a permission to a permission group)
    // can touch several roles at once, so the whole keyspace is dropped rather than
    // invalidating one role at a time.
    async invalidateAll(): Promise<void> {
        await cacheProvider.delByPattern(`${PERMISSIONS_CACHE_PREFIX}*`);
    }
}
