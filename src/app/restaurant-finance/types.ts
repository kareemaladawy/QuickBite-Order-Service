import { RestaurantLedgerEntryType } from "./enums";

export interface PayoutRow {
    id: number;
    amount: number;
    currency: string;
    status: string;
    providerReferenceId: string | null;
    createdAt: Date;
}

export interface DateRange {
    from: Date;
    to: Date;
}

export interface InsertRestaurantLedgerEntryRow {
    region: string;
    restaurantId: number;
    currency: string;
    entryType: RestaurantLedgerEntryType;
    amount: number;
    balanceAfter: number;
    orderId?: number;
    orderCreatedAt?: Date;
    treasuryLedgerId?: number;
    note?: string;
}
