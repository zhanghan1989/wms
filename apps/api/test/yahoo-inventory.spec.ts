import { YahooInventoryService } from '../src/yahoo-orders/yahoo-inventory.service';
import { YahooOrdersClient, YahooRequestError } from '../src/yahoo-orders/yahoo-orders.client';

const credentials = { clientId: 'client', clientSecret: 'secret', publicKey: '', keyVersion: '', accessToken: 'token' };
const target = { itemCode: '00001', subCode: '001' };
const stock = { ...target, quantity: 8, present: true, published: true, closed: false, overdraft: '1', updatedAt: null };
const signal = new AbortController().signal;
const previewId = 'a37c7794-1dea-434f-bdcc-08a12d392448';

describe('Yahoo inventory API', () => {
  it('reads Yahoo product and variant codes without dropping leading zeroes', async () => {
    const client = new YahooOrdersClient();
    const request = jest.spyOn(client as any, 'request')
      .mockResolvedValueOnce(new Response('<ResultSet><Result><ItemCode>00001</ItemCode><Display>1</Display><SubCodes><SubCode code="001"/></SubCodes></Result></ResultSet>'))
      .mockResolvedValueOnce(new Response('<ResultSet><Result><ItemCode>00001</ItemCode><SubCode>001</SubCode><Status>1</Status><IsPublished>1</IsPublished><Quantity>8</Quantity><AllowOverdraft>1</AllowOverdraft><StockClose>0</StockClose></Result></ResultSet>'));
    await expect(client.getStockProduct('shop', credentials, target.itemCode, signal)).resolves.toEqual({ subCodes: ['001'], onSale: true });
    await expect(client.getStock('shop', credentials, [target], signal)).resolves.toEqual(new Map([['00001:001', stock]]));
    expect(request.mock.calls[0][0]).toContain('getItem?seller_id=shop&item_code=00001');
  });

  it.each([200, 207])('sends an absolute quantity, preserves overselling settings, and handles HTTP %s', async (status) => {
    const client = new YahooOrdersClient();
    const request = jest.spyOn(client as any, 'request').mockResolvedValue(new Response(
      '<ResultSet><Result><ItemCode>00001</ItemCode><SubCode>001</SubCode><Quantity>0</Quantity></Result></ResultSet>', { status }));
    const update = client.setStock('shop', credentials, [{ ...target, quantity: 0, overdraft: '1' }], signal);
    if (status === 200) await expect(update).resolves.toBeUndefined();
    else await expect(update).rejects.toThrow('HTTP 207');
    const body = (request.mock.calls[0][1] as { body: URLSearchParams }).body;
    expect(Object.fromEntries(body)).toEqual({ seller_id: 'shop', item_code: '00001:001', quantity: '0', allow_overdraft: '1' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function setup({ fresh = true, untracked = false, ambiguous = false } = {}) {
  const config = { enabled: true, lockToken: 'lock', lockedUntil: new Date(Date.now() + 120000),
    lastCompleteOrdersAt: fresh ? new Date() : null, inventoryEnabled: true, inventoryFailureCount: 0,
    shop: { name: '雅虎-1号店' }, sellerId: 'shop' };
  const basePlan = { rows: [{ ...stock, productId: 'P1', safetyStock: 2, available: 6, target: 4 }], issues: [] };
  const job = {
    findFirst: jest.fn().mockResolvedValue({ id: previewId, plan: basePlan }),
    create: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    update: jest.fn().mockResolvedValue({}),
  };
  const connection = {
    count: jest.fn().mockResolvedValue(1),
    findUnique: jest.fn().mockResolvedValue(config),
    findUniqueOrThrow: jest.fn().mockResolvedValue(config),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const db = {
    yahooInventoryRun: job,
    yahooOrderConnection: connection,
    yahooInventoryMapping: { findMany: jest.fn().mockResolvedValue([{ ...target, enabled: true, source: 'manual', productId: 'P1', safetyStock: 2 }]) },
    masterProduct: { findMany: jest.fn().mockResolvedValue([{ productId: 'P1', productType: '普通' }]) },
    sku: { findMany: jest.fn().mockResolvedValue([{ sku: '001', productId: 'P1' }]) },
    manualOrderRecord: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const client = {
    getStockProduct: jest.fn().mockResolvedValue({ subCodes: ['001'], onSale: true }),
    getStock: jest.fn().mockResolvedValue(new Map([['00001:001', stock]])),
    setStock: ambiguous ? jest.fn().mockRejectedValue(new YahooRequestError('HTTP 207')) : jest.fn().mockResolvedValue(undefined),
    outstanding: jest.fn().mockResolvedValue(untracked ? { total: 1, statuses: [{ id: 'shop-1', outstanding: true }] } : { total: 0, statuses: [] }),
  };
  const stockQuantities = jest.fn().mockResolvedValue(new Map([['P1', 6]]));
  const yahoo = { withConnection: (action: (...args: any[]) => unknown) => Promise.resolve(action({ row: config, credentials, signal, token: 'lock' })) };
  const service = new YahooInventoryService(db as any, yahoo as any, client as any, { stockQuantities } as any);
  return { service, client, job, connection };
}

describe('Yahoo inventory sync', () => {
  it('can preview before order approval and rejects execution while orders are stale', async () => {
    const { service, job, client } = setup({ fresh: false });
    await expect((service as any).run('preview', '1')).resolves.toBeUndefined();
    expect(job.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'preview' }) }));
    await expect(service.execute('1', previewId)).rejects.toThrow('没有完整拉单');
    expect(client.setStock).not.toHaveBeenCalled();
  });

  it('checks for outstanding orders missing from WMS before an absolute update', async () => {
    const { service, client, job } = setup({ untracked: true });
    await expect((service as any).run('manual', '1', undefined, previewId)).rejects.toThrow('尚未进入 WMS');
    expect(client.setStock).not.toHaveBeenCalled();
    expect(job.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }));
  });

  it('writes only the approved quantity and verifies it by rereading Yahoo', async () => {
    const { service, client, job } = setup();
    client.getStock.mockResolvedValueOnce(new Map([['00001:001', stock]]))
      .mockResolvedValueOnce(new Map([['00001:001', stock]]))
      .mockResolvedValueOnce(new Map([['00001:001', { ...stock, quantity: 4 }]]));
    await expect((service as any).run('manual', '1', undefined, previewId)).resolves.toBeUndefined();
    expect(client.setStock).toHaveBeenCalledWith('shop', credentials, [expect.objectContaining({ ...target, quantity: 4, overdraft: '1' })], signal);
    expect(client.getStock).toHaveBeenCalledTimes(3);
    expect(job.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'success', result: expect.objectContaining({ verified: 1 }) }) }));
  });

  it('pauses writes after an ambiguous update response and records a review status', async () => {
    const { service, client, job, connection } = setup({ ambiguous: true });
    await expect((service as any).run('manual', '1', undefined, previewId)).rejects.toThrow('HTTP 207');
    expect(client.setStock).toHaveBeenCalledTimes(1);
    expect(job.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'needs_review' }) }));
    expect(connection.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ inventoryEnabled: false }) }));
  });
});
