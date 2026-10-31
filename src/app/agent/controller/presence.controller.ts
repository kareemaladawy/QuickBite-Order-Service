import { NextFunction, Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { sendSuccess } from "../../../lib/http/response";
import { validateBody } from "../../../lib/validation/validate";
import { PresenceService } from "../service/presence.service";
import { PresenceOnlineRequestDTO } from "../dto/agent.request.dto";

@injectable()
export class PresenceController {
    constructor(@inject(TOKENS.PresenceService) private readonly presenceService: PresenceService) { }

    online = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(PresenceOnlineRequestDTO, req.body);
            await this.presenceService.goOnline(req.user!.userId, req.region!, data.lat, data.lng);
            sendSuccess(res, { ok: true });
        } catch (error) {
            next(error);
        }
    };

    offline = async (req: Request, res: Response, next: NextFunction) => {
        try {
            await this.presenceService.goOffline(req.user!.userId, req.region!);
            sendSuccess(res, { ok: true });
        } catch (error) {
            next(error);
        }
    };

    ping = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(PresenceOnlineRequestDTO, req.body);
            await this.presenceService.ping(req.user!.userId, req.region!, data.lat, data.lng);
            sendSuccess(res, { ok: true });
        } catch (error) {
            next(error);
        }
    };
}
