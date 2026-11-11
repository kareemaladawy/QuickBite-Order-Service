import { NextFunction, Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { sendPaginated, sendSuccess } from "../../../lib/http/response";
import { buildPaginationResult } from "../../../lib/http/pagination/cursor-pagination";
import { parsePaginationQuery } from "../../../lib/http/pagination/parse-query";
import { validateBody } from "../../../lib/validation/validate";
import { addMs, toMs } from "../../../pkg/utils/time";
import { FinanceService } from "../service/finance.service";
import { CreatePayoutRequestDTO } from "../dto/finance.request.dto";
import { PayoutResponseDTO, RestaurantBalanceResponseDTO, RestaurantLedgerEntryResponseDTO } from "../dto/finance.response.dto";
import { MissingIdempotencyKeyError } from "../errors";

const DEFAULT_PAYOUT_LOOKBACK_DAYS = 90;
const DEFAULT_LEDGER_LOOKBACK_DAYS = 90;
const DEFAULT_CURRENCY = "EGP";

@injectable()
export class FinanceController {
    constructor(@inject(TOKENS.FinanceService) private readonly financeService: FinanceService) { }

    getBalance = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const restaurantId = Number(req.user!.restaurantId);
            const balances = await this.financeService.getBalance(restaurantId, req.region!);

            sendSuccess(res, RestaurantBalanceResponseDTO.from(restaurantId, balances));
        } catch (error) {
            next(error);
        }
    };

    listLedger = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const restaurantId = Number(req.user!.restaurantId);
            const currency = typeof req.query.currency === "string" ? req.query.currency : DEFAULT_CURRENCY;
            const from =
                typeof req.query.from === "string" ? new Date(req.query.from) : addMs(new Date(), -toMs(DEFAULT_LEDGER_LOOKBACK_DAYS, "d"));
            const to = typeof req.query.to === "string" ? new Date(req.query.to) : new Date();

            const pagination = parsePaginationQuery(req.query as Record<string, unknown>, ["createdAt"]);
            const { entries, orderPublicIdById } = await this.financeService.listLedger(
                restaurantId, req.region!, currency, { from, to }, pagination,
            );
            const { data, meta } = buildPaginationResult(entries, pagination.limit, pagination.sortBy);

            sendPaginated(res, data.map((e) => RestaurantLedgerEntryResponseDTO.from(e, orderPublicIdById)), meta);
        } catch (error) {
            next(error);
        }
    };

    listPayouts = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const restaurantId = Number(req.user!.restaurantId);
            const from =
                typeof req.query.from === "string" ? new Date(req.query.from) : addMs(new Date(), -toMs(DEFAULT_PAYOUT_LOOKBACK_DAYS, "d"));
            const to = typeof req.query.to === "string" ? new Date(req.query.to) : new Date();

            const pagination = parsePaginationQuery(req.query as Record<string, unknown>, ["createdAt"]);
            const payouts = await this.financeService.listPayouts(restaurantId, req.region!, { from, to }, pagination);
            const { data, meta } = buildPaginationResult(payouts, pagination.limit, pagination.sortBy);

            sendPaginated(res, data.map(PayoutResponseDTO.from), meta);
        } catch (error) {
            next(error);
        }
    };

    createPayout = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const idempotencyKey = req.headers["idempotency-key"];
            if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
                throw MissingIdempotencyKeyError;
            }

            const data = await validateBody(CreatePayoutRequestDTO, req.body);
            const payout = await this.financeService.recordPayout(req.region!, data, idempotencyKey);

            sendSuccess(res, PayoutResponseDTO.from(payout), 201);
        } catch (error) {
            next(error);
        }
    };
}
