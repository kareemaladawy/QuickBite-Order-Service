import { Knex } from "knex";

// Auto-committed single-statement writes, deliberately outside any service-level trx —
// see payment-webhook.service.ts for why the dedupe insert and the error stamp must
// survive a rollback of the business-logic trx.

export async function insertWebhookEventIfNew(
    region: string,
    providerId: number,
    providerEventId: string,
    signature: string,
    payload: Record<string, unknown>,
    conn: Knex,
): Promise<boolean> {
    const rows = await conn("payment_webhook_events")
        .insert({
            region,
            provider_id: providerId,
            provider_event_id: providerEventId,
            signature,
            payload: JSON.stringify(payload),
        })
        .onConflict(["provider_id", "provider_event_id"])
        .ignore()
        .returning("id");

    // .returning() comes back empty when the conflict path (ignore) was taken.
    return rows.length > 0;
}

export async function markWebhookEventProcessed(providerId: number, providerEventId: string, conn: Knex): Promise<void> {
    await conn("payment_webhook_events")
        .where("provider_id", providerId)
        .where("provider_event_id", providerEventId)
        .update({ processed_at: new Date() });
}

export async function markWebhookEventError(
    providerId: number,
    providerEventId: string,
    error: string,
    conn: Knex,
): Promise<void> {
    await conn("payment_webhook_events")
        .where("provider_id", providerId)
        .where("provider_event_id", providerEventId)
        .update({ process_error: error });
}
