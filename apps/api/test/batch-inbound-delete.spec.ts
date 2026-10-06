import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { BatchInboundService } from '../src/batch-inbound/batch-inbound.service';

const collectedOrder = {
  id: 1n, orderNo: 'BINB-20261007-1-2', status: 'waiting_upload',
  uploadedFileName: null, seaOrderNo: null, items: [], itemCount: 0,
};

describe('batch inbound deletion', () => {
  function setup(order: any = collectedOrder, deletedCount = 1) {
    const tx = { batchInboundOrder: {
      findUnique: jest.fn().mockResolvedValue(order),
      deleteMany: jest.fn().mockResolvedValue({ count: deletedCount }),
    } };
    const prisma = { $transaction: jest.fn((work) => work(tx)) };
    const audit = { create: jest.fn().mockResolvedValue(undefined) };
    return { service: new BatchInboundService(prisma as any, audit as any), tx, audit };
  }

  it('deletes a collected order and records the deletion', async () => {
    const { service, tx, audit } = setup();
    await expect(service.removeOrder('1', 2n, 'request')).resolves.toEqual({ success: true });
    expect(tx.batchInboundOrder.deleteMany).toHaveBeenCalledWith({ where: {
      id: 1n, status: 'waiting_upload', uploadedFileName: null,
      seaOrderNo: null, items: { none: {} },
    } });
    expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({
      entityId: 1n, action: 'delete', operatorId: 2n, requestId: 'request',
    }));
  });

  it.each([
    { uploadedFileName: 'inbound.xlsx' },
    { uploadedFileName: '' },
    { items: [{ id: 10n }], itemCount: 1 },
    { seaOrderNo: 'SEA123' },
    { status: 'waiting_inbound' },
    { status: 'confirmed' },
    { status: 'void' },
  ])('rejects orders beyond box collection (%#)', async (change) => {
    const { service, tx, audit } = setup({ ...collectedOrder, ...change });
    await expect(service.removeOrder('1', 2n)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(tx.batchInboundOrder.deleteMany).not.toHaveBeenCalled();
    expect(audit.create).not.toHaveBeenCalled();
  });

  it('rejects an order changed concurrently without recording a deletion', async () => {
    const { service, audit } = setup(collectedOrder, 0);
    await expect(service.removeOrder('1', 2n)).rejects.toThrow('入库单已发生变化');
    expect(audit.create).not.toHaveBeenCalled();
  });

  it('reports missing orders', async () => {
    const { service, tx } = setup(null);
    await expect(service.removeOrder('1', 2n)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.batchInboundOrder.deleteMany).not.toHaveBeenCalled();
  });
});

describe('batch inbound delete button', () => {
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('function canDeleteBatchInboundOrder(order)');
  const end = source.indexOf('\nfunction loadMoreBatchInboundOrdersIfNeeded', start);
  const tbody = { innerHTML: '' };
  const context: any = {
    $: () => tbody,
    state: { batchInboundOrders: [], batchInboundVisibleCount: 30 },
    escapeHtml: String,
    getBatchInboundStatusText: () => '',
    formatBatchRange: () => '',
    renderBatchInboundOrderNoEditor: () => '',
  };
  runInNewContext(source.slice(start, end), context);

  it.each([
    [collectedOrder, true],
    [{ ...collectedOrder, domesticOrderNo: 'DOM123' }, true],
    [{ ...collectedOrder, uploadedFileName: 'inbound.xlsx' }, false],
    [{ ...collectedOrder, uploadedFileName: '' }, false],
    [{ ...collectedOrder, itemCount: 1 }, false],
    [{ ...collectedOrder, seaOrderNo: 'SEA123' }, false],
    [{ ...collectedOrder, status: 'waiting_inbound' }, false],
    [{ ...collectedOrder, status: 'confirmed' }, false],
    [{ ...collectedOrder, status: 'void' }, false],
  ])('renders delete only for eligible orders (%#)', (order, eligible) => {
    context.state.batchInboundOrders = [order];
    context.renderBatchInboundOrders();
    expect(tbody.innerHTML.includes('data-action="batchInboundDeleteOrder"')).toBe(eligible);
    expect(tbody.innerHTML).toContain('data-action="batchInboundSelectOrder"');
  });
});
