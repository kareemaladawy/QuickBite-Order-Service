import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import {
    clearBranchRejectingOrders,
    invalidateBranch,
    markBranchRejectingOrders,
} from "../../../lib/core-client/branch.client";
import { updateProductPriceCache, updateProductStockCache } from "../../../lib/core-client/product.client";
import { invalidateRestaurant } from "../../../lib/core-client/restaurant.client";
import { OrderService } from "../service/order.service";
import {
    BranchChangedPayload,
    ProductPriceChangedPayload,
    ProductStockChangedPayload,
    RestaurantSuspendedPayload,
} from "../types";

// Thin adapter between the core-events transport (lib/core-events/consumer.ts) and the
// services/clients that own each side effect — mirrors the HTTP controller -> service
// shape (validate/cast the payload, delegate, nothing else) so a handler that later
// needs multi-step logic or a call to another microservice grows in the service layer,
// not here. See docs/implementation-plan.md Phase 1 item 12.
@injectable()
export class OrderEventsController {
    constructor(@inject(TOKENS.OrderService) private readonly orderService: OrderService) {}

    onProductStockChanged = async (payload: unknown): Promise<void> => {
        const { productId, branchId, stock, isAvailable } = payload as ProductStockChangedPayload;
        await updateProductStockCache(branchId, productId, stock, isAvailable);
    };

    onProductPriceChanged = async (payload: unknown): Promise<void> => {
        const { productId, branchId, price } = payload as ProductPriceChangedPayload;
        await updateProductPriceCache(branchId, productId, price);
    };

    onBranchUpdated = async (payload: unknown): Promise<void> => {
        const { branchId } = payload as BranchChangedPayload;
        // A reactivation (isActive/acceptOrders flipped back on) arrives as
        // branch.updated, not a dedicated "reactivated" event — clearing the flag here
        // lets placeOrder() fall back to the fresh branch read instead of staying
        // hard-blocked.
        await Promise.all([invalidateBranch(branchId), clearBranchRejectingOrders(branchId)]);
    };

    onBranchDeactivated = async (payload: unknown): Promise<void> => {
        const { branchId } = payload as BranchChangedPayload;
        await Promise.all([invalidateBranch(branchId), markBranchRejectingOrders(branchId)]);
    };

    onRestaurantSuspended = async (payload: unknown): Promise<void> => {
        const { restaurantId } = payload as RestaurantSuspendedPayload;
        await invalidateRestaurant(restaurantId);
        await this.orderService.flagPendingOrdersForReview(restaurantId);
    };
}
