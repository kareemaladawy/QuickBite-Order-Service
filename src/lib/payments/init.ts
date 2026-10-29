import { KashierClient } from "../../pkg/payments/kashier/kashier.client";
import { IPaymentProvider } from "../../pkg/payments/payment.interface";
import { env } from "../config/env";
import { PaymentProviderRegistry } from "./registry";

// Wires the env-configured Kashier credentials into the app-agnostic pkg/ client —
// mirrors lib/cache/init.ts wiring Redis config into RedisCacheProvider.
export const kashierProvider: IPaymentProvider = new KashierClient({
    baseUrl: env.kashier.baseUrl,
    merchantId: env.kashier.merchantId,
    apiKey: env.kashier.apiKey,
    secretKey: env.kashier.secretKey,
});

// A real second provider plugs in here: add its client + its own returnUrl/
// sessionTimeoutMin below (with its own `<NAME>_*` env-backed config, following the
// kashierProvider pattern above) and one more `region:providerName` pair in
// PAYMENT_PROVIDERS_BY_REGION — nothing else in the payment module needs to change.
export const paymentProviderRegistry = new PaymentProviderRegistry(
    {
        kashier: {
            provider: kashierProvider,
            returnUrl: env.kashier.returnUrl,
            webhookUrl: env.kashier.webhookUrl,
            sessionTimeoutMin: env.kashier.sessionTimeoutMin,
        },
    },
    env.payments.regionProviderMap,
);
