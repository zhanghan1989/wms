import fs from 'fs';

let content = fs.readFileSync('src/inventory/inventory-adjust.service.ts', 'utf8');

content = content.replace(
  "import { AuditAction, Prisma } from '@prisma/client';",
  "import { AuditAction, OrderStatus, Prisma } from '@prisma/client';"
);

const interfaceString = `
export interface AdjustOrderResult {
  orderId: string;
  status: OrderStatus;
  idempotent: boolean;
  changedRows?: number;
  adjustNo?: string;
}
`;

content = content.replace(
  "import { AuditAction, OrderStatus, Prisma } from '@prisma/client';",
  "import { AuditAction, OrderStatus, Prisma } from '@prisma/client';" + interfaceString
);

const missingImports = `
import { CreateAdjustOrderDto, CreateAdjustOrderItemDto } from './dto/create-adjust-order.dto';
import { ManualAdjustDto } from './dto/manual-adjust.dto';
import { MoveProductBetweenBoxesDto } from './dto/move-product-between-boxes.dto';
import { generateOrderNo, parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import {
  findMasterProductBoxInventoryQty,
  upsertMasterProductBoxInventoryQty,
  buildMasterProductBoxInventoryWhereUnique,
  createInventoryAdjustOrderCreatedAudit,
  createInventoryAdjustOrderConfirmedAudit,
  createMasterProductInventoryAdjustAudit,
  createBoxInventoryAudit,
} from './inventory.service';
`;

content = content.replace(
  "// Add any further imports based on what breaks",
  missingImports
);

const methodsToPrefix = [
  'ensureReferences',
  'ensureBoxesNotUnderActiveFba',
  'recalculateMasterProductStockQty',
  'inventoryKey',
  'resolveSkuForManual',
  'resolveBoxForManual'
];

methodsToPrefix.forEach(method => {
  content = content.replace(new RegExp(`this\\.${method}\\(`, 'g'), `this.inventoryService.${method}(`);
});

// Remove wrapper `manualAdjust` that calls `manualAdjustByProduct`
// The `extract-adjust-ast.ts` copies both wrapper and the actual function!
// Wrapper:
// async manualAdjust(payload: ManualAdjustDto, operatorId: bigint, requestId?: string): Promise<AdjustOrderResult & { adjustNo: string }> { return manualAdjustByProduct.call(this, payload, operatorId, requestId); }
// Standalone: async manualAdjust( ...

const wrapperIndex = content.indexOf('return manualAdjustByProduct.call(');
if (wrapperIndex !== -1) {
    const endStr = '  }';
    let end = content.indexOf(endStr, wrapperIndex) + endStr.length;
    let start = content.lastIndexOf('  async manualAdjust(', wrapperIndex);
    if (start !== -1 && end !== -1) {
        content = content.substring(0, start) + content.substring(end);
    }
}

fs.writeFileSync('src/inventory/inventory-adjust.service.ts', content, 'utf8');
console.log('Patched safely!');
