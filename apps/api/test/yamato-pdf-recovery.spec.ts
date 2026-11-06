import { OrdersService } from '../src/orders/orders.service';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runInNewContext } from 'vm';

describe('Yamato missing PDF recovery', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'yamato-recovery-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function setup() {
    const page = { id: 1n, pageNo: 1, orderId: 'ORDER-1', productIds: ['STRAP'], recipientName: 'A',
      trackingNo: '1234-1111-2222', printedAt: new Date(), printedProductId: 'STRAP' };
    const batch = { id: 2n, status: 'pdf_ready', pickingBatchId: 3n, pdfFilePath: join(dir, 'missing.pdf'), pages: [page] };
    const tx = {
      $queryRaw: jest.fn(),
      yamatoShipmentBatch: { findUnique: jest.fn(async () => batch), update: jest.fn() },
      yamatoShipmentBatchPage: { count: jest.fn().mockResolvedValue(1), findMany: jest.fn(async () => [page]), update: jest.fn() },
      printJob: { count: jest.fn().mockResolvedValueOnce(1).mockResolvedValue(0) },
      overseasPickingBatchItem: { updateMany: jest.fn() },
    };
    const service: any = new OrdersService({ yamatoShipmentBatch: { findUnique: jest.fn(async () => batch) },
      $transaction: jest.fn(async (work) => work(tx)) } as any);
    service.extractUploadedYamatoPdfPages = jest.fn().mockResolvedValue([{ text: 'ORDER-1 STRAP A tracking number 123411112222' }]);
    service.mergeUploadedPdfPagesInBatchOrder = jest.fn().mockResolvedValue(Buffer.from('%PDF-restored'));
    service.buildYamatoBatchPdfPath = () => join(dir, 'restored.pdf');
    service.ensureYamatoBatchDir = jest.fn();
    service.syncManualOrderIdsToXyjgBestEffort = jest.fn();
    return { service, tx, page, batch };
  }
  const files = [{ buffer: Buffer.from('%PDF-original'), originalName: 'labels.pdf' }];

  it('restores the file while keeping printed pages, jobs and order tracking untouched', async () => {
    const { service, tx } = setup();
    await expect(service.uploadYamatoShipmentBatchPdf('2', files)).resolves.toMatchObject({ id: '2', status: 'pdf_ready' });
    expect(await readFile(join(dir, 'restored.pdf'), 'utf8')).toBe('%PDF-restored');
    expect(tx.yamatoShipmentBatch.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pdfFilePath: join(dir, 'restored.pdf') }) }));
    expect(tx.yamatoShipmentBatchPage.update).not.toHaveBeenCalled();
    expect(tx.overseasPickingBatchItem.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a different tracking number and removes the rejected upload', async () => {
    const { service, page, tx } = setup();
    page.trackingNo = '9999-8888-7777';
    await expect(service.uploadYamatoShipmentBatchPdf('2', files)).rejects.toThrow('运单号必须与原记录一致');
    expect(tx.yamatoShipmentBatch.update).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it('blocks recovery while an original or reprint job is unresolved', async () => {
    const { service, tx } = setup();
    tx.printJob.count.mockReset().mockResolvedValue(1);
    await expect(service.uploadYamatoShipmentBatchPdf('2', files)).rejects.toThrow('待确认');
    expect(tx.yamatoShipmentBatch.update).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps replacement forbidden when the original PDF still exists', async () => {
    const { service, batch, tx } = setup();
    await writeFile(batch.pdfFilePath, '%PDF-existing');
    await expect(service.uploadYamatoShipmentBatchPdf('2', files)).rejects.toThrow('不能替换 PDF');
    expect(tx.yamatoShipmentBatch.update).not.toHaveBeenCalled();
    expect(await readFile(batch.pdfFilePath, 'utf8')).toBe('%PDF-existing');
  });

  it('allows recovery with zero printed pages without rebinding the label records', async () => {
    const { service, tx } = setup();
    tx.yamatoShipmentBatchPage.count.mockResolvedValue(0);
    tx.printJob.count.mockReset().mockResolvedValue(0);
    await service.uploadYamatoShipmentBatchPdf('2', files);
    expect(tx.yamatoShipmentBatchPage.update).not.toHaveBeenCalled();
  });

  it('exposes recovery for a partially printed batch and disables printing until restored', () => {
    const app = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
    const start = app.indexOf('function renderYamatoShipmentBatchControls()');
    const end = app.indexOf('\nfunction ', start + 1);
    const elements: any = {};
    const batch = { id: '189', status: 'pdf_ready', pdfAvailable: false, printedPageCount: 11 };
    const context: any = { $: (id: string) => elements[id] ||= {}, getSelectedYamatoShipmentBatch: () => batch,
      state: { selectedOverseasPickingBatchDetail: { status: 'picking' } }, displayText: String, escapeHtml: String };
    runInNewContext(app.slice(start, end), context);
    context.renderYamatoShipmentBatchControls();
    expect(elements.overseasUploadYamatoPdfBtn).toMatchObject({ disabled: false, textContent: '3.恢复 Yamato PDF' });
    expect(elements.overseasYamatoScanSubmitBtn.disabled).toBe(true);
    expect(elements.overseasYamatoReprintBtn.disabled).toBe(true);
    expect(elements.overseasYamatoBatchSummary.textContent).toContain('已打印 11 张的进度会保留');
    batch.pdfAvailable = true;
    context.getYamatoPrintModeSummary = () => '';
    context.renderYamatoShipmentBatchControls();
    expect(elements.overseasUploadYamatoPdfBtn.disabled).toBe(true);
    expect(elements.overseasYamatoScanSubmitBtn.disabled).toBe(false);
  });
});
