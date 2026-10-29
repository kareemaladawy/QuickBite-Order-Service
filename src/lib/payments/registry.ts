import { IPaymentProvider } from "../../pkg/payments/payment.interface";

// Per-provider settings that aren't part of the gateway behavior itself (so they stay
// out of IPaymentProvider / pkg/) but still vary by provider — e.g. where Kashier
// redirects the customer back to isn't necessarily where a different PSP would, and
// each provider may negotiate its own session lifetime.
export interface ProviderConfig {
    provider: IPaymentProvider;
    returnUrl: string;
    sessionTimeoutMin: number;
    // Where this provider should POST async payment events — optional since not every
    // provider needs one passed per-session (some are configured once in a merchant
    // dashboard instead).
    webhookUrl?: string;
}

// Wiring, not a pure pkg/ provider — picks which ProviderConfig a region uses. Online
// providers only: COD has no IPaymentProvider implementation and is handled directly
// in PaymentService.refund's `method === COD` branch.
export class PaymentProviderRegistry {
    constructor(
        private readonly providersByName: Record<string, ProviderConfig>,
        private readonly regionToProviderName: Record<string, string>,
    ) {}

    forRegion(region: string): ProviderConfig | undefined {
        const name = this.regionToProviderName[region];
        return name ? this.providersByName[name] : undefined;
    }

    providerNameForRegion(region: string): string | undefined {
        return this.regionToProviderName[region];
    }

    byName(name: string): ProviderConfig | undefined {
        return this.providersByName[name];
    }
}
