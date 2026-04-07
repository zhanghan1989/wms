import fs from 'fs';

// 1. Fix inventory.service.ts
let inv = fs.readFileSync('src/inventory/inventory.service.ts', 'utf8');

// Exports
const toExport = [
  'findMasterProductBoxInventoryQty',
  'upsertMasterProductBoxInventoryQty',
  'buildMasterProductBoxInventoryWhereUnique',
  'createInventoryAdjustOrderCreatedAudit',
  'createInventoryAdjustOrderConfirmedAudit',
  'createMasterProductInventoryAdjustAudit',
  'createBoxInventoryAudit',
  'findMasterProductBoxInventoryByPairs',
  'getBoxProductInventoryKey',
  'updateMasterProductBoxInventoryQty',
  'createFbaReplenishmentCreatedAudit',
  'createFbaReplenishmentInventoryAdjustAudit'
];

toExport.forEach(fn => {
  inv = inv.replace(new RegExp(`^async function ${fn}\\(`, 'm'), `export async function ${fn}(`);
  inv = inv.replace(new RegExp(`^function ${fn}\\(`, 'm'), `export function ${fn}(`);
});

// Privates to Publics
const publics = [
  'ensureReferences',
  'ensureBoxesNotUnderActiveFba',
  'inventoryKey',
  'formatDateTimeForExport',
  'formatDateForFilename'
];
publics.forEach(fn => {
  inv = inv.replace(new RegExp(`private\\s+async\\s+${fn}\\(`, 'g'), `async ${fn}(`);
  inv = inv.replace(new RegExp(`private\\s+${fn}\\(`, 'g'), `${fn}(`);
});

// Re-add ManualAdjustDto
if (!inv.includes('ManualAdjustDto')) {
  inv = "import { ManualAdjustDto } from './dto/manual-adjust.dto';\n" + inv;
}

// Remove unused declarations causing TS6133
inv = inv.replace(/import\s*\{[^}]*OrderStatus[^}]*\}\s*from\s*['"]@prisma\/client['"];?\n?/, (match) => match.replace(/\s*OrderStatus,?\s*/, ' '));
inv = inv.replace(/import\s*\{[^}]*generateOrderNo[^}]*\}\s*from\s*['"]\.\.\/common\/utils['"];?\n?/, (match) => match.replace(/\s*generateOrderNo,?\s*/, ' '));
inv = inv.replace(/import\s*\{[^}]*parseId[^}]*\}\s*from\s*['"]\.\.\/common\/utils['"];?\n?/, (match) => match.replace(/\s*parseId,?\s*/, ' '));

// Write back
fs.writeFileSync('src/inventory/inventory.service.ts', inv, 'utf8');


// 2. Fix fba-replenishment.service.ts
let fba = fs.readFileSync('src/inventory/fba-replenishment.service.ts', 'utf8');
fba = fba.replace(/\(sum, item\) =>/g, "(sum: number, item: any) =>");
fba = fba.replace(/row\.qty/g, "(row as any).qty");
fs.writeFileSync('src/inventory/fba-replenishment.service.ts', fba, 'utf8');


// 3. Fix inventory-adjust.service.ts
let adj = fs.readFileSync('src/inventory/inventory-adjust.service.ts', 'utf8');
adj = adj.replace(/import\s*\{[^}]*AuditAction[^}]*\}\s*from\s*['"]@prisma\/client['"];?\n?/, (match) => match.replace(/\s*AuditAction,?\s*/, ' '));
fs.writeFileSync('src/inventory/inventory-adjust.service.ts', adj, 'utf8');

console.log('Fixed TS errors.');
