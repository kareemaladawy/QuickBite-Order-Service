import { injectable } from "tsyringe";
import type { Knex } from "knex";
import { container } from "../../../lib/di/container";
import { TOKENS } from "../../../lib/di/tokens";
import { db } from "../../../lib/knex/knex";
import { getBranch } from "../../../lib/core-client/branch.client";
import { bpsOfMinor } from "../../../pkg/utils/money";
import { PaginationParams } from "../../../lib/http/pagination/types";
import { Order } from "../../order/entity/order.entity";
import { PaymentMethod } from "../../order/enums";
import type { PaymentService } from "../../payment/service/payment.service";
import type { OrderService } from "../../order/service/order.service";
import { PayeeAccountType } from "../../payment/enums";
import { TreasuryLedgerEntry } from "../../payment/entity/treasury-ledger-entry.entity";
import { RestaurantBalance } from "../entity/restaurant-balance.entity";
import { RestaurantLedgerEntry } from "../entity/restaurant-ledger-entry.entity";
import { creditBalance, debitIfSufficient, debitUnconditional, findBalancesByRestaurant } from "../repository/restaurant-balance.repo";
import { findLedgerByRestaurant, findLedgerEntryForOrder, insertLedgerEntry } from "../repository/restaurant-ledger.repo";
import { RestaurantLedgerEntryType } from "../enums";
import { CreatePayoutRequestDTO } from "../dto/finance.request.dto";
import { DateRange, PayoutRow } from "../types";
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
export class FinanceService {
    getBalance = async (restaurantId: number, region: string): Promise<RestaurantBalance[]> => {
        return findBalancesByRestaurant(restaurantId, db(region));
    };

    listLedger = async (
        restaurantId: number,
        region: string,
        currency: string,
        range: DateRange,
        pagination: PaginationParams,
    ): Promise<{ entries: RestaurantLedgerEntry[]; orderPublicIdById: Map<number, string> }> => {
        const entries = await findLedgerByRestaurant(restaurantId, currency, range, pagination, db(region));
        const withOrder = entries.filter((e) => e.orderId !== null && e.orderCreatedAt !== null);
        const orders = withOrder.length > 0
            ? await this.orderService().getOrdersByCompositeIds(
                withOrder.map((e) => ({ id: e.orderId!, createdAt: e.orderCreatedAt! })), region,
            )
            : [];
        return { entries, orderPublicIdById: new Map(orders.map((o) => [o.id, o.publicId])) };
    };

    listPayouts = async (
        restaurantId: number,
        region: string,
        range: DateRange,
        pagination: PaginationParams,
    ): Promise<PayoutRow[]> => {
        const entries = await this.paymentService().listPayoutsForPayee(
            PayeeAccountType.RESTAURANT, restaurantId, region, range, pagination,
        );
        return entries.map(toPayoutRow);
    };

    recordPayout = async (region: string, data: CreatePayoutRequestDTO, idempotencyKey: string): Promise<PayoutRow> => {
        const conn = db(region);
        const trx = await conn.transaction();
        try {
            const treasuryEntry = await this.paymentService().recordPayout({
                region, payeeAccountType: PayeeAccountType.RESTAURANT, payeeAccountId: data.restaurantId,
                amount: data.amount, currency: data.currency, providerReferenceId: data.providerReferenceId, idempotencyKey,
            }, trx);

            const debited = await debitIfSufficient(data.restaurantId, data.currency, data.amount, trx);
            if (!debited) throw InsufficientBalanceError;

            await insertLedgerEntry({
                region, restaurantId: data.restaurantId, currency: data.currency,
                entryType: RestaurantLedgerEntryType.PAYOUT_DEBIT, amount: -data.amount, balanceAfter: debited.balance,
                treasuryLedgerId: treasuryEntry.id,
            }, trx);

            await trx.commit();
            return toPayoutRow(treasuryEntry);
        } catch (err) {
            await trx.rollback();
            throw err;
        }
    };

    // restaurant-finance.md §7 — the only place order commission is calculated. Called
    // by the Agents module's delivery.service on `delivered`, inside the trx it already
    // owns (CLAUDE.md §8). `branch.commissionBps` is read live (through the existing
    // 5-minute read-through cache in branch.client.ts) rather than snapshotted on the
    // order row.
    //
    // Two account-ledger rows come out of one delivered order: a settlement_credit for
    // the full subtotal and a commission_debit for the platform's cut — never a single
    // netted row, so the ledger reads the same way Stripe's balance transactions do.
    recordDeliverySettlement = async (order: Order, trx: Knex.Transaction): Promise<{ commission: number }> => {
        const branch = await getBranch(order.branchId);
        const commission = bpsOfMinor(order.subtotal, branch.commissionBps);

        if (order.paymentMethod === PaymentMethod.COD) {
            await this.paymentService().recordCodCollection({
                region: order.region, orderId: order.id, orderCreatedAt: order.createdAt,
                customerId: order.customerId, amount: order.total, currency: order.currency,
            }, trx);
        }

        const afterSettlement = await creditBalance(order.restaurantId, order.region, order.currency, order.subtotal, trx);
        await insertLedgerEntry({
            region: order.region, restaurantId: order.restaurantId, currency: order.currency,
            entryType: RestaurantLedgerEntryType.SETTLEMENT_CREDIT, amount: order.subtotal, balanceAfter: afterSettlement.balance,
            orderId: order.id, orderCreatedAt: order.createdAt,
        }, trx);

        if (commission > 0) {
            const afterCommission = await debitUnconditional(order.restaurantId, order.region, order.currency, commission, trx);
            await insertLedgerEntry({
                region: order.region, restaurantId: order.restaurantId, currency: order.currency,
                entryType: RestaurantLedgerEntryType.COMMISSION_DEBIT, amount: -commission, balanceAfter: afterCommission.balance,
                orderId: order.id, orderCreatedAt: order.createdAt,
            }, trx);
        }

        return { commission };
    };

    // Closes the refund-after-delivery gap: a refund on an order that was never
    // settled (still pending/placed/etc.) has nothing to claw back — only an order
    // with a settlement_credit row needs its balance adjusted. The debit is
    // unconditional (balance may go negative; recovered from the restaurant's next
    // payout) — see restaurant_balances' migration for why the >= 0 check was dropped.
    recordRefundClawback = async (order: Order, refundAmountMinor: number, trx: Knex.Transaction): Promise<void> => {
        const settlement = await findLedgerEntryForOrder(
            order.restaurantId, order.id, RestaurantLedgerEntryType.SETTLEMENT_CREDIT, trx,
        );
        if (!settlement) return;

        const afterClawback = await debitUnconditional(order.restaurantId, order.region, order.currency, refundAmountMinor, trx);
        await insertLedgerEntry({
            region: order.region, restaurantId: order.restaurantId, currency: order.currency,
            entryType: RestaurantLedgerEntryType.REFUND_DEBIT, amount: -refundAmountMinor, balanceAfter: afterClawback.balance,
            orderId: order.id, orderCreatedAt: order.createdAt,
        }, trx);
    };

    private paymentService(): PaymentService {
        return container.resolve<PaymentService>(TOKENS.PaymentService);
    }

    private orderService(): OrderService {
        return container.resolve<OrderService>(TOKENS.OrderService);
    }
}
