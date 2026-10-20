import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BatchInboundService } from '../src/batch-inbound/batch-inbound.service';

function setup(status = 'waiting_inbound', missing = false) {
  const order = {
    id: 1n, orderNo: 'BINB-1', status, expectedArrivalDate: null,
    expectedBoxCount: 0, rangeStart: 1, rangeEnd: 1, collectedBoxCodes: ["1"],
    uploadedFileName: null, createdAt: new Date(), updatedAt: new Date(),
    creator: { id: 2n, username: 'user' }, items: [],
  };
  const tx = { batchInboundOrder: {
    findUnique: jest.fn().mockResolvedValue(missing ? null : order),
    update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...order, ...data })),
  } };
  const prisma = { $transaction: jest.fn((work) => work(tx)) };
  const audit = { create: jest.fn().mockResolvedValue(undefined) };
  return { service: new BatchInboundService(prisma as any, audit as any), tx, audit };
}

describe('batch inbound expected arrival date', () => {
  it.each(['2026-10-31', ''])('saves or clears the calendar date (%s) with an audit record', async (date) => {
    const { service, tx, audit } = setup();
    const result = await service.updateExpectedArrivalDate('1', date, 2n, 'request');
    expect(result.expectedArrivalDate).toBe(date || null);
    expect(tx.batchInboundOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { expectedArrivalDate: date ? new Date(`${date}T00:00:00.000Z`) : null },
    }));
    expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({
      entityId: 1n, operatorId: 2n, requestId: 'request',
    }));
  });

  it.each(['2026-02-30', 'invalid'])('rejects invalid dates (%s)', async (date) => {
    const { service, tx } = setup();
    await expect(service.updateExpectedArrivalDate('1', date, 2n)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.batchInboundOrder.update).not.toHaveBeenCalled();
  });

  it.each(['confirmed', 'void'])('rejects %s orders', async (status) => {
    const { service, tx } = setup(status);
    await expect(service.updateExpectedArrivalDate('1', '2026-10-31', 2n)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(tx.batchInboundOrder.update).not.toHaveBeenCalled();
  });

  it('reports missing orders', async () => {
    const { service } = setup('waiting_inbound', true);
    await expect(service.updateExpectedArrivalDate('1', '', 2n)).rejects.toBeInstanceOf(NotFoundException);
  });
});
