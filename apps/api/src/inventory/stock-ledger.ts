import { Prisma } from '@prisma/client';
import { generateOrderNo } from '../common/utils';

// Used by product-only adjustment, bulk update and paired move entries.
export async function recordStockAdjustment(
  tx: Prisma.TransactionClient,
  operatorId: bigint,
  items: Array<{ boxId: bigint; productId: string; qtyDelta: number; skuId?: bigint | null }>,
  reason: string,
): Promise<{ id: bigint; adjustNo: string }> {
  const order = await tx.inventoryAdjustOrder.create({ data: {
    adjustNo: generateOrderNo('ADJ'), status: 'confirmed', createdBy: operatorId, remark: reason.slice(0, 255),
  } });
  for (const [index, item] of items.entries()) {
    await tx.inventoryAdjustOrderItem.create({ data: {
      orderId: order.id, ...item, reason: reason.slice(0, 128),
    } });
    await tx.stockMovement.create({ data: {
      ...item, movementType: 'adjust', refType: 'inventory_adjust_order', refId: order.id,
      operatorId, operationKey: `adjust:${order.id}:${index}`,
    } });
  }
  return order;
}
