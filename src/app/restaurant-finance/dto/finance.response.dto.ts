import { RestaurantBalance } from "../entity/restaurant-balance.entity";
import { RestaurantLedgerEntry } from "../entity/restaurant-ledger-entry.entity";
import { RestaurantLedgerEntryType } from "../enums";
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

export class RestaurantLedgerEntryResponseDTO {
    id!: string;
    entryType!: RestaurantLedgerEntryType;
    amount!: number;
    balanceAfter!: number;
    currency!: string;
    orderId!: string | null;
    note!: string | null;
    createdAt!: string;

    static from(entry: RestaurantLedgerEntry, orderPublicIdById: Map<number, string>): RestaurantLedgerEntryResponseDTO {
        const dto = new RestaurantLedgerEntryResponseDTO();
        dto.id = String(entry.id);
        dto.entryType = entry.entryType;
        dto.amount = entry.amount;
        dto.balanceAfter = entry.balanceAfter;
        dto.currency = entry.currency;
        dto.orderId = entry.orderId !== null ? orderPublicIdById.get(entry.orderId) ?? null : null;
        dto.note = entry.note;
        dto.createdAt = entry.createdAt.toISOString();
        return dto;
    }
}
