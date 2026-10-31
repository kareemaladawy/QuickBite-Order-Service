import { Order } from "../order/entity/order.entity";
import type { OrderService } from "../order/service/order.service";
import { DeliveryTaskResponseDTO } from "./dto/agent.response.dto";

// Shared by assignment.service.ts (task.assigned WS payload) and delivery.controller.ts
// (HTTP responses) so the items lookup that backs DeliveryTaskResponseDTO lives in
// exactly one place. Pickup branch fields come straight off the order's own
// pickup*/branchNameSnapshot columns, not a core-service call.
export async function buildDeliveryTaskDTO(order: Order, orderService: OrderService): Promise<DeliveryTaskResponseDTO> {
    const itemsCount = await orderService.countItemsForOrder(order.id, order.region);
    return DeliveryTaskResponseDTO.from(order, itemsCount);
}
