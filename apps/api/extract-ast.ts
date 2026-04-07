import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

const inventoryServicePath = path.join(__dirname, 'src/inventory/inventory.service.ts');
const sourceFile = ts.createSourceFile(
  'inventory.service.ts',
  fs.readFileSync(inventoryServicePath, 'utf8'),
  ts.ScriptTarget.Latest,
  true
);

const fbaClassMethods = [
  'deleteFbaReplenishment',
  'reopenFbaReplenishment',
  'listFbaReplenishments',
  'getFbaPendingSummary',
  'buildFbaOutboundExcel'
];

const fbaStandaloneFuncs = [
  'createFbaReplenishmentByProduct',
  'confirmFbaReplenishmentByProduct',
  'outboundFbaReplenishmentsByProduct'
];

let generatedMethods = '';

function collectNodeText(node: ts.Node) {
  return node.getFullText(sourceFile);
}

function processClassMethods(node: ts.Node) {
  if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
    if (fbaClassMethods.includes(node.name.text)) {
      let text = collectNodeText(node);
      generatedMethods += text + '\n\n';
    }
  }
}

function processStandaloneFuncs(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name) {
    if (fbaStandaloneFuncs.includes(node.name.text)) {
      let text = collectNodeText(node);
      // Remove 'async function xxxByProduct(this: InventoryService, ' with 'async xxx('
      const newName = node.name.text.replace('ByProduct', '');
      text = text.replace(new RegExp(`async function ${node.name.text}\\([\\s\\S]*?this:\\s*InventoryService,\\s*`), `async ${newName}(`);
      // If there's no parameters after 'this: InventoryService', it would be 'this: InventoryService)' 
      text = text.replace(new RegExp(`async function ${node.name.text}\\([\\s\\S]*?this:\\s*InventoryService\\)`), `async ${newName}()`);
      generatedMethods += text + '\n\n';
    }
  }
}

function visit(node: ts.Node) {
  if (ts.isClassDeclaration(node) && node.name?.text === 'InventoryService') {
    ts.forEachChild(node, processClassMethods);
  } else {
    processStandaloneFuncs(node);
    ts.forEachChild(node, visit);
  }
}

visit(sourceFile);

generatedMethods = generatedMethods
  .replace(/this\.getFbaStatusLabel/g, 'this.inventoryService.getFbaStatusLabel')
  .replace(/this\.getActiveFbaReservedQty/g, 'this.inventoryService.getActiveFbaReservedQty')
  .replace(/this\.ensureBoxesNotUnderActiveFba/g, 'this.inventoryService.ensureBoxesNotUnderActiveFba')
  .replace(/this\.formatDateForFilename/g, 'this.inventoryService.formatDateForFilename')
  .replace(/this\.formatDateTimeForExport/g, 'this.inventoryService.formatDateTimeForExport')
  .replace(/this\.ensureSkusNotUnderPendingEdit/g, 'this.inventoryService.ensureSkusNotUnderPendingEdit')
  .replace(/this\.findBoxByEquivalentCode/g, 'this.inventoryService.findBoxByEquivalentCode')
  .replace(/this\.generateFbaRequestNo/g, 'this.inventoryService.generateFbaRequestNo')
  .replace(/this\.formatFbaRequestNo/g, 'this.inventoryService.formatFbaRequestNo');

const fbaContent = `import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeBoxCode } from '../common/box-code';
import { APP_TIMEZONE, getZonedDateParts, parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { ConfirmFbaReplenishmentDto } from './dto/confirm-fba-replenishment.dto';
import { CreateFbaReplenishmentDto } from './dto/create-fba-replenishment.dto';
import { OutboundFbaReplenishmentDto } from './dto/outbound-fba-replenishment.dto';
import {
  InventoryService,
  findMasterProductBoxInventoryQty,
  updateMasterProductBoxInventoryQty,
  createFbaReplenishmentCreatedAudit,
  createFbaReplenishmentInventoryAdjustAudit,
  findMasterProductBoxInventoryByPairs,
  getBoxProductInventoryKey,
} from './inventory.service';

const FBA_REPLENISH_MARK = 'FBA补货';

@Injectable()
export class FbaReplenishmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly inventoryService: InventoryService,
  ) {}

${generatedMethods}
}
`;

const fbaServicePath = path.join(__dirname, 'src/inventory/fba-replenishment.service.ts');
fs.writeFileSync(fbaServicePath, fbaContent, 'utf8');
console.log('Successfully extracted FbaReplenishmentService!');
