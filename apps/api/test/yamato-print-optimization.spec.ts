import { Reflector } from '@nestjs/core';
import { OrdersController } from '../src/orders/orders.controller';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { OrdersService } from '../src/orders/orders.service';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

const owner = { operatorUsername: 'packer', stationId: 'station-000000000001', requestId: 'request-000000000001' };
function confirmationService(overrides: Record<string, unknown> = {}, updateCount = 1) {
  const job: any = { id: 8n, batchPageId: 1n, jobType: 'yamato_label', status: 'pending', claimToken: 'secret',
    productId: 'STRAP', confirmationSnapshot: owner, ...overrides };
  const tx = { $queryRaw: jest.fn(), printJob: { findUnique: jest.fn(async () => ({ ...job })),
    updateMany: jest.fn(async ({ data }) => { if (updateCount) Object.assign(job, data); return { count: updateCount }; }) },
    yamatoShipmentBatchPage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  return { job, tx, service: new OrdersService({ $transaction: jest.fn(async (work) => work(tx)) } as any) };
}
const app = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
function browserFunction(name: string) {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  const tail = app.slice(start);
  const next = tail.slice(1).search(/\n(?:async )?function /);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

describe('Yamato printing optimization regressions', () => {
  it('allows a unique product and recipient fallback but rejects mismatched label details', () => {
    const service: any = new OrdersService({} as any);
    const page = { pageNo: 1, orderId: 'EXPECTED-ORDER', productIds: ['STRAP'], recipientName: '王小明' };
    const uploaded = [{ text: 'OTHER-ORDER STRAP 王小明' }];
    expect(service.matchUploadedPdfPagesToBatchPages(uploaded, [page])).toEqual(uploaded);
    expect(() => service.matchUploadedPdfPagesToBatchPages([{ text: 'EXPECTED-ORDER WRONG 王小明' }], [page])).toThrow();
    expect(() => service.matchUploadedPdfPagesToBatchPages([{ text: 'EXPECTED-ORDER STRAP 李小明' }], [page])).toThrow();
  });

  it('prefers the labelled tracking field and rejects ambiguous unlabelled numbers', () => {
    const service: any = new OrdersService({} as any);
    expect(service.extractTrackingNoFromPdfText('商品ID 1234-1111-2222 / お問い合わせ番号 9999-8888-7777')).toBe('9999-8888-7777');
    expect(service.extractTrackingNoFromPdfText('1234-1111-2222 9999-8888-7777')).toBeNull();
    expect(service.extractTrackingNoFromPdfText('tracking number: 999988887777')).toBe('9999-8888-7777');
    expect(service.extractTrackingNoFromPdfText('商品 123411112222', ['123411112222'])).toBeNull();
    expect(service.extractTrackingNoFromPdfText('お問い合わせ番号 1234-1111-2222 追跡番号 9999-8888-7777')).toBeNull();
  });

  it('rejects duplicate tracking numbers before writing or merging the PDF', async () => {
    const service: any = new OrdersService({ yamatoShipmentBatch: { findUnique: jest.fn().mockResolvedValue({ id: 2n, pages: [
      { pageNo: 1, orderId: 'ORDER-1', productIds: ['STRAP'], recipientName: 'A' },
      { pageNo: 2, orderId: 'ORDER-2', productIds: ['STRAP'], recipientName: 'B' },
    ] }) } } as any);
    service.extractUploadedYamatoPdfPages = jest.fn().mockResolvedValue([
      { text: 'ORDER-1 STRAP A tracking number 123411112222' }, { text: 'ORDER-2 STRAP B tracking number 123411112222' },
    ]);
    service.mergeUploadedPdfPagesInBatchOrder = jest.fn();
    await expect(service.uploadYamatoShipmentBatchPdf('2', [{ buffer: Buffer.from('%PDF-') }])).rejects.toThrow('重复快递单号');
    expect(service.mergeUploadedPdfPagesInBatchOrder).not.toHaveBeenCalled();
  });

  it('cannot confirm a queued agent job as printed before submission', async () => {
    const { service, tx } = confirmationService();
    await expect(service.confirmYamatoLocalPrintJob('8', true, owner.operatorUsername, owner.stationId)).rejects.toThrow('尚未提交');
    expect(tx.yamatoShipmentBatchPage.updateMany).not.toHaveBeenCalled();
    expect(tx.printJob.updateMany).not.toHaveBeenCalled();
  });

  it.each([['other', owner.stationId], [owner.operatorUsername, 'other-station']])('rejects confirmation by a different operator or station', async (user, station) => {
    const { service, tx } = confirmationService({ status: 'claimed', confirmationSnapshot: { ...owner, submissionAccepted: true } });
    await expect(service.confirmYamatoLocalPrintJob('8', true, user, station)).rejects.toThrow('占用');
    expect(tx.printJob.updateMany).not.toHaveBeenCalled();
  });

  it('rejects reuse by another packing request and permits the original request', async () => {
    const service: any = new OrdersService({} as any);
    expect(() => service.assertYamatoPrintOwner(owner, { ...owner, requestId: 'new-request' }, true)).toThrow('占用');
    expect(() => service.assertYamatoPrintOwner(owner, owner, true)).not.toThrow();
  });

  it('recovers an interrupted direct print only after waiting and explicitly stopping the original process', async () => {
    const { service, tx } = confirmationService({ jobType: 'yamato_direct', status: 'claimed', claimedAt: new Date(Date.now() - 6 * 60000) });
    await expect(service.confirmYamatoLocalPrintJob('8', false, owner.operatorUsername, owner.stationId)).rejects.toThrow('尚未提交');
    await service.confirmYamatoLocalPrintJob('8', false, owner.operatorUsername, owner.stationId, true);
    expect(tx.printJob.updateMany.mock.calls[0][0]).toMatchObject({ where: { status: 'claimed', claimToken: 'secret' }, data: { status: 'failed', claimToken: null, confirmationSnapshot: { recoveryStopped: true } } });
    expect(tx.yamatoShipmentBatchPage.updateMany).not.toHaveBeenCalled();
  });

  it('does not recover a newly claimed job or accept a racing agent claim', async () => {
    const fresh = confirmationService({ status: 'claimed', claimedAt: new Date() });
    await expect(fresh.service.confirmYamatoLocalPrintJob('8', false, owner.operatorUsername, owner.stationId, true)).rejects.toThrow('五分钟');
    const racing = confirmationService({}, 0);
    await expect(racing.service.confirmYamatoLocalPrintJob('8', false, owner.operatorUsername, owner.stationId)).rejects.toThrow('打印程序处理');
  });

  it('blocks completing a batch while a reprint is still awaiting paper confirmation', async () => {
    const tx = { $queryRaw: jest.fn(), overseasPickingBatch: { findUnique: jest.fn().mockResolvedValue({ id: 4n, status: 'yamato_exported' }), update: jest.fn() },
      yamatoShipmentBatch: { findFirst: jest.fn().mockResolvedValue({ id: 2n, status: 'pdf_ready', pageCount: 1, pages: [{ printedAt: new Date() }] }) },
      printJob: { count: jest.fn().mockResolvedValue(1) } };
    const transaction = jest.fn(async (work, _options) => work(tx));
    const service = new OrdersService({ $transaction: transaction } as any);
    await expect(service.completeOverseasPickingBatchWork('4')).rejects.toThrow('补打任务');
    expect(tx.overseasPickingBatch.update).not.toHaveBeenCalled();
    expect(transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'ReadCommitted' });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('preserves a second identical barcode entered while the first print is still pending', async () => {
    const input = { value: 'STRAP' };
    let finish!: () => void;
    const printing = new Promise<void>((resolve) => { finish = resolve; });
    const executing = jest.fn(() => printing);
    const context: any = { state: {}, previewYamatoShipmentPageByProductId: jest.fn().mockResolvedValue({ pageNo: 1, products: [{ productId: 'STRAP', quantity: 1 }] }), executeYamatoPrintForProduct: executing };
    runInNewContext(browserFunction('submitOverseasYamatoScan'), context);
    const first = context.submitOverseasYamatoScan({ scanRequest: { input, rawValue: 'STRAP', batch: { id: '2' } } });
    expect(input.value).toBe('');
    await Promise.resolve();
    input.value = 'STRAP';
    finish();
    await first;
    expect(input.value).toBe('STRAP');
    expect(executing).toHaveBeenCalledTimes(1);
  });

  it('persists scan progress and job identities separately for each logged-in operator', () => {
    const setItem = jest.fn();
    const context: any = { state: { me: { username: 'packer' }, yamatoMergedScanSession: { batchId: '2', products: [{ scannedQty: 1 }] }, yamatoPendingPaperConfirmations: { '2:1': { meta: { queueJobId: '8' } } }, yamatoPrintRequests: { '2:1:normal': owner.requestId } }, sessionStorage: { setItem } };
    runInNewContext(browserFunction('persistYamatoScanProgress'), context);
    context.persistYamatoScanProgress();
    expect(setItem.mock.calls[0][0]).toBe('yamatoProgress:packer');
    expect(JSON.parse(setItem.mock.calls[0][1])).toMatchObject({ session: { products: [{ scannedQty: 1 }] }, pending: { '2:1': { meta: { queueJobId: '8' } } }, requests: { '2:1:normal': owner.requestId } });
  });
  it('preserves input when the merged packing session is already submitting', async () => {
    const input = { value: 'STRAP' };
    const context: any = { state: { yamatoMergedScanSession: { submitting: true } } };
    runInNewContext(browserFunction('submitOverseasYamatoScan'), context);
    await expect(context.submitOverseasYamatoScan({ scanRequest: { input, rawValue: 'STRAP', batch: { id: '2' } } })).rejects.toThrow('输入已保留');
    expect(input.value).toBe('STRAP');
  });

  it('clears a failed agent job from recovery memory so the retained scans can be retried', async () => {
    const state = { yamatoPendingPaperConfirmations: { pending: { meta: { queueJobId: '8' } } } };
    const context: any = { state, getYamatoPrintJobStatus: jest.fn().mockResolvedValue({ status: 'failed', errorMessage: 'Download failed' }), persistYamatoScanProgress: jest.fn() };
    runInNewContext(browserFunction('waitForYamatoPrintSubmission'), context);
    await expect(context.waitForYamatoPrintSubmission('8')).rejects.toThrow('可重新确认打印');
    expect(state.yamatoPendingPaperConfirmations).toEqual({});
  });

  it('pauses a queued job on administrator takeover and preserves the ownership audit', async () => {
    const { service, job, tx } = confirmationService();
    const station = 'admin-station-0000001';
    await service.takeOverYamatoPrintJob('8', 'admin', station, true);
    expect(job).toMatchObject({ status: 'claimed', claimToken: null, confirmationSnapshot: { operatorUsername: 'admin', stationId: station, cancelOnly: true, submissionUncertain: true, ownershipTransfers: [{ previousOperator: 'packer', previousStation: owner.stationId, stopped: true }] } });
    await expect(service.confirmYamatoLocalPrintJob('8', true, 'admin', station)).rejects.toThrow('仅可确认取消');
    await expect(service.confirmYamatoLocalPrintJob('8', false, owner.operatorUsername, owner.stationId)).rejects.toThrow('占用');
    await service.confirmYamatoLocalPrintJob('8', false, 'admin', station);
    expect(job.status).toBe('failed');
    expect(tx.yamatoShipmentBatchPage.updateMany).not.toHaveBeenCalled();
  });

  it('requires explicit stoppage and refuses takeover of a recently claimed task', async () => {
    const { service, tx } = confirmationService({ status: 'claimed', claimedAt: new Date() });
    await expect(service.takeOverYamatoPrintJob('8', 'admin', 'admin-station-0000001', false)).rejects.toThrow('停止原打印程序');
    await expect(service.takeOverYamatoPrintJob('8', 'admin', 'admin-station-0000001', true)).rejects.toThrow('五分钟');
    expect(tx.printJob.updateMany).not.toHaveBeenCalled();
  });

  it('allows only administrators to use the task takeover endpoint', () => {
    const guard = new RolesGuard(new Reflector());
    const context = (role: string): any => ({ getHandler: () => OrdersController.prototype.takeOverYamatoPrintJob,
      getClass: () => OrdersController, switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }) });
    expect(guard.canActivate(context('employee'))).toBe(false);
    expect(guard.canActivate(context('admin'))).toBe(true);
    expect(guard.canActivate(context('system_admin'))).toBe(true);
  });

  it('does not let a late direct-print response resume a task already taken over', async () => {
    const snapshot = { ...owner };
    const job: any = { status: 'claimed', confirmationSnapshot: snapshot };
    const updateMany = jest.fn(async ({ where, data }) => {
      if (job.status !== where.status || JSON.stringify(job.confirmationSnapshot) !== JSON.stringify(where.confirmationSnapshot.equals)) return { count: 0 };
      Object.assign(job, data); return { count: 1 };
    });
    const service: any = new OrdersService({ printJob: { updateMany } } as any);
    service.isYamatoDirectPrintEnabled = () => true;
    service.prepareYamatoShipmentLabelByProductId = jest.fn().mockResolvedValue({ batchId: '2', pageNo: 1, productId: 'STRAP', productIds: ['STRAP'], fileName: 'label.pdf', content: Buffer.from('pdf'), confirmationSnapshot: snapshot });
    service.resolveYamatoPrinterNameForProductIds = jest.fn().mockResolvedValue('P');
    service.reserveYamatoPrintJob = jest.fn().mockResolvedValue({ queueJobId: '8' });
    service.sendPdfBufferToPrinter = jest.fn(async () => {
      job.confirmationSnapshot = { ...owner, operatorUsername: 'admin', submissionUncertain: true };
      return { printerName: 'P', printJobId: 'lp-1' };
    });
    await service.directPrintYamatoShipmentLabelByProductId('2', {});
    expect(job.status).toBe('claimed');
    expect(job.confirmationSnapshot.operatorUsername).toBe('admin');
    expect(job.systemJobId).toBeUndefined();
  });

});
