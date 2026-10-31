import { JWTPayload } from "../auth/types";

declare global {
    namespace Express {
        interface Request {
            correlationId?: string;
            region?: string;
            user?: JWTPayload;
        }
    }
}

export {};
