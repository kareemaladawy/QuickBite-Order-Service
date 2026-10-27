export type TimeUnit = "d" | "h" | "m" | "s";

export interface RetryOptions {
    attempts: number;       // total tries including the first
    initialDelayMs: number;
    maxDelayMs: number;
    isRetryable?: (err: unknown) => boolean;
}
