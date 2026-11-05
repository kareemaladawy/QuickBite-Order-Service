export interface ApiResponse<T = unknown> {
    data?: T;
    meta?: object;
}
