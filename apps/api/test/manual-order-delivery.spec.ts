import * as XLSX from 'xlsx';
import { OrdersService } from '../src/orders/orders.service';

const order = { orderId: 'MANUAL-1', productId: 'P1', quantityPurchased: 1 };
const delivery = { deliveryDateRaw: '2026-12-03', deliveryTimeSlot: '0812' };

function setup() {
  const manualOrderRecord = {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue({ id: 1n, ...order, ...delivery }),
    create: jest.fn(async ({ data }) => ({ id: 1n, ...data })),
    update: jest.fn(async ({ data }) => ({ id: 1n, ...data })),
  };
  const tx = {
    manualOrderRecord,
    masterProduct: {
      findUnique: jest.fn().mockResolvedValue({ productName: 'Product' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const prisma = { ...tx, $transaction: jest.fn((work) => work(tx)) };
  const service = new OrdersService(prisma as any);
  const internals = service as any;
  jest.spyOn(internals, 'resolveDispatchModeForProductId').mockResolvedValue('overseas');
  jest.spyOn(internals, 'syncManualOrdersToXyjgBestEffort').mockResolvedValue(undefined);
  jest.spyOn(internals, 'enrichManualOrderRows').mockImplementation(async (rows) => rows);
  jest.spyOn(internals, 'assertEditableOrderNotInActiveOverseasPickingBatch').mockResolvedValue(undefined);
  jest.spyOn(internals, 'assertEditedOrderIdentityDoesNotConflict').mockResolvedValue(undefined);
  return { service, internals, manualOrderRecord };
}

describe('manual order delivery schedule', () => {
  it('stores and returns an optional delivery date and time slot', async () => {
    const { service } = setup();
    await expect(service.createAmazonManualOrder({ ...order, ...delivery })).resolves.toMatchObject(delivery);
    await expect(service.createAmazonManualOrder(order)).resolves.toMatchObject({
      deliveryDateRaw: null,
      deliveryTimeSlot: null,
    });
  });

  it.each([
    [{ deliveryDateRaw: '2026-02-30' }, '配送日期'],
    [{ deliveryTimeSlot: '1214' }, '配送时段'],
  ])('rejects invalid delivery options: %j', async (options, field) => {
    const { service, manualOrderRecord } = setup();
    await expect(service.createAmazonManualOrder({ ...order, ...options })).rejects.toThrow(field);
    expect(manualOrderRecord.create).not.toHaveBeenCalled();
  });

  it('keeps omitted fields on update and lets the form explicitly clear them', async () => {
    const { service, manualOrderRecord } = setup();
    await service.updateManualOrder('1', { ...order, deliveryTimeSlot: '1921' });
    expect(manualOrderRecord.update.mock.calls[0][0].data).toMatchObject({
      deliveryDateRaw: undefined,
      deliveryTimeSlot: '1921',
    });
    await service.updateManualOrder('1', { ...order, deliveryDateRaw: '', deliveryTimeSlot: '' });
    expect(manualOrderRecord.update.mock.calls[1][0].data).toMatchObject({
      deliveryDateRaw: null,
      deliveryTimeSlot: null,
    });
  });

  it('imports an Excel date and a numeric morning slot code', async () => {
    const { service, manualOrderRecord } = setup();
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([
      ['订单号', '产品ID', '数量', '配送日期', '配送时段'],
      ['MANUAL-1', 'P1', 1, new Date(2026, 11, 3), 812],
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, '手动订单');
    await service.importAmazonManualOrdersFile(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    expect(manualOrderRecord.create.mock.calls[0][0].data).toMatchObject(delivery);
  });

  it('exports the saved schedule to Yamato and Xiya', async () => {
    const { internals, manualOrderRecord } = setup();
    const now = new Date();
    const row = { id: 1n, ...order, ...delivery, csvImportedAt: now, createdAt: now, updatedAt: now };
    manualOrderRecord.findMany.mockResolvedValue([
      row,
      { ...row, id: 2n, deliveryDateRaw: null, deliveryTimeSlot: null },
    ]);
    const items = await internals.buildYamatoExportItemsFromPickingBatchItems([2n, 1n].map((sourceRecordId) => ({
      source: 'manual', sourceRecordId, productId: 'P1', actualQty: 1,
    })));
    expect(internals.mergeYamatoExportItems(items)).toMatchObject([
      { orderId: 'MANUAL-1', deliveryDate: '2026/12/03', deliveryTimeSlot: '0812' },
    ]);
    expect(internals.toManualThirdPartyRow(row)).toMatchObject({
      お届け指定日: '2026-12-03',
      お届け指定時間帯: '0812',
    });
  });
});
