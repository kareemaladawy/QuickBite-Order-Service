export interface JWTPayload {
    userId: number;
    role: string;
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
