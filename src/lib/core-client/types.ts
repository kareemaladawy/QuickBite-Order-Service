export interface CoreClientRequest {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;                       // e.g. "/api/internal/branches/123"
    body?: unknown;
    correlationId?: string;
    idempotencyKey?: string;
}

export interface CoreEnvelope<T> {
    data: T;
}

export interface InternalBranchDTO {
    id: number;
    region: string;
    restaurantId: number;
    restaurantStatus: string;
    acceptOrders: boolean;
    isActive: boolean;
    deliveryFee: number;
    commissionBps: number;
    currency: string;
    lat: number;
    lng: number;
    name: string;
    addressText: string;
}

export interface InternalBranchProductDTO {
    productId: number;
    name: string;
    imageUrl: string | null;
    price: number;
    stock: number;
    isAvailable: boolean;
}

export interface ReserveStockItem {
    productId: number;
    quantity: number;
}

export interface InternalRolePermissionsDTO {
    role: string;
    permissions: string[]; // e.g. "orders:read", namespaced per §8 of CLAUDE.md
}

export interface InternalAgentDTO {
    id: number;
    name: string;
    phone: string;
}

export interface InternalCustomerAddressDTO {
    id: number;
    userId: number;
    lat: number;
    lng: number;
    addressText: string;
    city: string;
    country: string;
    building: string | null;
    apartmentNumber: string | null;
    label: string;
}
