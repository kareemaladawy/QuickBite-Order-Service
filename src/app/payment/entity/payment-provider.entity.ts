export class PaymentProvider {
    id: number;
    name: string;
    isEnabled: boolean;
    priority: number;

    constructor(data: Partial<PaymentProvider>) {
        this.id = data.id!;
        this.name = data.name!;
        this.isEnabled = data.isEnabled!;
        this.priority = data.priority!;
    }
}
