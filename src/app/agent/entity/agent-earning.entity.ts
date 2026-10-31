export class AgentEarning {
    id: number;
    region: string;
    agentId: number;
    orderId: number;
    orderCreatedAt: Date;
    amount: number;
    currency: string;
    earnedAt: Date;

    constructor(data: Partial<AgentEarning>) {
        this.id = data.id!;
        this.region = data.region!;
        this.agentId = data.agentId!;
        this.orderId = data.orderId!;
        this.orderCreatedAt = data.orderCreatedAt!;
        this.amount = data.amount!;
        this.currency = data.currency!;
        this.earnedAt = data.earnedAt!;
    }
}
