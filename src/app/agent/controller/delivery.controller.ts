import { NextFunction, Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { sendPaginated, sendSuccess } from "../../../lib/http/response";
import { buildPaginationResult } from "../../../lib/http/pagination/cursor-pagination";
import { parsePaginationQuery } from "../../../lib/http/pagination/parse-query";
import { validateBody } from "../../../lib/validation/validate";
import { OrderStatus } from "../../order/enums";
import { DeliveryService } from "../service/delivery.service";
import { AssignDeliveryRequestDTO, UpdateDeliveryStatusRequestDTO } from "../dto/agent.request.dto";
import {
    AgentEarningsResponseDTO,
    DeliveryStatusResponseDTO,
    DeliveryTaskResponseDTO,
} from "../dto/agent.response.dto";
import { buildDeliveryTaskDTO } from "../task-summary";
import type { OrderService } from "../../order/service/order.service";
import { container } from "../../../lib/di/container";

const STATUS_TO_ORDER_STATUS: Record<"picked" | "delivered", OrderStatus> = {
    picked: OrderStatus.PICKED,
    delivered: OrderStatus.DELIVERED,
};

@injectable()
export class DeliveryController {
    constructor(@inject(TOKENS.DeliveryService) private readonly deliveryService: DeliveryService) { }

    assign = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(AssignDeliveryRequestDTO, req.body);
            const order = await this.deliveryService.assign(String(req.params.orderId), req.region!, data.agentId);
            sendSuccess(res, await buildDeliveryTaskDTO(order, this.orderService()));
        } catch (error) {
            next(error);
        }
    };

    reassign = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const order = await this.deliveryService.reassign(String(req.params.orderId), req.region!);
            sendSuccess(res, await buildDeliveryTaskDTO(order, this.orderService()));
        } catch (error) {
            next(error);
        }
    };

    accept = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const order = await this.deliveryService.accept(String(req.params.orderId), req.region!, req.user!.userId);
            sendSuccess(res, await buildDeliveryTaskDTO(order, this.orderService()));
        } catch (error) {
            next(error);
        }
    };

    decline = async (req: Request, res: Response, next: NextFunction) => {
        try {
            await this.deliveryService.decline(String(req.params.orderId), req.region!, req.user!.userId);
            sendSuccess(res, { ok: true });
        } catch (error) {
            next(error);
        }
    };

    updateStatus = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(UpdateDeliveryStatusRequestDTO, req.body);
            const order = await this.deliveryService.updateStatus(
                String(req.params.orderId),
                req.region!,
                req.user!.userId,
                STATUS_TO_ORDER_STATUS[data.status],
            );
            sendSuccess(res, DeliveryStatusResponseDTO.from(order));
        } catch (error) {
            next(error);
        }
    };

    listTasks = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const status = typeof req.query.status === "string" ? (req.query.status as OrderStatus) : undefined;
            const pagination = parsePaginationQuery(req.query as Record<string, unknown>, ["assignedAt", "createdAt"]);
            const orders = await this.deliveryService.listTasks(req.user!.userId, req.region!, { status }, pagination);
            const { data, meta } = buildPaginationResult(orders, pagination.limit, pagination.sortBy);

            const tasks: DeliveryTaskResponseDTO[] = await Promise.all(
                data.map((order) => buildDeliveryTaskDTO(order, this.orderService())),
            );
            sendPaginated(res, tasks, meta);
        } catch (error) {
            next(error);
        }
    };

    getEarnings = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const now = new Date();
            const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
            const from = typeof req.query.from === "string" ? new Date(req.query.from) : defaultFrom;
            const to = typeof req.query.to === "string" ? new Date(req.query.to) : now;

            // parsePaginationQuery's own default sortBy is "createdAt" regardless of the
            // allowed-list passed in — agent_earnings has no such column (only
            // `earned_at`), so pin the default here rather than widen the shared helper.
            const pagination = parsePaginationQuery(req.query as Record<string, unknown>, ["earnedAt"]);
            if (typeof req.query.sortBy !== "string") pagination.sortBy = "earnedAt";
            const { earnings, totals, orderPublicIdById } = await this.deliveryService.getEarnings(
                req.user!.userId,
                req.region!,
                { from, to },
                pagination,
            );
            const { data, meta } = buildPaginationResult(earnings, pagination.limit, pagination.sortBy);

            const currency = data[0]?.currency ?? "EGP";
            sendSuccess(res, AgentEarningsResponseDTO.from({ from, to }, totals, currency, data, orderPublicIdById, meta.nextCursor));
        } catch (error) {
            next(error);
        }
    };

    // Resolved lazily rather than constructor-injected — same reasoning as
    // presence.service.ts (cross-module).
    private orderService(): OrderService {
        return container.resolve<OrderService>(TOKENS.OrderService);
    }
}
