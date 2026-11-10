import { injectable } from "tsyringe";
import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { getBranch } from "../../../lib/core-client/branch.client";
import { getRestaurant } from "../../../lib/core-client/restaurant.client";
import { bpsOfMinor } from "../../../pkg/utils/money";
import { PaginationParams } from "../../../lib/http/pagination/types";
import { Order } from "../../order/entity/order.entity";
import { PaymentMethod } from "../../order/enums";
import { RestaurantBalance } from "../entity/restaurant-balance.entity";
import { creditBalance, debitIfSufficient, findBalancesByRestaurant } from "../repository/restaurant-balance.repo";
import { findPayoutsByRestaurant, insertCodCollection, insertCommission, insertPayout } from "../repository/transaction.repo";
import { CreatePayoutRequestDTO } from "../dto/finance.request.dto";
import { DateRange, PayoutRow } from "../types";
import { InsufficientBalanceError } from "../errors";

@injectable()
export class FinanceService {
    getBalance = async (restaurantId: number, region: string): Promise<RestaurantBalance[]> => {
        return findBalancesByRestaurant(restaurantId, db(region));
    };

    listPayouts = async (
        restaurantId: number,
        region: string,
        range: DateRange,
        pagination: PaginationParams,
    ): Promise<PayoutRow[]> => {
        const restaurant = await getRestaurant(restaurantId);
        return findPayoutsByRestaurant(restaurant.ownerId, range, pagination, db(region));
    };

    recordPayout = async (region: string, data: CreatePayoutRequestDTO, idempotencyKey: string): Promise<PayoutRow> => {
        const restaurant = await getRestaurant(data.restaurantId);
        const conn = db(region);
        const trx = await conn.transaction();
        try {
            const debited = await debitIfSufficient(data.restaurantId, data.currency, data.amount, trx);
            if (!debited) throw InsufficientBalanceError;

            const payout = await insertPayout(
                {
                    region,
                    restaurantOwnerId: restaurant.ownerId,
                    amount: data.amount,
                    currency: data.currency,
                    providerReferenceId: data.providerReferenceId,
                    idempotencyKey,
                },
                trx,
            );

            await trx.commit();
            return payout;
        } catch (err) {
            await trx.rollback();
            throw err;
        }
    };

    // restaurant-finance.md §7 — the only place order commission is calculated. Called
    // by the Agents module's delivery.service on `delivered`, inside the trx it already
    // owns (CLAUDE.md §8). `branch.commissionBps` is read live (through the existing
    // 5-minute read-through cache in branch.client.ts) rather than snapshotted on the
    // order row — there is no commission_bps column on `orders`, only the final computed
    // `commission` amount, which the caller persists alongside the status flip.
    recordDeliverySettlement = async (order: Order, trx: Knex.Transaction): Promise<{ commission: number }> => {
        const [branch, restaurant] = await Promise.all([getBranch(order.branchId), getRestaurant(order.restaurantId)]);
        const commission = bpsOfMinor(order.subtotal, branch.commissionBps);
        const deltaBalance = order.subtotal - commission;

        if (order.paymentMethod === PaymentMethod.COD) {
            await insertCodCollection(
                {
                    region: order.region,
                    orderId: order.id,
                    orderCreatedAt: order.createdAt,
                    customerId: order.customerId,
                    restaurantOwnerId: restaurant.ownerId,
                    amount: order.total,
                    currency: order.currency,
                },
                trx,
            );
        }

        if (commission > 0) {
            await insertCommission(
                {
                    region: order.region,
                    orderId: order.id,
                    orderCreatedAt: order.createdAt,
                    restaurantOwnerId: restaurant.ownerId,
                    amount: commission,
                    currency: order.currency,
                },
                trx,
            );
        }

        await creditBalance(order.restaurantId, order.region, order.currency, deltaBalance, trx);

        return { commission };
    };
}
