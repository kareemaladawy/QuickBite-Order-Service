import { NextFunction, Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { sendPaginated, sendSuccess } from "../../../lib/http/response";
import { buildPaginationResult } from "../../../lib/http/pagination/cursor-pagination";
import { parsePaginationQuery } from "../../../lib/http/pagination/parse-query";
import { validateBody } from "../../../lib/validation/validate";
import { addMs, toMs } from "../../../pkg/utils/time";
import { AgentFinanceService } from "../service/agent-finance.service";
import { CreatePayoutRequestDTO } from "../dto/agent.request.dto";
import { AgentBalanceResponseDTO, AgentPayoutResponseDTO } from "../dto/agent.response.dto";
import { MissingIdempotencyKeyError } from "../errors";

const DEFAULT_PAYOUT_LOOKBACK_DAYS = 90;

@injectable()
export class AgentFinanceController {
    constructor(@inject(TOKENS.AgentFinanceService) private readonly agentFinanceService: AgentFinanceService) { }

    getBalance = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const agentId = req.user!.userId;
            const balances = await this.agentFinanceService.getBalance(agentId, req.region!);

            sendSuccess(res, AgentBalanceResponseDTO.from(agentId, balances));
        } catch (error) {
            next(error);
        }
    };

    listPayouts = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const agentId = req.user!.userId;
            const from =
                typeof req.query.from === "string" ? new Date(req.query.from) : addMs(new Date(), -toMs(DEFAULT_PAYOUT_LOOKBACK_DAYS, "d"));
            const to = typeof req.query.to === "string" ? new Date(req.query.to) : new Date();

            const pagination = parsePaginationQuery(req.query as Record<string, unknown>, ["createdAt"]);
            const payouts = await this.agentFinanceService.listPayouts(agentId, req.region!, { from, to }, pagination);
            const { data, meta } = buildPaginationResult(payouts, pagination.limit, pagination.sortBy);

            sendPaginated(res, data.map(AgentPayoutResponseDTO.from), meta);
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
            const payout = await this.agentFinanceService.recordPayout(req.region!, data, idempotencyKey);

            sendSuccess(res, AgentPayoutResponseDTO.from(payout), 201);
        } catch (error) {
            next(error);
        }
    };
}
