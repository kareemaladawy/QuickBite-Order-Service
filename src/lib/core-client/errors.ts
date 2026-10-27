import {AppError} from "../error/AppError";

export function coreUnavailableError(status: number): AppError {
    return new AppError(`core-service ${status}`, 503);
}

export function coreUpstreamError(status: number, message: string, details?: unknown): AppError {
    return new AppError(`core-service ${status}: ${message}`, status, true, details);
}
