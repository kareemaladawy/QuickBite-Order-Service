import { NextFunction, Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { PaymentWebhookService } from "../service/payment-webhook.service";

@injectable()
export class WebhookController {
    constructor(@inject(TOKENS.PaymentWebhookService) private readonly paymentWebhookService: PaymentWebhookService) {}

    handle = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await this.paymentWebhookService.handle(
                String(req.params.provider),
                req.body as Record<string, unknown>,
                req.headers as Record<string, string | string[] | undefined>,
            );

            res.status(200).json({ success: true, duplicate: result.duplicate });
        } catch (error) {
            next(error);
        }
    };
}
