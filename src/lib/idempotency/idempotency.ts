import { NextFunction, Request, Response } from "express";
import { IdempotencyServiceUnavailable, MissingIdempotencyKeyError } from "./errors";
import { TOKENS } from "../di/tokens";
import { container } from "tsyringe";
import { toSeconds } from "../../pkg/utils/time";
import { ICacheProvider } from "../../pkg/cache/cache.interface";
import { IdempotencyOptions } from "./types";

const TTL = toSeconds(1, "d");

export function idempotency(options: IdempotencyOptions = {}) {
    return async (req: Request, res: Response, next: NextFunction) => {
        const { strict = false } = options;

        try {
            if (!["POST", "PATCH", "PUT"].includes(req.method)) {
                return next();
            }

            const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

            if (!idempotencyKey) {
                if (strict) {
                    return res.status(400).json({ error: MissingIdempotencyKeyError.message });
                }

                return next();
            }

            const key = `${req.region ?? "all"}:${idempotencyKey}:${req.method}:${req.originalUrl}`;

            const cacheProvider: ICacheProvider = container.resolve(TOKENS.CacheProvider);
            const cachedResponse = await cacheProvider.get(key);

            if (cachedResponse) {
                res.setHeader("X-Cache", "HIT");
                return res.status(200).json(JSON.parse(cachedResponse));
            }

            const originalResponse = res.json.bind(res);

            res.json = (body: any) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    cacheProvider.set(key, JSON.stringify(body), TTL);
                    res.setHeader("X-Cache", "MISS");
                }
                return originalResponse(body);
            };

            next();
        } catch (error) {
            if (strict) {
                res.status(503).json({ error: IdempotencyServiceUnavailable.message });
            }

            next(error);
        }
    };
}
