export interface PaginationParams {
    cursor?: string;
    limit: number;
    sortBy: string;
    sortOrder: "asc" | "desc";
}

export interface FilterParams {
    field: string;
    operator: "eq" | "gt" | "lt" | "lte" | "gte" | "in" | "like";
    value: string | string[];
}

export interface PaginationMeta {
    nextCursor: string | null;
    hasMore: boolean;
    count: number;
}
