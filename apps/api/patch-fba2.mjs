import fs from 'fs';

let code = fs.readFileSync('src/inventory/fba-replenishment.service.ts', 'utf8');

code = code.replace(
  "getBoxProductInventoryKey,\n} from './inventory.service';",
  "getBoxProductInventoryKey,\n  createMasterProductInventoryAdjustAudit,\n  createBoxInventoryAudit,\n} from './inventory.service';"
);
code = code.replace(
  "getBoxProductInventoryKey,\r\n} from './inventory.service';",
  "getBoxProductInventoryKey,\r\n  createMasterProductInventoryAdjustAudit,\r\n  createBoxInventoryAudit,\r\n} from './inventory.service';"
);

code = code.replace("APP_TIMEZONE, getZonedDateParts, parseId", "parseId");

code = code.replace(/this\.recalculateMasterProductStockQty/g, "this.inventoryService.recalculateMasterProductStockQty");

code = code.replace(
  /import { OutboundFbaReplenishmentDto } from '.\/dto\/outbound-fba-replenishment.dto';/,
  "import { OutboundFbaReplenishmentDto } from './dto/outbound-fba-replenishment.dto';\nimport { FbaReplenishmentResponseDto } from './dto/fba-replenishment-response.dto';"
);

code = code.replace(/Promise<unknown\[\]>/g, "Promise<FbaReplenishmentResponseDto[]>");
code = code.replace(/Promise<unknown>/g, "Promise<FbaReplenishmentResponseDto>");

fs.writeFileSync('src/inventory/fba-replenishment.service.ts', code, 'utf8');


let c = fs.readFileSync('src/inventory/inventory.controller.ts', 'utf8');
if (!c.includes("FbaReplenishmentResponseDto")) {
    c = c.replace(
      "import { InventoryService } from './inventory.service';",
      "import { InventoryService } from './inventory.service';\nimport { FbaReplenishmentResponseDto } from './dto/fba-replenishment-response.dto';"
    );
}
c = c.replace(/Promise<unknown\[\]>/g, "Promise<FbaReplenishmentResponseDto[]>");
c = c.replace(
  /async createFbaReplenishment([\s\S]*?): Promise<unknown>/m,
  "async createFbaReplenishment$1: Promise<FbaReplenishmentResponseDto>"
);
c = c.replace(
  /async confirmFbaReplenishment([\s\S]*?): Promise<unknown>/m,
  "async confirmFbaReplenishment$1: Promise<FbaReplenishmentResponseDto>"
);
fs.writeFileSync('src/inventory/inventory.controller.ts', c, 'utf8');

console.log('patched2');
