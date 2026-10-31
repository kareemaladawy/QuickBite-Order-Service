export class RestaurantBalance {
    restaurantId: number;
    region: string;
    currency: string;
    balance: number;
    updatedAt: Date;

    constructor(data: Partial<RestaurantBalance>) {
        this.restaurantId = data.restaurantId!;
        this.region = data.region!;
        this.currency = data.currency!;
        this.balance = data.balance!;
        this.updatedAt = data.updatedAt!;
    }
}
