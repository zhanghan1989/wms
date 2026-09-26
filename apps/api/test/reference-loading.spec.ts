import { BoxesService } from '../src/boxes/boxes.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

describe('lightweight reference loading', () => {
  it('loads box options without inventory and history aggregation', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 1n, boxCode: '001' }]);
    const service = new BoxesService({ box: { findMany } } as never, {} as never);
    await expect(service.listOptions('001')).resolves.toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 1, boxCode: { contains: '001' } },
      select: expect.objectContaining({ boxCode: true, shelfId: true }),
    }));
  });

  it('counts all pending records while respecting confirmed quantities and zero quantity', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { skuId: 1n, boxId: 2n, status: 'pending_confirm', requestedQty: 10, actualQty: null },
      { skuId: 1n, boxId: 2n, status: 'pending_outbound', requestedQty: 10, actualQty: 4 },
      { skuId: 3n, boxId: 2n, status: 'pending_outbound', requestedQty: 8, actualQty: null },
      { skuId: 1n, boxId: 2n, status: 'pending_outbound', requestedQty: 5, actualQty: 0 },
    ]);
    const service = new InventoryService({ fbaReplenishment: { findMany } } as never, {} as never);
    await expect(service.getFbaPendingSummary()).resolves.toEqual({
      pendingConfirmCount: 4, pendingBySku: { '1': 14, '3': 8 },
      pendingByBoxSku: { '2-1': 14, '2-3': 8 },
    });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('shares overlapping requests and retries after a failure', async () => {
    const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
    const snippet = source.slice(source.indexOf('const sharedReferenceRequests'), source.indexOf('async function loadInventory({'));
    let reject!: (error: Error) => void;
    const request = jest.fn().mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const context: any = { state: { token: 'session' }, request };
    runInNewContext(snippet, context);
    const first = context.loadReferenceData('/skus');
    expect(context.loadReferenceData('/skus')).toBe(first);
    expect(request).toHaveBeenCalledTimes(1);
    reject(new Error('offline'));
    await expect(first).rejects.toThrow('offline');
    context.loadReferenceData('/skus').catch(() => {});
    expect(request).toHaveBeenCalledTimes(2);
    reject(new Error('offline'));
  });
});
