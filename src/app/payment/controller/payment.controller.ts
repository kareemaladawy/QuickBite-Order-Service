import { NextFunction, Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { sendSuccess } from "../../../lib/http/response";
import { validateBody } from "../../../lib/validation/validate";
import { RegionNotResolvedError } from "../../../lib/sharding/errors";
import { PaymentService } from "../service/payment.service";
import { InitPaymentRequestDTO, RefundRequestDTO } from "../dto/payment.request.dto";
import { PaymentInitResponseDTO, PaymentResponseDTO } from "../dto/payment.response.dto";
import { MissingIdempotencyKeyError } from "../errors";

@injectable()
export class PaymentController {
    constructor(@inject(TOKENS.PaymentService) private readonly paymentService: PaymentService) { }

    init = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const data = await validateBody(InitPaymentRequestDTO, req.body);
            const result = await this.paymentService.initRetry(req.user!, data.orderId, req.region);

            sendSuccess(res, PaymentInitResponseDTO.from(result));
        } catch (error) {
            next(error);
        }
    };

    getById = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const restaurantId = Number(req.params.restaurantId);
            const transactionId = Number(req.params.paymentId);
            const { transaction, orderPublicId, refunds } = await this.paymentService.getById(
                transactionId,
                restaurantId,
                req.region
            );

            sendSuccess(res, PaymentResponseDTO.from(transaction, orderPublicId, refunds));
        } catch (error) {
            next(error);
        }
    };

    refund = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const idempotencyKey = req.headers["idempotency-key"];
            if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
                throw MissingIdempotencyKeyError;
            }

            const transactionId = Number(req.params.paymentId);
            const data = await validateBody(RefundRequestDTO, req.body);
            const refund = await this.paymentService.refund(req.user!, transactionId, req.region, data, idempotencyKey);

            sendSuccess(res, PaymentResponseDTO.from(refund, null));
        } catch (error) {
            next(error);
        }
    };
}
