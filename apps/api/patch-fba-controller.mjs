import fs from 'fs';

let c = fs.readFileSync('src/inventory/inventory.controller.ts', 'utf8');

// Revert everything to unknown globally
c = c.replace(/Promise<FbaReplenishmentResponseDto\[\]>/g, "Promise<unknown[]>");
c = c.replace(/Promise<FbaReplenishmentResponseDto>/g, "Promise<unknown>");

// Now SPECIFICALLY apply FbaReplenishmentResponseDto
c = c.replace(
  /async createFbaReplenishment\([\s\S]*?\): Promise<unknown>/m,
  (match) => match.replace("Promise<unknown>", "Promise<FbaReplenishmentResponseDto>")
);

c = c.replace(
  /async confirmFbaReplenishment\([\s\S]*?\): Promise<unknown>/m,
  (match) => match.replace("Promise<unknown>", "Promise<FbaReplenishmentResponseDto>")
);

c = c.replace(
  "async listFbaReplenishments(): Promise<unknown[]>",
  "async listFbaReplenishments(): Promise<FbaReplenishmentResponseDto[]>"
);

fs.writeFileSync('src/inventory/inventory.controller.ts', c, 'utf8');
console.log('Controller patched correctly.');
