const fs = require('fs');
let c = fs.readFileSync('src/inventory/inventory.service.ts', 'utf8');
c = c.split('\n').filter(l => 
  !l.includes('FBA_REPLENISH_MARK') && 
  !l.includes('createFbaReplenishmentByProduct') && 
  !l.includes('confirmFbaReplenishmentByProduct') && 
  !l.includes('outboundFbaReplenishmentsByProduct')
).join('\n');
fs.writeFileSync('src/inventory/inventory.service.ts', c);
console.log('Cleanup FBA strings done.');
