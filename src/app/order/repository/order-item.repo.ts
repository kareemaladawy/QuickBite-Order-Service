import { Knex } from "knex";
import { OrderItem } from "../entity/order-item.entity";
import { CreateOrderItemRow } from "../types";

const ORDER_ITEM_COLUMNS = [
    "id",
    "region",
    "order_id",
    "order_created_at",
    "product_id",
    "quantity",
    "unit_price_snapshot",
    "name_snapshot",
    "image_url_snapshot",
    "line_total",
    "created_at",
];

// bigint columns (id, order_id, product_id) come back from node-pg as strings; Number()
// is safe here since these ids are well under the 2^53 precision boundary.
function toEntity(row: any): OrderItem {
    return new OrderItem({
        id: Number(row.id),
        region: row.region,
        orderId: Number(row.order_id),
        orderCreatedAt: row.order_created_at,
        productId: Number(row.product_id),
        quantity: row.quantity,
        unitPriceSnapshot: row.unit_price_snapshot,
        nameSnapshot: row.name_snapshot,
        imageUrlSnapshot: row.image_url_snapshot,
        lineTotal: row.line_total,
        createdAt: row.created_at,
    });
}

// One INSERT ... VALUES ... (multi-row) — never loop-insert per item.
export async function bulkInsertItems(items: CreateOrderItemRow[], conn: Knex): Promise<OrderItem[]> {
    const now = new Date();
    const rows = await conn("order_items")
        .insert(
            items.map((item) => ({
                region: item.region,
                order_id: item.orderId,
                order_created_at: item.orderCreatedAt,
                product_id: item.productId,
                quantity: item.quantity,
                unit_price_snapshot: item.unitPriceSnapshot,
                name_snapshot: item.nameSnapshot,
                image_url_snapshot: item.imageUrlSnapshot,
                line_total: item.lineTotal,
                created_at: now,
            })),
        )
        .returning(ORDER_ITEM_COLUMNS);

    return rows.map(toEntity);
}

// Batch fetch for N orders in one round trip — guards against N+1 when listing orders.
export async function findItemsByOrderIds(orderIds: number[], conn: Knex): Promise<OrderItem[]> {
    if (orderIds.length === 0) return [];
    const rows = await conn("order_items").whereIn("order_id", orderIds).select(ORDER_ITEM_COLUMNS);
    return rows.map(toEntity);
}
