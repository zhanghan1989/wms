import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const adjustMethodNames = [
  'createAdjustOrder',
  'confirmAdjustOrder',
  'manualAdjust',
  'moveProductBetweenBoxes',
  'applyAdjustOrder',
  'normalizeAdjustItem',
  'manualAdjustByProduct',
  'moveProductBetweenBoxesByProduct'
];

function extractAdjustService() {
  const inventoryServicePath = path.join(__dirname, 'src/inventory/inventory.service.ts');
  const sourceText = fs.readFileSync(inventoryServicePath, 'utf8');

  let sourceFile = ts.createSourceFile(
    'inventory.service.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true
  );

  let extractedMethods: string[] = [];
  let adjustImports: string[] = [];

  const visit = (node: ts.Node) => {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
      if (adjustMethodNames.includes(node.name.text)) {
        let methodText = node.getText(sourceFile);
        
        // If it's a standalone function, turn it into a method
        if (ts.isFunctionDeclaration(node)) {
          // Remove `export async function name(` or `async function name(`
          const newName = node.name.text.replace('ByProduct', '');
          methodText = methodText.replace(new RegExp(`(?:export\\s+)?async\\s+function\\s+${node.name.text}\\s*\\([\\s\\S]*?this:\\s*InventoryService,\\s*`), `async ${newName}(`);
          methodText = methodText.replace(new RegExp(`(?:export\\s+)?async\\s+function\\s+${node.name.text}\\s*\\(`), `async ${newName}(`);
        }

        // We need to rewrite internal this calls if they point to InventoryService
        // But since we are injecting InventoryService as this.inventoryService, we might need to be careful.
        // For now, let's just extract it verbatim except for specific replacements later.
        extractedMethods.push(methodText);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  const outPath = path.join(__dirname, 'src/inventory/inventory-adjust.service.ts');
  const resultText = `import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from './inventory.service';
// Add any further imports based on what breaks

@Injectable()
export class InventoryAdjustService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly inventoryService: InventoryService,
  ) {}

  ${extractedMethods.join('\n\n  ')}
}
`;

  fs.writeFileSync(outPath, resultText, 'utf8');
  console.log('Successfully extracted InventoryAdjustService! Extracted', extractedMethods.length, 'methods.');
}

extractAdjustService();
