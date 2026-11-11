export class AgentBalance {
    agentId: number;
    region: string;
    currency: string;
    balance: number;
    updatedAt: Date;

    constructor(data: Partial<AgentBalance>) {
        this.agentId = data.agentId!;
        this.region = data.region!;
        this.currency = data.currency!;
        this.balance = data.balance!;
        this.updatedAt = data.updatedAt!;
    }
}
