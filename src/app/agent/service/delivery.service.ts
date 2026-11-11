import { inject, injectable } from "tsyringe";
import { container } from "../../../lib/di/container";
import { TOKENS } from "../../../lib/di/tokens";
import { env } from "../../../lib/config/env";
import { db } from "../../../lib/knex/knex";
import { logger } from "../../../lib/logger/logger";
import { publishToRoom } from "../../../lib/websocket/publish";
import { getAgent } from "../../../lib/core-client/agent.client";
import { PaginationParams } from "../../../lib/http/pagination/types";
import type { OrderService } from "../../order/service/order.service";
import { Order } from "../../order/entity/order.entity";
import { OrderStatus } from "../../order/enums";
import { FindOrdersByAgentFilters } from "../../order/types";
import type { FinanceService } from "../../restaurant-finance/service/finance.service";
import { AssignmentService } from "./assignment.service";
import { PresenceService } from "./presence.service";
import type { AgentFinanceService } from "./agent-finance.service";
import { AgentLedgerEntry } from "../entity/agent-ledger-entry.entity";
import { AssignmentRequiresAgentIdError, ForbiddenDeliveryAccessError } from "../errors";
import { EarningsRange } from "../types";

@injectable()
export class DeliveryService {
    constructor(
        @inject(TOKENS.AssignmentService) private readonly assignmentService: AssignmentService,
        @inject(TOKENS.PresenceService) private readonly presenceService: PresenceService,
    ) { }

    // Resolved lazily — cross-module (order and restaurant-finance); see
    // presence.service.ts's comment for the full reasoning.
    private orderService(): OrderService {
        return container.resolve<OrderService>(TOKENS.OrderService);
    }

    private financeService(): FinanceService {
        return container.resolve<FinanceService>(TOKENS.FinanceService);
    }

    private agentFinanceService(): AgentFinanceService {
        return container.resolve<AgentFinanceService>(TOKENS.AgentFinanceService);
    }

    // POST /orders/{id}/delivery/assign — admin manual override only (agentId
    // required); the broadcast re-trigger path lives at /reassign instead, so this
    // endpoint's response contract (always a committed DeliveryTaskResponseDTO) holds.
    assign = async (orderPublicId: string, region: string, agentId?: number): Promise<Order> => {
        if (!agentId) throw AssignmentRequiresAgentIdError;
        const order = await this.orderService().getOrderForSystem(orderPublicId, region);
        return this.assignmentService.assignManually(order, agentId);
    };

    reassign = async (orderPublicId: string, region: string): Promise<Order> => {
        const order = await this.orderService().getOrderForSystem(orderPublicId, region);
        return this.assignmentService.reassign(order);
    };

    accept = async (orderPublicId: string, region: string, agentId: number): Promise<Order> => {
        const order = await this.orderService().getOrderForSystem(orderPublicId, region);
        return this.assignmentService.acceptOffer(order, agentId);
    };

    decline = async (orderPublicId: string, region: string, agentId: number): Promise<void> => {
        const order = await this.orderService().getOrderForSystem(orderPublicId, region);
        await this.assignmentService.declineOffer(order, agentId);
    };

    // PATCH /orders/{id}/delivery/status — assigned->picked or picked->delivered, the
    // assigned agent only (agents.md §6).
    updateStatus = async (orderPublicId: string, region: string, agentId: number, toStatus: OrderStatus): Promise<Order> => {
        const order = await this.orderService().getOrderForSystem(orderPublicId, region);
        if (order.deliveryAgentId !== agentId) throw ForbiddenDeliveryAccessError;

        if (toStatus === OrderStatus.PICKED) {
            const updated = await this.orderService().transitionByAgent(order, OrderStatus.PICKED, db(region));
            await this.publishStatusChanged(updated, agentId);
            return updated;
        }

        return this.settleDelivered(order, agentId);
    };

    // Settlement on `delivered` (agents.md §7) — earnings insert + status flip + the
    // Restaurant Finance settlement, all in the one trx this method owns, per CLAUDE.md
    // §8 ("the service that opens the trx passes it through").
    private settleDelivered = async (order: Order, agentId: number): Promise<Order> => {
        const conn = db(order.region);
        const trx = await conn.transaction();
        let updated: Order;

        try {
            const { commission } = await this.financeService().recordDeliverySettlement(order, trx);
            updated = await this.orderService().transitionByAgent(order, OrderStatus.DELIVERED, trx, { commission });

            const amount = Math.floor((order.deliveryFee * env.agents.earningsSharePct) / 100);
            await this.agentFinanceService().recordEarning(agentId, order.region, order.id, order.createdAt, amount, order.currency, trx);

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }

        await this.presenceService.decrementLoad(order.region, agentId);
        await this.publishStatusChanged(updated, agentId);
        return updated;
    };

    // Cancellation-while-assigned (agents.md §8) — invoked by order.service.ts's
    // applyStatusTransition hook right after an admin cancels an `assigned` order.
    handleCancelledWhileAssigned = async (order: Order): Promise<void> => {
        const agentId = order.deliveryAgentId;
        if (!agentId) return;

        const conn = db(order.region);
        await this.orderService().clearAgent(order, conn);
        await this.presenceService.decrementLoad(order.region, agentId);

        publishToRoom(`agent:${agentId}`, "task.cancelled", {
            orderPublicId: order.publicId,
            reason: order.cancellationReason,
        });
    };

    listTasks = async (
        agentId: number,
        region: string,
        filters: FindOrdersByAgentFilters,
        pagination: PaginationParams,
    ): Promise<Order[]> => {
        return this.orderService().findTasksByAgent(agentId, region, filters, pagination);
    };

    getEarnings = async (
        agentId: number,
        region: string,
        range: EarningsRange,
        pagination: PaginationParams,
    ): Promise<{ earnings: AgentLedgerEntry[]; totals: { count: number; sum: number }; orderPublicIdById: Map<number, string> }> => {
        return this.agentFinanceService().getEarnings(agentId, region, range, pagination);
    };

    private publishStatusChanged = async (order: Order, agentId: number): Promise<void> => {
        let agent: { id: number; name?: string; phone?: string } = { id: agentId };
        try {
            const info = await getAgent(agentId);
            agent = { id: info.id, name: info.name, phone: info.phone };
        } catch (err) {
            logger.warn("delivery.status_changed: agent enrichment lookup failed — publishing without name/phone", {
                agentId,
                error: (err as Error).message,
            });
        }

        const payload = { orderPublicId: order.publicId, status: order.status, ts: order.updatedAt.toISOString(), agent };
        publishToRoom(`customer:${order.customerId}`, "delivery.status_changed", payload);
        publishToRoom(`branch:${order.branchId}`, "delivery.status_changed", payload);
    };
}
