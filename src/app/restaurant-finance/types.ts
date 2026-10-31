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
