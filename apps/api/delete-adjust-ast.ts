import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const removeNodes = [
  'createAdjustOrder',
  'confirmAdjustOrder',
  'manualAdjust',
  'moveProductBetweenBoxes',
  'applyAdjustOrder',
  'normalizeAdjustItem',
  'manualAdjustByProduct',
  'moveProductBetweenBoxesByProduct'
];

function deleteAdjustMethods() {
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
    } else if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
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

  // Also remove AdjustOrderResult interface from top if we can
  sourceText = sourceText.replace(/interface AdjustOrderResult\s*\{[\s\S]*?\}/, "");

  fs.writeFileSync(inventoryServicePath, sourceText, 'utf8');
  console.log(`Successfully removed ${replacements.length} Adjust methods from inventory.service.ts!`);
}

deleteAdjustMethods();
