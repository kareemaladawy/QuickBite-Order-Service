import {randomUUID} from "crypto";
import {db, destroyAll} from "../../../src/lib/knex/knex";
import {creditBalance, debitUnconditional, findBalancesByRestaurant} from "../../../src/app/restaurant-finance/repository/restaurant-balance.repo";
import {truncateAll} from "../../helpers/db";

/**
 * Guards the core finance invariant for the account-ledger model (CLAUDE.md §7 /
 * restaurant-finance.md): the denormalised `restaurant_balances.balance` MUST equal
 * the sum of `restaurant_ledger.amount` for that restaurant/currency — balance_after
 * on the latest ledger row must also match. If a future change books a ledger entry
 * without the matching balance delta (or vice versa), this test fails.
 */
const REGION = "eg";
const RESTAURANT = 1;
const CURRENCY = "EGP";
const conn = () => db(REGION);

// A delivered COD order: subtotal 10000, delivery 1500, service 500, total 12000.
const SUBTOTAL = 10000;
const COMMISSION = 1000; // 10% of subtotal

// restaurant_ledger.order_id/order_created_at is a real composite FK into
// orders(id, created_at) (orders is partitioned by created_at — see
// 20260418000020_create_orders.ts), so the ledger rows below need an actual
// order row behind them, not an arbitrary id.
async function seedOrder(): Promise<{id: number; createdAt: Date}> {
    // Pass created_at explicitly rather than relying on the column's NOW() default —
    // Postgres' `timestamp` has microsecond precision but the pg driver round-trips
    // through a JS Date (millisecond precision only), so a value that DB-generated
    // its own created_at can come back with sub-millisecond digits that don't survive
    // the round trip, and the composite FK insert below would then fail a byte-exact
    // comparison against this same Date re-sent as order_created_at.
    const ts = new Date();
    const [row] = await conn()("orders")
        .insert({
            region: REGION,
            created_at: ts,
            updated_at: ts,
            public_id: randomUUID(),
            country_code: "EG",
            restaurant_id: RESTAURANT,
            branch_id: 1,
            customer_id: 500,
            customer_address_id: 1,
            delivery_lat: 30.0,
            delivery_lng: 31.0,
            delivery_address_text_snapshot: "addr",
            pickup_lat: 30.1,
            pickup_lng: 31.1,
            pickup_address_text_snapshot: "branch addr",
            branch_name_snapshot: "Branch 1",
            status: "delivered",
            subtotal: SUBTOTAL,
            delivery_fee: 1500,
            service_fee: 500,
            total: SUBTOTAL + 1500 + 500,
            commission: COMMISSION,
            currency: CURRENCY,
            payment_method: "cod",
        })
        .returning(["id", "created_at"]);
    return {id: Number(row.id), createdAt: row.created_at};
}

async function ledgerNet(restaurantId: number, currency: string): Promise<number> {
    const row = await conn()("restaurant_ledger")
        .where({restaurant_id: restaurantId, currency})
        .select(conn().raw(`COALESCE(SUM(amount), 0) AS net`))
        .first<{net: string}>();
    return Number(row!.net);
}

describe("restaurant balance <-> restaurant_ledger reconciliation", () => {
    beforeEach(async () => {
        await truncateAll(conn());
    });

    afterAll(async () => {
        await destroyAll();
    });

    it("balance equals the ledger net after a settled order (settlement credit + commission debit)", async () => {
        const order = await seedOrder();

        // Mirror exactly what FinanceService.recordDeliverySettlement writes on `delivered`.
        const afterSettlement = await creditBalance(RESTAURANT, REGION, CURRENCY, SUBTOTAL, conn());
        await conn()("restaurant_ledger").insert({
            region: REGION,
            restaurant_id: RESTAURANT,
            currency: CURRENCY,
            entry_type: "settlement_credit",
            amount: SUBTOTAL,
            balance_after: afterSettlement.balance,
            order_id: order.id,
            order_created_at: order.createdAt,
        });

        const afterCommission = await debitUnconditional(RESTAURANT, REGION, CURRENCY, COMMISSION, conn());
        await conn()("restaurant_ledger").insert({
            region: REGION,
            restaurant_id: RESTAURANT,
            currency: CURRENCY,
            entry_type: "commission_debit",
            amount: -COMMISSION,
            balance_after: afterCommission.balance,
            order_id: order.id,
            order_created_at: order.createdAt,
        });

        const balances = await findBalancesByRestaurant(RESTAURANT, conn());
        expect(balances).toHaveLength(1);

        // subtotal - commission = 9000.
        expect(balances[0].balance).toBe(SUBTOTAL - COMMISSION);
        expect(afterCommission.balance).toBe(SUBTOTAL - COMMISSION);
        // ...and that equals the ledger net for the restaurant.
        expect(await ledgerNet(RESTAURANT, CURRENCY)).toBe(SUBTOTAL - COMMISSION);
        expect(balances[0].balance).toBe(await ledgerNet(RESTAURANT, CURRENCY));
    });

    it("accumulates correctly across two settled orders", async () => {
        for (let i = 0; i < 2; i++) {
            const order = await seedOrder();
            const afterSettlement = await creditBalance(RESTAURANT, REGION, CURRENCY, SUBTOTAL, conn());
            await conn()("restaurant_ledger").insert({
                region: REGION,
                restaurant_id: RESTAURANT,
                currency: CURRENCY,
                entry_type: "settlement_credit",
                amount: SUBTOTAL,
                balance_after: afterSettlement.balance,
                order_id: order.id,
                order_created_at: order.createdAt,
            });

            const afterCommission = await debitUnconditional(RESTAURANT, REGION, CURRENCY, COMMISSION, conn());
            await conn()("restaurant_ledger").insert({
                region: REGION,
                restaurant_id: RESTAURANT,
                currency: CURRENCY,
                entry_type: "commission_debit",
                amount: -COMMISSION,
                balance_after: afterCommission.balance,
                order_id: order.id,
                order_created_at: order.createdAt,
            });
        }

        const balances = await findBalancesByRestaurant(RESTAURANT, conn());
        expect(balances[0].balance).toBe(2 * (SUBTOTAL - COMMISSION));
        expect(balances[0].balance).toBe(await ledgerNet(RESTAURANT, CURRENCY));
    });

    it("allows the balance to go negative on a refund clawback (debitUnconditional), matching the ledger", async () => {
        const order = await seedOrder();
        const settleAfter = await creditBalance(RESTAURANT, REGION, CURRENCY, SUBTOTAL, conn());
        await conn()("restaurant_ledger").insert({
            region: REGION, restaurant_id: RESTAURANT, currency: CURRENCY,
            entry_type: "settlement_credit", amount: SUBTOTAL, balance_after: settleAfter.balance,
            order_id: order.id, order_created_at: order.createdAt,
        });

        // A refund clawback larger than the settlement itself pushes the balance negative
        // (restaurant now owes the platform — recovered from its next payout).
        const clawbackAmount = SUBTOTAL + 500;
        const afterClawback = await debitUnconditional(RESTAURANT, REGION, CURRENCY, clawbackAmount, conn());
        await conn()("restaurant_ledger").insert({
            region: REGION, restaurant_id: RESTAURANT, currency: CURRENCY,
            entry_type: "refund_debit", amount: -clawbackAmount, balance_after: afterClawback.balance,
            order_id: order.id, order_created_at: order.createdAt,
        });

        expect(afterClawback.balance).toBe(SUBTOTAL - clawbackAmount);
        expect(afterClawback.balance).toBeLessThan(0);
        expect(afterClawback.balance).toBe(await ledgerNet(RESTAURANT, CURRENCY));
    });
});
