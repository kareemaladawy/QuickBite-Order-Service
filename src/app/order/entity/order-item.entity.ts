export class OrderItem {
    id: number;
    region: string;
    orderId: number;
    orderCreatedAt: Date;
    productId: number;
    quantity: number;
    unitPriceSnapshot: number;
    nameSnapshot: string;
    imageUrlSnapshot: string | null;
    lineTotal: number;
    createdAt: Date;

    constructor(data: Partial<OrderItem>) {
        this.id = data.id!;
        this.region = data.region!;
        this.orderId = data.orderId!;
        this.orderCreatedAt = data.orderCreatedAt!;
        this.productId = data.productId!;
        this.quantity = data.quantity!;
        this.unitPriceSnapshot = data.unitPriceSnapshot!;
        this.nameSnapshot = data.nameSnapshot!;
        this.imageUrlSnapshot = data.imageUrlSnapshot ?? null;
        this.lineTotal = data.lineTotal!;
        this.createdAt = data.createdAt!;
    }
}
