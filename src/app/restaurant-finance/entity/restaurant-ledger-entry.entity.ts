import { RestaurantLedgerEntryType } from "../enums";

export class RestaurantLedgerEntry {
    id: number;
    region: string;
    restaurantId: number;
    currency: string;
    entryType: RestaurantLedgerEntryType;
    amount: number; // signed minor units — positive = credit, negative = debit
    balanceAfter: number; // snapshot of restaurant_balances.balance right after this row
    orderId: number | null;
    orderCreatedAt: Date | null;
    treasuryLedgerId: number | null;
    note: string | null;
    createdAt: Date;

    constructor(data: Partial<RestaurantLedgerEntry>) {
        this.id = data.id!;
        this.region = data.region!;
        this.restaurantId = data.restaurantId!;
        this.currency = data.currency!;
        this.entryType = data.entryType!;
        this.amount = data.amount!;
        this.balanceAfter = data.balanceAfter!;
        this.orderId = data.orderId ?? null;
        this.orderCreatedAt = data.orderCreatedAt ?? null;
        this.treasuryLedgerId = data.treasuryLedgerId ?? null;
        this.note = data.note ?? null;
        this.createdAt = data.createdAt!;
    }
}
