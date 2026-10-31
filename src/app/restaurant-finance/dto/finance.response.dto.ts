import { RestaurantBalance } from "../entity/restaurant-balance.entity";
import { PayoutRow } from "../types";

export class RestaurantBalanceResponseDTO {
    restaurantId!: number;
    balances!: Array<{ currency: string; balance: number }>;
    asOf!: string;

    static from(restaurantId: number, balances: RestaurantBalance[]): RestaurantBalanceResponseDTO {
        const dto = new RestaurantBalanceResponseDTO();
        dto.restaurantId = restaurantId;
        dto.balances = balances.map((b) => ({ currency: b.currency, balance: b.balance }));
        dto.asOf = new Date().toISOString();
        return dto;
    }
}

export class PayoutResponseDTO {
    id!: string;
    amount!: number;
    currency!: string;
    status!: string;
    providerReferenceId!: string | null;
    createdAt!: string;

    static from(payout: PayoutRow): PayoutResponseDTO {
        const dto = new PayoutResponseDTO();
        dto.id = String(payout.id);
        dto.amount = payout.amount;
        dto.currency = payout.currency;
        dto.status = payout.status;
        dto.providerReferenceId = payout.providerReferenceId;
        dto.createdAt = payout.createdAt.toISOString();
        return dto;
    }
}
