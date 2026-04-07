import fs from 'fs';

let content = fs.readFileSync('src/inventory/fba-replenishment.service.ts', 'utf8');

// 1. Fix missing imports
content = content.replace(
  "getBoxProductInventoryKey,\n} from './inventory.service';",
  "getBoxProductInventoryKey,\n  createMasterProductInventoryAdjustAudit,\n  createBoxInventoryAudit,\n} from './inventory.service';"
);

// 2. Remove APP_TIMEZONE, getZonedDateParts
content = content.replace(
  "import { APP_TIMEZONE, getZonedDateParts, parseId } from '../common/utils';",
  "import { parseId } from '../common/utils';"
);

// 3. Fix recalculateMasterProductStockQty
content = content.replace(
  /this\.recalculateMasterProductStockQty/g,
  "this.inventoryService.recalculateMasterProductStockQty"
);

// 4. Import FbaReplenishmentResponseDto
content = content.replace(
  "import { OutboundFbaReplenishmentDto } from './dto/outbound-fba-replenishment.dto';",
  "import { OutboundFbaReplenishmentDto } from './dto/outbound-fba-replenishment.dto';\nimport { FbaReplenishmentResponseDto } from './dto/fba-replenishment-response.dto';"
);

// 5. Replace Promise<unknown[]> with FbaReplenishmentResponseDto[] for list
content = content.replace(
  "async listFbaReplenishments(): Promise<unknown[]>",
  "async listFbaReplenishments(): Promise<FbaReplenishmentResponseDto[]>"
);

// 6. Replace Promise<unknown> with FbaReplenishmentResponseDto for create/confirm/reopen
content = content.replace(
  "async createFbaReplenishment(payload: CreateFbaReplenishmentDto,\n  operatorId: bigint,\n  requestId?: string,\n): Promise<unknown>",
  "async createFbaReplenishment(payload: CreateFbaReplenishmentDto,\n  operatorId: bigint,\n  requestId?: string,\n): Promise<FbaReplenishmentResponseDto>"
);
content = content.replace(
  "async confirmFbaReplenishment(idParam: string,\n  payload: ConfirmFbaReplenishmentDto,\n  operatorId: bigint,\n  requestId?: string,\n): Promise<unknown>",
  "async confirmFbaReplenishment(idParam: string,\n  payload: ConfirmFbaReplenishmentDto,\n  operatorId: bigint,\n  requestId?: string,\n): Promise<FbaReplenishmentResponseDto>"
);

fs.writeFileSync('src/inventory/fba-replenishment.service.ts', content);

let controllerContent = fs.readFileSync('src/inventory/inventory.controller.ts', 'utf8');

controllerContent = controllerContent.replace(
  "import { InventoryService } from './inventory.service';",
  "import { InventoryService } from './inventory.service';\nimport { FbaReplenishmentResponseDto } from './dto/fba-replenishment-response.dto';"
);

controllerContent = controllerContent.replace(
  "async createFbaReplenishment(\n    @Body() payload: CreateFbaReplenishmentDto,\n    @CurrentUser() user: AuthUser,\n    @Req() req: { requestId?: string },\n  ): Promise<unknown>",
  "async createFbaReplenishment(\n    @Body() payload: CreateFbaReplenishmentDto,\n    @CurrentUser() user: AuthUser,\n    @Req() req: { requestId?: string },\n  ): Promise<FbaReplenishmentResponseDto>"
);

controllerContent = controllerContent.replace(
  "async confirmFbaReplenishment(\n    @Param('id') id: string,\n    @Body() payload: ConfirmFbaReplenishmentDto,\n    @CurrentUser() user: AuthUser,\n    @Req() req: { requestId?: string },\n  ): Promise<unknown>",
  "async confirmFbaReplenishment(\n    @Param('id') id: string,\n    @Body() payload: ConfirmFbaReplenishmentDto,\n    @CurrentUser() user: AuthUser,\n    @Req() req: { requestId?: string },\n  ): Promise<FbaReplenishmentResponseDto>"
);

controllerContent = controllerContent.replace(
  "async listFbaReplenishments(): Promise<unknown[]>",
  "async listFbaReplenishments(): Promise<FbaReplenishmentResponseDto[]>"
);

fs.writeFileSync('src/inventory/inventory.controller.ts', controllerContent);

console.log('Successfully patched FBA service and controller returning DTOs!');
