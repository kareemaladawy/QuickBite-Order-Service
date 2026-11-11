import { injectable } from "tsyringe";
import type { Knex } from "knex";
import { container } from "../../../lib/di/container";
import { TOKENS } from "../../../lib/di/tokens";
import { db } from "../../../lib/knex/knex";
import { PaginationParams } from "../../../lib/http/pagination/types";
import type { OrderService } from "../../order/service/order.service";
import type { PaymentService } from "../../payment/service/payment.service";
import { PayeeAccountType } from "../../payment/enums";
import { TreasuryLedgerEntry } from "../../payment/entity/treasury-ledger-entry.entity";
import { AgentBalance } from "../entity/agent-balance.entity";
import { AgentLedgerEntry } from "../entity/agent-ledger-entry.entity";
import { creditBalance, debitIfSufficient, findBalancesByAgent } from "../repository/agent-balance.repo";
import { findEarningsByAgent, insertLedgerEntry, sumEarningsByAgent } from "../repository/agent-ledger.repo";
import { AgentLedgerEntryType } from "../enums";
import { CreatePayoutRequestDTO } from "../dto/agent.request.dto";
import { EarningsRange, PayoutRow } from "../types";
import { InsufficientBalanceError } from "../errors";

function toPayoutRow(entry: TreasuryLedgerEntry): PayoutRow {
    return {
        id: entry.id,
        amount: entry.amount,
        currency: entry.currency,
        status: entry.status,
        providerReferenceId: entry.providerReferenceId,
        createdAt: entry.createdAt,
    };
}

@injectable()
export class AgentFinanceService {
    getBalance = async (agentId: number, region: string): Promise<AgentBalance[]> => {
        return findBalancesByAgent(agentId, db(region));
    };

    listPayouts = async (
        agentId: number,
        region: string,
        range: EarningsRange,
        pagination: PaginationParams,
    ): Promise<PayoutRow[]> => {
        const entries = await this.paymentService().listPayoutsForPayee(PayeeAccountType.AGENT, agentId, region, range, pagination);
        return entries.map(toPayoutRow);
    };

    recordPayout = async (region: string, data: CreatePayoutRequestDTO, idempotencyKey: string): Promise<PayoutRow> => {
        const conn = db(region);
        const trx = await conn.transaction();
        try {
            const treasuryEntry = await this.paymentService().recordPayout({
                region, payeeAccountType: PayeeAccountType.AGENT, payeeAccountId: data.agentId,
                amount: data.amount, currency: data.currency, providerReferenceId: data.providerReferenceId, idempotencyKey,
            }, trx);

            const debited = await debitIfSufficient(data.agentId, data.currency, data.amount, trx);
            if (!debited) throw InsufficientBalanceError;

            await insertLedgerEntry({
                region, agentId: data.agentId, currency: data.currency,
                entryType: AgentLedgerEntryType.PAYOUT_DEBIT, amount: -data.amount, balanceAfter: debited.balance,
                treasuryLedgerId: treasuryEntry.id,
            }, trx);

            await trx.commit();
            return toPayoutRow(treasuryEntry);
        } catch (err) {
            await trx.rollback();
            throw err;
        }
    };

    // Called by delivery.service's settleDelivered on `delivered`, inside the trx it
    // already owns — same shape as restaurant-finance's recordDeliverySettlement.
    recordEarning = async (
        agentId: number, region: string, orderId: number, orderCreatedAt: Date, amountMinor: number, currency: string, trx: Knex.Transaction,
    ): Promise<void> => {
        const afterCredit = await creditBalance(agentId, region, currency, amountMinor, trx);
        await insertLedgerEntry({
            region, agentId, currency, entryType: AgentLedgerEntryType.EARNING_CREDIT,
            amount: amountMinor, balanceAfter: afterCredit.balance, orderId, orderCreatedAt,
        }, trx);
    };

    getEarnings = async (
        agentId: number, region: string, range: EarningsRange, pagination: PaginationParams,
    ): Promise<{ earnings: AgentLedgerEntry[]; totals: { count: number; sum: number }; orderPublicIdById: Map<number, string> }> => {
        const conn = db(region);
        const [earnings, totals] = await Promise.all([
            findEarningsByAgent(agentId, range, pagination, conn),
            sumEarningsByAgent(agentId, range, conn),
        ]);
        const withOrder = earnings.filter((e) => e.orderId !== null && e.orderCreatedAt !== null);
        const orders = withOrder.length > 0
            ? await this.orderService().getOrdersByCompositeIds(
                withOrder.map((e) => ({ id: e.orderId!, createdAt: e.orderCreatedAt! })), region,
            )
            : [];
        const orderPublicIdById = new Map(orders.map((o) => [o.id, o.publicId]));
        return { earnings, totals, orderPublicIdById };
    };

    private paymentService(): PaymentService {
        return container.resolve<PaymentService>(TOKENS.PaymentService);
    }

    private orderService(): OrderService {
        return container.resolve<OrderService>(TOKENS.OrderService);
    }
}
