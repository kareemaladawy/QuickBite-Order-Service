import type { Request, Response, NextFunction } from "express";
import { isRegion, normalizeRegion } from "./regions";
import { RegionNotResolvedError } from "./errors";

/**
 * Reads the region from the `X-Region` header only. "all" is preserved for
 * admin fan-out reads; writes must resolve to one concrete region.
 */
export function resolveRegion(req: Request, _res: Response, next: NextFunction) {
    const raw = req.headers["x-region"]; // x-region: eg
    const value = Array.isArray(raw) ? raw[0] : raw;
    const norm = normalizeRegion(value);

    if (norm && (norm === "all" || isRegion(norm))) {
        req.region = norm;
    }

    next();
}

export function requireRegion(req: Request, _res: Response, next: NextFunction) {
    if (!req.region) throw RegionNotResolvedError;
    next();
}

/**
 * Like requireRegion, but also rejects "all" — for write/single-shard endpoints that
 * must resolve to exactly one concrete region (not an admin fan-out read).
 */
export function requireConcreteRegion(req: Request, _res: Response, next: NextFunction) {
    if (!req.region || req.region === "all") throw RegionNotResolvedError;
    next();
}
