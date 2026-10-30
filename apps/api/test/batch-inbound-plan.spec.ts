import * as XLSX from 'xlsx';
import { BatchInboundService } from '../src/batch-inbound/batch-inbound.service';
import { summarizeInboundPlan, validateInboundPacking } from '../src/batch-inbound/batch-inbound-plan';

function excel(rows: object[]) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Sheet1');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
const createdAt = new Date('2026-10-20T00:00:00Z');
function setup(existing = false) {
  let order: any = existing ? {
    id: 1n, orderNo: 'PRE-PO1', isPreRegistered: true, status: 'waiting_inbound',
    createdAt, updatedAt: createdAt, createdBy: 2n, collectedBoxCodes: ['001'],
    expectedBoxCount: 1, rangeStart: 1, rangeEnd: 1, domesticOrderNo: null, seaOrderNo: 'SEA1',
    uploadedFileName: 'boxes.xlsx', creator: { id: 2n, username: 'user' },
    plannedItems: [{ productId: 'P1', qty: 60 }],
    items: [{ id: 10n, productId: 'P1', qty: 20, boxCode: '001', status: 'confirmed' }],
  } : null;
  const audit = { create: jest.fn() };
  const tx: any = {
    $queryRaw: jest.fn().mockImplementation(() => Promise.resolve(order ? [{ id: order.id }] : [])),
    masterProduct: { findMany: jest.fn().mockResolvedValue([{ productId: 'P1', productName: '产品' }]) },
    box: { findMany: jest.fn().mockResolvedValue([{ boxCode: '001' }]) },
    masterProductBoxInventory: { upsert: jest.fn(), updateMany: jest.fn() },
    batchInboundOrder: {
      findUnique: jest.fn().mockImplementation(() => Promise.resolve(order)),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: any) => {
        order = { ...data, id: 1n, createdAt, updatedAt: createdAt, creator: { id: 2n, username: 'user' },
          items: [], plannedItems: data.plannedItems.create };
        return Promise.resolve(order);
      }),
      update: jest.fn().mockImplementation(({ data }: any) => {
        const plannedItems = data.plannedItems?.create ?? order.plannedItems;
        order = { ...order, ...data, plannedItems };
        return Promise.resolve(order);
      }),
    },
    batchInboundItem: {
      deleteMany: jest.fn().mockImplementation(() => { order.items = order.items.filter((item: any) => item.status === 'confirmed'); }),
      createMany: jest.fn().mockImplementation(({ data }: any) => { order.items.push(...data.map((item: any, i: number) => ({ ...item, id: BigInt(20 + i) }))); }),
    },
  };
  const prisma = { ...tx, $transaction: jest.fn((work) => work(tx)) };
  return { service: new BatchInboundService(prisma as any, audit as any), tx, audit, order: () => order };
}

