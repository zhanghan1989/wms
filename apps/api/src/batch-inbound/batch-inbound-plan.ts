import { UnprocessableEntityException } from '@nestjs/common';

type Plan = { productId: string; qty: number };
type Item = Plan & { boxCode: string; status?: string };

export function summarizeInboundPlan(plans: Plan[], items: Item[]) {
  const totals = new Map<string, { boxedQty: number; confirmedQty: number }>();
  for (const item of items) {
    const total = totals.get(item.productId) ?? { boxedQty: 0, confirmedQty: 0 };
    total.boxedQty += item.qty;
    if (item.status === 'confirmed') total.confirmedQty += item.qty;
    totals.set(item.productId, total);
  }
  return plans.map((plan) => {
    const { boxedQty, confirmedQty } = totals.get(plan.productId) ?? { boxedQty: 0, confirmedQty: 0 };
    return { ...plan, boxedQty, confirmedQty, unpackedQty: Math.max(0, plan.qty - boxedQty), inTransitQty: Math.max(0, plan.qty - confirmedQty) };
  });
}

// The file is the complete packing list. Confirmed lines must be retained exactly;
// only pending lines are replaced. Unpacked quantities stay in the plan, not stock.
export function validateInboundPacking(plans: Plan[], previous: Item[], uploaded: Item[]) {
  const totals = new Map<string, number>();
  for (const item of uploaded) totals.set(item.productId, (totals.get(item.productId) ?? 0) + item.qty);
  const expected = new Map(plans.map((item) => [item.productId, item.qty]));
  for (const [productId, qty] of totals) {
    if (!expected.has(productId) || qty > expected.get(productId)!) {
      throw new UnprocessableEntityException(`产品 ${productId} 装箱数量 ${qty} 超过预登记数量 ${expected.get(productId) ?? 0}；请先核对并更新原批次预登记数量`);
    }
  }
  for (const item of previous.filter((line) => line.status === 'confirmed')) {
    const replacement = uploaded.find((line) => line.boxCode === item.boxCode && line.productId === item.productId);
    if (!replacement || replacement.qty !== item.qty) {
      throw new UnprocessableEntityException(`已入库的 ${item.boxCode}/${item.productId} 不能修改或省略，请上传包含已入库行的完整装箱表`);
    }
    if (uploaded.some((line) => line.boxCode === item.boxCode
      && !previous.some((old) => old.boxCode === line.boxCode && old.productId === line.productId))) {
      throw new UnprocessableEntityException(`箱号 ${item.boxCode} 已有入库记录，不能追加产品`);
    }
  }
}
