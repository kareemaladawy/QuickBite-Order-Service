import { inject, injectable } from "tsyringe";
import { TOKENS } from "../di/tokens";
import { PermissionCacheService } from "./permission-cache.service";

// Thin adapter between the core-events transport (lib/core-events/consumer.ts) and
// PermissionCacheService, which owns the actual invalidation logic — mirrors the HTTP
// controller -> service shape so a handler that later needs more than a cache drop
// grows in the service layer, not here.
@injectable()
export class RbacEventsController {
    constructor(@inject(TOKENS.PermissionCacheService) private readonly permissionCacheService: PermissionCacheService) { }

    onPermissionsChanged = async (): Promise<void> => {
        await this.permissionCacheService.invalidateAll();
    };
}
