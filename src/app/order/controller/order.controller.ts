import { NextFunction, Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { sendPaginated, sendSuccess } from "../../../lib/http/response";
import { buildPaginationResult } from "../../../lib/http/pagination/cursor-pagination";
import { parsePaginationQuery } from "../../../lib/http/pagination/parse-query";
import { validateBody } from "../../../lib/validation/validate";
import { OrderService } from "../service/order.service";
import { CreateOrderRequestDTO, UpdateOrderStatusRequestDTO } from "../dto/order.request.dto";
import { OrderResponseDTO, OrderStatusResponseDTO, OrderSummaryResponseDTO } from "../dto/order.response.dto";
import { OrderStatus } from "../enums";
import { RegionNotResolvedError } from "../../../lib/sharding/errors";
import { BranchIdRequiredError, MissingIdempotencyKeyError } from "../errors";

@injectable()
export class OrderController {
    constructor(@inject(TOKENS.OrderService) private readonly orderService: OrderService) {}

    placeOrder = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const idempotencyKey = req.headers["idempotency-key"];
            if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
                throw MissingIdempotencyKeyError;
            }

            const data = await validateBody(CreateOrderRequestDTO, req.body);
            const { order, items } = await this.orderService.placeOrder(
                req.user!,
                data,
                idempotencyKey,
                req.correlationId,
            );

            sendSuccess(res, OrderResponseDTO.from(order, items), 201);
        } catch (error) {
            next(error);
        }
    };

    getOrder = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const { order, items } = await this.orderService.getOrder(String(req.params.orderId), req.region, req.user!);
            sendSuccess(res, OrderResponseDTO.from(order, items));
        } catch (error) {
            next(error);
        }
    };

    listCustomerOrders = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const pagination = parsePaginationQuery(req.query as Record<string, unknown>, ["createdAt"]);
            const orders = await this.orderService.listCustomerOrders(req.user!.userId, req.region, pagination);
            const { data, meta } = buildPaginationResult(orders, pagination.limit, pagination.sortBy);

            sendPaginated(res, data.map(OrderSummaryResponseDTO.from), meta);
        } catch (error) {
            next(error);
        }
    };

    listRestaurantOrders = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const branchId = Number(req.query.branchId);
            if (!branchId) throw BranchIdRequiredError;

            const status = typeof req.query.status === "string" ? (req.query.status as OrderStatus) : undefined;
            const from = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
            const to = typeof req.query.to === "string" ? new Date(req.query.to) : undefined;

            const pagination = parsePaginationQuery(req.query as Record<string, unknown>, ["createdAt"]);
            const orders = await this.orderService.listRestaurantOrders(
                branchId,
                req.region,
                { status, from, to },
                pagination,
            );
            const { data, meta } = buildPaginationResult(orders, pagination.limit, pagination.sortBy);

            sendPaginated(res, data.map(OrderSummaryResponseDTO.from), meta);
        } catch (error) {
            next(error);
        }
    };

    updateStatus = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const data = await validateBody(UpdateOrderStatusRequestDTO, req.body);
            const order = await this.orderService.updateStatus(String(req.params.orderId), req.region, req.user!, data);

            sendSuccess(res, OrderStatusResponseDTO.from(order));
        } catch (error) {
            next(error);
        }
    };
}
