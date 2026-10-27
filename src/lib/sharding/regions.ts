import { env } from "../config/env";

const set = new Set(env.regions);

export const REGIONS: ReadonlyArray<string> = env.regions;

export function isRegion(candidate: string | undefined | null): candidate is string {
    const norm = normalizeRegion(candidate);
    return typeof norm === "string" && set.has(norm);
}

export function normalizeRegion(candidate: string | undefined | null): string | undefined {
    return typeof candidate === "string" ? candidate.toLowerCase() : undefined;
}

export function assertRegion(candidate: string | undefined | null): string {
    const norm = normalizeRegion(candidate);

    if (!isRegion(norm)) {
        throw new Error(`Unknown region: "${norm}". Known: ${env.regions.join(",")}`);
    }

    return norm;
}
