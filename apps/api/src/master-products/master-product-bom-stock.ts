export type BomStockItem = {
  quantity: number;
  componentStockQty: number;
  componentStatus?: number;
};

export type ProductBomStockInput = {
  productType?: string | null;
  stockQty?: number | null;
  bomComponents?: Array<{
    quantity: number;
    part: {
      stockQty?: number | null;
      status?: number | null;
    };
  }> | null;
};

export type ProductStockAvailability = {
  finishedStock: number;
  assemblableStock: number | null;
  fulfillableStock: number;
};

function toNonNegativeInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

export function calculateAssemblableStock(items: BomStockItem[]): number | null {
  if (!Array.isArray(items) || items.length === 0) return null;

  let result = Number.MAX_SAFE_INTEGER;
  for (const item of items) {
    const quantity = Number(item?.quantity ?? 0);
    const componentStockQty = toNonNegativeInteger(item?.componentStockQty);
    const componentStatus = Number(item?.componentStatus ?? 1);
    if (!Number.isInteger(quantity) || quantity <= 0 || componentStatus !== 1) return 0;
    result = Math.min(result, Math.floor(componentStockQty / quantity));
  }
  return Number.isSafeInteger(result) ? Math.max(0, result) : 0;
}

export function calculateProductStockAvailability(
  product: ProductBomStockInput | null | undefined,
): ProductStockAvailability {
  const finishedStock = toNonNegativeInteger(product?.stockQty);
  if (String(product?.productType ?? '').trim() !== '肩带') {
    return { finishedStock, assemblableStock: null, fulfillableStock: finishedStock };
  }

  const assemblableStock = calculateAssemblableStock(
    (product?.bomComponents ?? []).map((item) => ({
      quantity: Number(item.quantity),
      componentStockQty: toNonNegativeInteger(item.part?.stockQty),
      componentStatus: Number(item.part?.status ?? 0),
    })),
  );
  return {
    finishedStock,
    assemblableStock,
    fulfillableStock: finishedStock + (assemblableStock ?? 0),
  };
}
