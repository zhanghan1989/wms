export type BomStockItem = {
  quantity: number;
  componentStockQty: number;
  componentStatus?: number;
};

export type ProductBomStockInput = {
  productType?: string | null;
  stockQty?: number | null;
  boxInventories?: Array<{ qty?: number | null }> | null;
  bomComponents?: Array<{
    quantity: number;
    componentProduct: {
      stockQty?: number | null;
      status?: number | null;
      productType?: string | null;
      boxInventories?: Array<{ qty?: number | null }> | null;
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

function resolveBoxBackedStock(
  stockQty: unknown,
  boxInventories: Array<{ qty?: number | null }> | null | undefined,
): number {
  if (Array.isArray(boxInventories)) {
    return boxInventories.reduce((sum, row) => sum + toNonNegativeInteger(row?.qty), 0);
  }
  return toNonNegativeInteger(stockQty);
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
  const finishedStock = resolveBoxBackedStock(product?.stockQty, product?.boxInventories);
  if (String(product?.productType ?? '').trim() !== '肩带') {
    return { finishedStock, assemblableStock: null, fulfillableStock: finishedStock };
  }

  const bomComponents = product?.bomComponents ?? [];
  const bodyCount = bomComponents.filter(
    (item) => String(item.componentProduct?.productType ?? '').trim() === '肩带本体',
  ).length;
  const assemblableStock = bomComponents.length > 0 && bodyCount !== 1
    ? 0
    : calculateAssemblableStock(
    bomComponents.map((item) => ({
      quantity: Number(item.quantity),
      componentStockQty: resolveBoxBackedStock(
        item.componentProduct?.stockQty,
        item.componentProduct?.boxInventories,
      ),
      componentStatus: Number(item.componentProduct?.status ?? 0),
    })),
  );
  return {
    finishedStock,
    assemblableStock,
    fulfillableStock: finishedStock + (assemblableStock ?? 0),
  };
}
