import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const removeNodes = [
  'createFbaReplenishment',
  'confirmFbaReplenishment',
  'outboundFbaReplenishments'
];

function deleteFbaWrappers() {
  const inventoryServicePath = path.join(__dirname, 'src/inventory/inventory.service.ts');
  let sourceText = fs.readFileSync(inventoryServicePath, 'utf8');

  let sourceFile = ts.createSourceFile(
    'inventory.service.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true
  );

  let replacements: { start: number, end: number }[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      if (removeNodes.includes(node.name.text)) {
        replacements.push({ start: node.getFullStart(), end: node.getEnd() });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  replacements.sort((a, b) => b.start - a.start);

  for (const r of replacements) {
    sourceText = sourceText.substring(0, r.start) + sourceText.substring(r.end);
  }

  // Remove the remaining DTO imports if they are unused
  const unusedImports = [
    'CreateFbaReplenishmentDto',
    'ConfirmFbaReplenishmentDto',
    'OutboundFbaReplenishmentDto',
  ];
  for (const imp of unusedImports) {
    const rx = new RegExp(`import\\s+\\{[^}]*\\b${imp}\\b[^}]*\\}\\s+from\\s+['"][^'"]+['"];?\\n?`, 'g');
    sourceText = sourceText.replace(rx, '');
  }

  fs.writeFileSync(inventoryServicePath, sourceText, 'utf8');
  console.log(`Successfully removed ${replacements.length} wrapper methods from inventory.service.ts!`);
}

deleteFbaWrappers();
