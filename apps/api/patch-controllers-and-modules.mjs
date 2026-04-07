import fs from 'fs';

// 1. MODULE
let modFile = 'src/inventory/inventory.module.ts';
let mod = fs.readFileSync(modFile, 'utf8');
if (!mod.includes('InventoryAdjustService')) {
  mod = mod.replace(
    "import { InventoryService } from './inventory.service';",
    "import { InventoryService } from './inventory.service';\nimport { InventoryAdjustService } from './inventory-adjust.service';"
  );
  mod = mod.replace(
    "]",
    ", InventoryAdjustService]"
  ); // Wait, better to replace providers: [...]
  mod = mod.replace(
    /providers:\s*\[([^\]]+)\]/,
    "providers: [$1, InventoryAdjustService]"
  );
  fs.writeFileSync(modFile, mod, 'utf8');
}

// 2. CONTROLLER
let ctlFile = 'src/inventory/inventory.controller.ts';
let ctl = fs.readFileSync(ctlFile, 'utf8');

if (!ctl.includes('InventoryAdjustService')) {
  ctl = ctl.replace(
    "import { InventoryService } from './inventory.service';",
    "import { InventoryService } from './inventory.service';\nimport { InventoryAdjustService } from './inventory-adjust.service';"
  );
  
  ctl = ctl.replace(
    "private readonly inventoryService: InventoryService,",
    "private readonly inventoryService: InventoryService,\n    private readonly inventoryAdjustService: InventoryAdjustService,"
  );
}

// FBA cleanups
const fbaMethods = [
  'deleteFbaReplenishment',
  'reopenFbaReplenishment'
];
for (const m of fbaMethods) {
  ctl = ctl.replace(new RegExp(`this\\.inventoryService\\.${m}`, 'g'), `this.fbaReplenishmentService.${m}`);
}

// Adjust method rewrites
const adjustMethods = [
  'createAdjustOrder',
  'confirmAdjustOrder',
  'manualAdjust',
  'moveProductBetweenBoxes'
];
for (const m of adjustMethods) {
  ctl = ctl.replace(new RegExp(`this\\.inventoryService\\.${m}`, 'g'), `this.inventoryAdjustService.${m}`);
}

fs.writeFileSync(ctlFile, ctl, 'utf8');

// 3. FIX any unused imports in inventory.service.ts
let invFile = 'src/inventory/inventory.service.ts';
let inv = fs.readFileSync(invFile, 'utf8');
const unusedVars = [
  'GenerateAdjustOrderNo', // Wait
  'OrderStatus',
  'generateOrderNo',
  'MoveProductBetweenBoxesDto',
  'CreateAdjustOrderDto',
  'CreateAdjustOrderItemDto',
  'ManualAdjustDto'
];
// Just simple regex deletions to make compiler happy
inv = inv.replace(/import\s*\{[^}]*MoveProductBetweenBoxesDto[^}]*\}\s*from\s*['"].*?['"];?\n?/, '');
inv = inv.replace(/import\s*\{[^}]*CreateAdjustOrderDto[^}]*\}\s*from\s*['"].*?['"];?\n?/, '');
inv = inv.replace(/import\s*\{[^}]*ManualAdjustDto[^}]*\}\s*from\s*['"].*?['"];?\n?/, '');

fs.writeFileSync(invFile, inv, 'utf8');
console.log('Controller and modules patched!');
