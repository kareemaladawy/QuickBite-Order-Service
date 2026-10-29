// docs/webhooks (Kashier): sort signatureKeys alphabetically, url-encode each data[key]
// value, join as "key=value" pairs with "&", then HMAC-SHA256 the result (hex digest)

import { createHmac, timingSafeEqual } from "crypto";

// using the Payment API key.
export function buildSignaturePayload(data: Record<string, unknown>, signatureKeys: string[]): string {
    return [...signatureKeys]
        .sort()
        .map((key) => `${key}=${encodeURIComponent(String(data[key] ?? ""))}`)
        .join("&");
}

export function computeSignature(data: Record<string, unknown>, signatureKeys: string[], apiKey: string): string {
    const payload = buildSignaturePayload(data, signatureKeys);
    return createHmac("sha256", apiKey).update(payload).digest("hex");
}

export function isValidSignature(
    data: Record<string, unknown>,
    signatureKeys: string[],
    apiKey: string,
    signatureHeader: string | undefined,
): boolean {
    if (!signatureHeader) return false;
    const expected = computeSignature(data, signatureKeys, apiKey);

    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signatureHeader, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}
