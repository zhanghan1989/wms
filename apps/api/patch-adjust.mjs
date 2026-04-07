import fs from 'fs';

let content = fs.readFileSync('src/inventory/inventory-adjust.service.ts', 'utf8');

// The file currently has:
// import { AuditAction, Prisma } from '@prisma/client';
// Let's add OrderStatus.
content = content.replace(
  "import { AuditAction, Prisma } from '@prisma/client';",
  "import { AuditAction, OrderStatus, Prisma } from '@prisma/client';"
);

// We need an interface
const interfaceString = `
export interface AdjustOrderResult {
  orderId: string;
  status: OrderStatus;
  idempotent: boolean;
  changedRows?: number;
  adjustNo?: string;
}
`;

// Insert after the @nestjs/common import
content = content.replace(
  "import { AuditAction, OrderStatus, Prisma } from '@prisma/client';",
  "import { AuditAction, OrderStatus, Prisma } from '@prisma/client';" + interfaceString
);

// Add the other missing imports
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

// Change `this.method` to `this.inventoryService.method`
const methodsToPrefix = [
  'ensureReferences',
  'ensureBoxesNotUnderActiveFba',
  'recalculateMasterProductStockQty',
  'inventoryKey',
  'resolveSkuForManual',
  'resolveBoxForManual'
];

methodsToPrefix.forEach(method => {
  content = content.replace(new RegExp(`this\\.${method}`, 'g'), `this.inventoryService.${method}`);
});

// Since manualAdjustByProduct was replaced by manualAdjust, line 100 has return manualAdjustByProduct.call(...)
// Which is a leftover AST issue. We should remove the wrapper `manualAdjust` entirely because our AST extracted
// BOTH `manualAdjust` and `manualAdjustByProduct`?
// Wait, looking at the view_file earlier:
// lines 95-101:
//   async manualAdjust(
//     payload: ManualAdjustDto, ...
//   ): Promise<AdjustOrderResult & { adjustNo: string }> {
//     return manualAdjustByProduct.call(this, payload, operatorId, requestId);
//   }
// AND lines 367-521 is ALSO named `manualAdjust` because `manualAdjustByProduct` lost its suffix!!!
// We have two `manualAdjust` methods. Let's remove the wrapper one.

content = content.replace(
  /[\s\S]*?async manualAdjust\([\s\S]*?return manualAdjustByProduct\.call[\s\S]*?\}/m,
  ""
);

// And the same for MoveProductBetweenBoxes ?
// Oh, `inventory.service.ts` didn't use `.call` for moveProductBetweenBoxes, it just had it natively! So moveProductBetweenBoxes is safe.

// There's a `manualAdjust(payload: ManualAdjustDto,` leftover signature missing `async` because we stripped it? Let's fix that wrapper replacement carefully.
// Actually, earlier the view_file output showed EXACTLY:
/*
  async manualAdjust(
    payload: ManualAdjustDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<AdjustOrderResult & { adjustNo: string }> {
    return manualAdjustByProduct.call(this, payload, operatorId, requestId);
  }
*/
const wrapperRegex = /async manualAdjust\(\s*payload: ManualAdjustDto,\s*operatorId: bigint,\s*requestId\?: string,?\s*\): Promise<AdjustOrderResult & \{ adjustNo: string \}> \{\s*return manualAdjustByProduct\.call\(this, payload, operatorId, requestId\);\s*\}/;

content = content.replace(wrapperRegex, "");

fs.writeFileSync('src/inventory/inventory-adjust.service.ts', content, 'utf8');

// Now, remove those methods from inventory.service.ts
let invContent = fs.readFileSync('src/inventory/inventory.service.ts', 'utf8');
const methodsToRemove = [
  'createAdjustOrder',
  'confirmAdjustOrder',
  'manualAdjust',
  'moveProductBetweenBoxes',
  'applyAdjustOrder',
  'normalizeAdjustItem',
  'manualAdjustByProduct',
  'moveProductBetweenBoxesByProduct'
];
// We already ran an AST extract, but we didn't use an AST delete on Adjust!
// Wait! `extract-adjust-ast.ts` only read the file. We need to delete them.
// Let's rely on an AST delete script like we did for FBA.
// I'll write another AST delete script next instead of regexing it here.

