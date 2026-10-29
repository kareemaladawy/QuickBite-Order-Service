import { Knex } from "knex";
import { PaymentProvider } from "../entity/payment-provider.entity";

const PAYMENT_PROVIDER_COLUMNS = ["id", "name", "is_enabled", "priority"];

function toEntity(row: any): PaymentProvider {
    return new PaymentProvider({
        id: Number(row.id),
        name: row.name,
        isEnabled: row.is_enabled,
        priority: row.priority,
    });
}

export async function findProviderByName(name: string, conn: Knex): Promise<PaymentProvider | undefined> {
    const row = await conn("payment_providers").where("name", name).select(PAYMENT_PROVIDER_COLUMNS).first();
    return row ? toEntity(row) : undefined;
}

// Reverse lookup — a transactions row only stores provider_id; refund() needs the
// provider's name back to ask the registry for the right IPaymentProvider client.
export async function findProviderById(id: number, conn: Knex): Promise<PaymentProvider | undefined> {
    const row = await conn("payment_providers").where("id", id).select(PAYMENT_PROVIDER_COLUMNS).first();
    return row ? toEntity(row) : undefined;
}