describe('pre-registration quantities', () => {
  it('counts 60 units once before packing, after packing and after partial receipt', () => {
    const plans = [{ productId: 'P1', qty: 60 }];
    expect(summarizeInboundPlan(plans, [])[0]).toMatchObject({ unpackedQty: 60, inTransitQty: 60 });
    const boxes = ['001', '002', '003'].map((boxCode) => ({ productId: 'P1', qty: 20, boxCode, status: 'pending' }));
    expect(summarizeInboundPlan(plans, boxes)[0]).toMatchObject({ unpackedQty: 0, inTransitQty: 60 });
    boxes[0].status = 'confirmed';
    expect(summarizeInboundPlan(plans, boxes)[0]).toMatchObject({ confirmedQty: 20, inTransitQty: 40 });
  });

  it('rejects overpacking and changes to received rows', () => {
    const plan = [{ productId: 'P1', qty: 60 }];
    const received = [{ productId: 'P1', qty: 20, boxCode: '001', status: 'confirmed' }];
    expect(() => validateInboundPacking(plan, received, [{ ...received[0], qty: 61 }])).toThrow('超过预登记');
    expect(() => validateInboundPacking(plan, received, [])).toThrow('不能修改或省略');
    expect(() => validateInboundPacking(plan, received, [{ ...received[0], qty: 10 }])).toThrow('不能修改或省略');
    expect(() => validateInboundPacking(plan, received, [...received, { productId: 'P2', qty: 1, boxCode: '002' }])).toThrow('超过预登记');
  });

  it('creates a plan without boxes, domestic tracking or stock changes', async () => {
    const { service, tx } = setup();
    const result = await service.preregister('PO1', excel([{ '产品ID': 'P1', '数量': 60 }]), 2n);
    expect(result).toMatchObject({ orderNo: 'PRE-PO1', isPreRegistered: true, collectedBoxCodes: [], defaultExpectedArrivalDate: '2026-12-04' });
    expect(result.plannedItems[0]).toMatchObject({ qty: 60, unpackedQty: 60, inTransitQty: 60 });
    expect(tx.batchInboundItem.createMany).not.toHaveBeenCalled();
    expect(tx.masterProductBoxInventory.upsert).not.toHaveBeenCalled();
  });

  it('updates packing on the same order, keeps received rows and does not double count on retry', async () => {
    const { service, tx } = setup(true);
    const file = excel(['001', '002', '003'].map((box) => ({ '产品ID': 'P1', '数量': 20, '箱号': box })));
    const first = await service.upload('1', file, 'boxes.xlsx', 2n);
    expect(first.items).toHaveLength(3);
    expect(first.items.find((item) => item.id === '10')?.status).toBe('confirmed');
    expect(first.plannedItems[0]).toMatchObject({ inTransitQty: 40, confirmedQty: 20, unpackedQty: 0 });
    const retry = await service.upload('1', file, 'boxes.xlsx', 2n);
    expect(retry.items).toHaveLength(3);
    expect(retry.plannedItems[0].inTransitQty).toBe(40);
    expect(retry.createdAt).toEqual(createdAt);
    expect(tx.masterProductBoxInventory.upsert).not.toHaveBeenCalled();
  });

  it('retains unpacked quantities when only part of the batch is packed', async () => {
    const { service } = setup(true);
    const result = await service.upload('1', excel([{ '产品ID': 'P1', '数量': 20, '箱号': '001' }]), 'part.xlsx', 2n);
    expect(result.plannedItems[0]).toMatchObject({ unpackedQty: 40, inTransitQty: 40 });
  });

  it('blocks stale plan updates and reductions below boxed quantities', async () => {
    const { service, tx } = setup(true);
    await expect(service.preregister('', excel([{ '产品ID': 'P1', '数量': 60 }]), 2n, undefined, '1', 'old')).rejects.toThrow('请重新预览');
    await expect(service.preregister('', excel([{ '产品ID': 'P1', '数量': 10 }]), 2n, undefined, '1', createdAt.toISOString())).rejects.toThrow('不能少于已装箱');
    expect(tx.batchInboundOrder.update).not.toHaveBeenCalled();
  });

  it('preserves registration date when quantities are explicitly updated', async () => {
    const { service } = setup(true);
    const result = await service.preregister('', excel([{ '产品ID': 'P1', '数量': 80 }]), 2n, undefined, '1', createdAt.toISOString());
    expect(result.createdAt).toEqual(createdAt);
    expect(result.defaultExpectedArrivalDate).toBe('2026-12-04');
    expect(result.plannedItems[0].inTransitQty).toBe(60);
  });

  it('does not finish a batch while 40 units are still unpacked', async () => {
    const { service, tx, order } = setup(true);
    tx.batchInboundItem.count = jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    tx.batchInboundItem.findMany = jest.fn().mockImplementation(() => Promise.resolve(order().items));
    tx.batchInboundPlannedItem = { findMany: jest.fn().mockResolvedValue([{ productId: 'P1', qty: 60 }]) };
    expect(await (service as any).syncOrderStatus(tx, 1n, 2n)).toBe('waiting_inbound');
    expect(tx.batchInboundOrder.update).not.toHaveBeenCalled();
  });

  it('rejects box numbers belonging to another active batch without replacing any rows', async () => {
    const { service, tx } = setup(true);
    tx.batchInboundOrder.findMany.mockResolvedValue([{ collectedBoxCodes: ['002'] }]);
    await expect(service.upload('1', excel([
      { '产品ID': 'P1', '数量': 20, '箱号': '001' }, { '产品ID': 'P1', '数量': 40, '箱号': '002' },
    ]), 'boxes.xlsx', 2n)).rejects.toThrow('已被其他入库单');
    expect(tx.batchInboundItem.deleteMany).not.toHaveBeenCalled();
  });

  it('cancels remaining transit without changing received inventory', async () => {
    const { service, tx } = setup(true);
    const result = await service.cancelPlan('1', 2n);
    expect(result.status).toBe('void');
    expect(result.items[0].status).toBe('confirmed');
    expect(tx.batchInboundItem.deleteMany).not.toHaveBeenCalled();
    expect(tx.masterProductBoxInventory.updateMany).not.toHaveBeenCalled();
  });

  it('moves only unpacked quantities to a new order and keeps received boxes', async () => {
    const { service, tx, audit } = setup(true);
    tx.batchInboundOrder.findUnique.mockImplementation(({ where }: any) => Promise.resolve(where.id ? {
      id: 1n, orderNo: 'PRE-PO1', isPreRegistered: true, status: 'waiting_inbound',
      plannedItems: [{ productId: 'P1', qty: 60 }],
      items: [{ id: 10n, productId: 'P1', qty: 20, boxCode: '001', status: 'confirmed' }],
    } : null));
    const result = await service.transferUnpacked('1', 2n);
    expect(result.orderNo).toBe('PRE-PO1-NEXT-1');
    expect(result.plannedItems[0]).toMatchObject({ qty: 40, inTransitQty: 40 });
    expect(tx.batchInboundOrder.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: 'confirmed', plannedItems: { deleteMany: {}, create: [{ productId: 'P1', qty: 20 }] },
    }) }));
    expect(tx.batchInboundItem.deleteMany).not.toHaveBeenCalled();
    expect(audit.create).toHaveBeenCalledTimes(2);
  });

  it('updates the order number and records both values without changing boxes', async () => {
    const { service, tx, audit } = setup(true);
    const result = await service.updateOrderNo('1', '  PRE-PO2  ', 2n);
    expect(result.orderNo).toBe('PRE-PO2');
    expect(result.items[0].boxCode).toBe('001');
    expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({ beforeData: { orderNo: 'PRE-PO1' }, afterData: { orderNo: 'PRE-PO2' } }));
    expect(tx.batchInboundItem.deleteMany).not.toHaveBeenCalled();
    await expect(service.updateOrderNo('1', '   ', 2n)).rejects.toThrow('不能为空');
  });
});
