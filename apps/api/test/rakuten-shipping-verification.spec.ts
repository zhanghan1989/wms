import { RakutenRmsAutomationService } from '../src/rakuten-rms-api/rakuten-rms-automation.service';
import { shippingFingerprint, VERIFIED_SHIPPING } from '../src/rakuten-rms-api/rakuten-order-workflow';
import { RakutenOrderRecord } from '@prisma/client';

const date = new Date('2026-10-11T00:00:00Z');
const setup = (status = 'sent') => {
  const rows = ['471', '482'].map((number, index) => ({
    id: BigInt(index + 1), orderId: index ? 'ORDERa' : 'ORDER', rmsOrderId: 'ORDER',
    dispatchMode: 'china_no_stock', shipmentNo: number, shipmentCompany: 'Xiya-SAGAWA',
    shipmentNoRegisteredAt: date, trackingHasCustomsClearance: true, trackingCustomsClearanceDate: date,
    rawPayload: { rmsPackage: { basketId: 42 } },
  } as unknown as RakutenOrderRecord));
  const report = { id: 84n, connectionId: 7n, orderId: 'ORDER', status, updatedAt: date,
    fulfillmentType: 'china', fingerprint: shippingFingerprint([rows[0]]), reportedAt: date,
    lastError: status === 'skipped' ? '用户人工忽略单号回传' : null,
    responsePayload: { originalResponse: true }, connection: { id: 7n },
  };
  const live = { orderNumber: 'ORDER', orderProgress: 500, PackageModelList: [{ basketId: 42,
    ShippingModelList: ['471', '482'].map(shippingNumber => ({ shippingNumber, deliveryCompany: '1002', shippingDate: '2026-10-11' })),
  }] };
  const tx = { $queryRaw: jest.fn().mockResolvedValue([]),
    rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows) },
    rakutenOrderShippingReport: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = { rakutenOrderShippingReport: { findUnique: jest.fn().mockResolvedValue(report) },
    rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows) },
    rakutenRmsConnection: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    rakutenOrderMail: { create: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn().mockImplementation(fn => fn(tx)),
  };
  const client = { getOrders: jest.fn().mockResolvedValue([live]), updateOrderShipping: jest.fn() };
  const audit = { create: jest.fn().mockResolvedValue(undefined) };
  const service = new RakutenRmsAutomationService(prisma as any, client as any, {} as any, audit as any);
  jest.spyOn(service as any, 'decryptApiCredentials').mockReturnValue({ serviceSecret: 'test', licenseKey: 'test' });
  jest.spyOn(service as any, 'isAutomationEligibleOrder').mockResolvedValue(true);
  return { rows, report, live, tx, prisma, client, audit, service };
};

