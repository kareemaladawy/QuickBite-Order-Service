// Same JWT contract as core-service (CLAUDE.md §8) — these are the fixed system
// roles core issues in `role`. `restaurantRole` is a separate, dynamic value (an
// RBAC role name from core's permission catalog), not one of these, so it stays a
// plain string.
export enum SystemRole {
    SYSTEM_ADMIN = "system_admin",
    RESTAURANT_USER = "restaurant_user",
    DELIVERY_AGENT = "delivery_agent",
    CUSTOMER = "customer",
}

export interface JWTPayload {
    userId: number;
    role: SystemRole;
    email: string;
    restaurantId?: number;
    restaurantRole?: string;
    branchIds?: number[];
}

export interface RBACOptions {
    resource: string;
    action: string;
    allowSystemAdmin?: boolean; // default true
}
