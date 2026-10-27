export interface ApiResponse<T = unknown> {
    success: boolean;
    data?: T;
    meta?: object;
}