describe('human verification of completed shipping', () => {
  it.each(['sent', 'skipped'])('verifies all split parcels while preserving a %s historical result', async status => {
    const { service, report, rows, tx, audit, client, prisma } = setup(status);
    await expect(service.verifyCompletedShippingReport('84', 9n)).resolves.toEqual({ verified: true });
    expect(client.getOrders).toHaveBeenCalledWith('test', 'test', ['ORDER']);
    expect(tx.rakutenOrderShippingReport.updateMany).toHaveBeenCalledWith({
      where: { id: 84n, status, fingerprint: report.fingerprint, updatedAt: date },
      data: expect.objectContaining({ fingerprint: shippingFingerprint(rows),
        lastError: status === 'skipped' ? VERIFIED_SHIPPING : null,
        responsePayload: expect.objectContaining({ originalResponse: true,
          wmsManualShippingVerification: expect.objectContaining({ verifiedBy: '9', baskets: expect.any(Array) }),
        }),
      }),
    });
    const data = tx.rakutenOrderShippingReport.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('reportedAt');
    expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({ db: tx, eventType: 'rakuten_shipping_ignored',
      beforeData: expect.objectContaining({ fingerprint: report.fingerprint }),
      afterData: expect.objectContaining({ fingerprint: shippingFingerprint(rows) }),
    }));
    expect(client.updateOrderShipping).not.toHaveBeenCalled();
    expect(prisma.rakutenOrderMail.create).not.toHaveBeenCalled();
    expect(prisma.rakutenOrderMail.updateMany).not.toHaveBeenCalled();
  });
  it.each(['missing', 'company', 'date', 'deleted', 'basket'])('rejects an external %s discrepancy without dismissing the alert', async field => {
    const { service, live, tx, audit, prisma } = setup();
    if (field === 'missing') live.PackageModelList[0].ShippingModelList.pop();
    if (field === 'company') live.PackageModelList[0].ShippingModelList[1].deliveryCompany = '1001';
    if (field === 'date') live.PackageModelList[0].ShippingModelList[1].shippingDate = '2026-10-12';
    if (field === 'deleted') Object.assign(live.PackageModelList[0].ShippingModelList[1], { shippingDeleteFlag: 1 });
    if (field === 'basket') live.PackageModelList[0].basketId = 99;
    await expect(service.verifyCompletedShippingReport('84', 9n)).rejects.toThrow('不能忽略提醒');
    expect(tx.rakutenOrderShippingReport.updateMany).not.toHaveBeenCalled();
    expect(audit.create).not.toHaveBeenCalled();
    expect(prisma.rakutenRmsConnection.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { automationLockToken: null, automationLockedAt: null },
    }));
  });
  it.each(['wrong-order', 'cancelled', 'unknown'])('rejects an external %s order', async condition => {
    const { service, live, tx } = setup();
    if (condition === 'wrong-order') live.orderNumber = 'OTHER';
    if (condition === 'cancelled') live.orderProgress = 900;
    if (condition === 'unknown') live.orderProgress = 999;
    await expect(service.verifyCompletedShippingReport('84', 9n)).rejects.toThrow('无法核实');
    expect(tx.rakutenOrderShippingReport.updateMany).not.toHaveBeenCalled();
  });
  it('rejects incomplete local parcels, concurrent order edits, and report changes', async () => {
    const incomplete = setup();
    incomplete.rows[1].trackingCustomsClearanceDate = null;
    await expect(incomplete.service.verifyCompletedShippingReport('84', 9n)).rejects.toThrow('不完整');
    expect(incomplete.client.getOrders).not.toHaveBeenCalled();
    const edited = setup();
    edited.tx.rakutenOrderRecord.findMany.mockResolvedValue(edited.rows.map(row => ({ ...row, shipmentNo: 'CHANGED' })));
    await expect(edited.service.verifyCompletedShippingReport('84', 9n)).rejects.toThrow('核实期间包裹信息已变化');
    expect(edited.tx.rakutenOrderShippingReport.updateMany).not.toHaveBeenCalled();
    const changed = setup();
    changed.tx.rakutenOrderShippingReport.updateMany.mockResolvedValue({ count: 0 });
    await expect(changed.service.verifyCompletedShippingReport('84', 9n)).rejects.toThrow('回传记录已变化');
    expect(changed.audit.create).not.toHaveBeenCalled();
  });
  it('rejects executing tasks and a busy connection, and releases the lock on lookup failure', async () => {
    const pending = setup('pending');
    await expect(pending.service.verifyCompletedShippingReport('84', 9n)).rejects.toThrow('只有已完成或已跳过');
    expect(pending.client.getOrders).not.toHaveBeenCalled();
    const busy = setup();
    busy.prisma.rakutenRmsConnection.updateMany.mockResolvedValue({ count: 0 });
    await expect(busy.service.verifyCompletedShippingReport('84', 9n)).rejects.toThrow('店铺正在处理任务');
    const offline = setup();
    offline.client.getOrders.mockRejectedValue(new Error('temporary network failure'));
    await expect(offline.service.verifyCompletedShippingReport('84', 9n)).rejects.toThrow('temporary network failure');
    expect(offline.tx.rakutenOrderShippingReport.updateMany).not.toHaveBeenCalled();
    expect(offline.prisma.rakutenRmsConnection.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { automationLockToken: null, automationLockedAt: null },
    }));
  });
});
