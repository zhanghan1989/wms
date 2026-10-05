import { PrintAgentService } from '../src/print-agent/print-agent.service';
import { OrdersService } from '../src/orders/orders.service';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

const app = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
function browserFunction(name: string) {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  const tail = app.slice(start);
  const next = tail.slice(1).search(/\n(?:async )?function /);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
const parts = [
  { componentProductId: 'BODY-1', componentProductType: '肩带本体', requiredQty: 2, pickingConfirmedQty: 2 },
  { componentProductId: 'HOOK-2', componentProductType: '肩带配件', requiredQty: 4, pickingConfirmedQty: 4 },
];
function bodyService() {
  const pages = [
    { id: 1n, pageNo: 1, orderId: 'A', productIds: ['STRAP-A'], printedAt: null },
    { id: 2n, pageNo: 2, orderId: 'B', productIds: ['STRAP-A'], printedAt: null },
    { id: 3n, pageNo: 3, orderId: 'C', productIds: ['STRAP-C'], printedAt: null },
  ];
  const picking = (orderId: string, productId: string, finished: number) => ({ orderId, productId,
    actualQty: 2, requestedQty: 2, pickingPlanSnapshot: finished ? [{ boxQty: finished, pickQty: finished }] : [],
    bomSnapshot: [{ componentProductId: 'BODY-1', quantity: 1 }],
  });
  return new OrdersService({
    yamatoShipmentBatch: { findUnique: jest.fn().mockResolvedValue({ id: 4n, pickingBatchId: 5n,
      status: 'pdf_ready', pdfFilePath: '/unused.pdf', pages }) },
    masterProduct: { findUnique: jest.fn().mockResolvedValue({ productType: '肩带本体' }) },
    overseasPickingBatchItem: { findMany: jest.fn().mockResolvedValue([
      picking('A', 'STRAP-A', 2), picking('B', 'STRAP-A', 1), picking('C', 'STRAP-C', 0),
    ]) },
  } as any) as any;
}

describe('Yamato scan and print safety', () => {
  it('counts a single product inline, prints once per order and preserves completed scans on retry', async () => {
    const state: any = {};
    const previews = [3, 2].map((quantity, index) => ({ batchId: '151', pageNo: index + 1, orderId: `ORDER-${index + 1}`,
      products: [{ productId: '12279', quantity }], assemblyParts: [] }));
    const execute = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    const preview = jest.fn().mockResolvedValueOnce(previews[0]).mockResolvedValueOnce(previews[1]);
    const input = { value: '' };
    const context: any = { state, $: () => ({ value: '', classList: { add: jest.fn() } }),
      newYamatoRequestId: () => 'request-id', persistYamatoScanProgress: jest.fn(), renderYamatoMergedScanSession: jest.fn(),
      renderYamatoInlineScanProgress: jest.fn(), focusOverseasYamatoScanInput: jest.fn(), openModal: jest.fn(), closeModal: jest.fn(),
      getYamatoShipmentBatchById: () => ({ id: '151' }), executeYamatoPrintForProduct: execute,
      previewYamatoShipmentPageByProductId: preview };
    runInNewContext(['normalizeYamatoProductId', 'isYamatoMergedScanComplete', 'startYamatoMergedScanSession',
      'focusYamatoMergedScanInput', 'handleYamatoMergedScanValue', 'finishYamatoMergedScanSession', 'submitOverseasYamatoScan']
      .map(browserFunction).join('\n'), context);
    const scan = (rawValue = '12279') => context.submitOverseasYamatoScan({ scanRequest: { input, rawValue, batch: { id: '151' } } });
    await scan();
    expect(state.yamatoMergedScanSession).toMatchObject({ inline: true, products: [{ scannedQty: 1 }] });
    await expect(scan('WRONG')).rejects.toThrow('不是当前面单');
    expect(state.yamatoMergedScanSession.products[0].scannedQty).toBe(1);
    await scan();
    expect(execute).not.toHaveBeenCalled();
    await scan();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][2].requestOptions.scanRecords).toEqual([{ productId: '12279', scannedCode: '12279', quantity: 3 }]);
    expect(state.yamatoMergedScanSession).toBeNull();
    await scan();
    await expect(scan()).rejects.toThrow('offline');
    expect(state.yamatoMergedScanSession).toMatchObject({ submitting: false, products: [{ scannedQty: 2 }] });
    await scan();
    expect(execute.mock.calls[2][2].requestOptions.scanRecords[0].quantity).toBe(2);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(context.openModal).not.toHaveBeenCalled();
  });
  it('separates ordinary product scanning, shoulder assembly and mixed-order stages', () => {
    const context: any = {};
    runInNewContext(browserFunction('getYamatoScanConfirmationMode'), context);
    const product = { quantity: 1, scannedQty: 1 };
    expect(context.getYamatoScanConfirmationMode({ products: [product, product], assemblyParts: [] }))
      .toMatchObject({ hasAssembly: false, productStep: false, assemblyStep: false, productsComplete: true });
    expect(context.getYamatoScanConfirmationMode({ products: [product], assemblyParts: parts }))
      .toMatchObject({ productStep: false, assemblyStep: true });
    const mixed = { products: [product, { quantity: 2, scannedQty: 1 }], assemblyParts: parts, assemblyStep: false };
    expect(context.getYamatoScanConfirmationMode(mixed)).toMatchObject({ productStep: true, assemblyStep: false, productsComplete: false });
    mixed.products[1].scannedQty = 2;
    expect(context.getYamatoScanConfirmationMode(mixed)).toMatchObject({ productsComplete: true, productStep: true });
    mixed.assemblyStep = true;
    expect(context.getYamatoScanConfirmationMode(mixed)).toMatchObject({ productStep: false, assemblyStep: true });
  });
  it('matches body aliases to finished and assembled shipments and demands an explicit order selection', async () => {
    const service = bodyService();
    await expect(service.findPrintableYamatoShipmentPageByProductId('4', { productId: 'BODY-1' }))
      .rejects.toThrow('请先选择');
    const preview = await service.findPrintableYamatoShipmentPageByProductId('4', { productId: 'BODY-1' }, { allowAmbiguous: true });
    expect(preview.printablePages.map((page: any) => page.orderId)).toEqual(['A', 'B', 'C']);
    const finished = await service.findPrintableYamatoShipmentPageByProductId('4', { productId: 'BODY-1', pageNo: 1 });
    expect(finished.targetPage.orderId).toBe('A');
    const selected = await service.findPrintableYamatoShipmentPageByProductId('4', { productId: 'BODY-1', pageNo: 3 });
    expect(selected.targetPage.orderId).toBe('C');
  });

  it('accepts either code for each shoulder in a mixed shipment without demanding a second scan', async () => {
    const service = new OrdersService({
      masterProduct: { findMany: jest.fn(async (query) => query.where.productId.in.includes('STRAP') ? [{ productId: 'STRAP', productName: 'Strap' }] : [{ productId: 'BODY-1', productType: '肩带本体' }]) },
      overseasPickingBatchItem: { findMany: jest.fn().mockResolvedValue([{
        productId: 'STRAP', actualQty: 3, pickingPlanSnapshot: [{ boxQty: 1, pickQty: 1 }],
        bomSnapshot: [{ componentProductId: 'BODY-1', quantity: 1 }],
      }]) },
    } as any) as any;
    const products = await service.buildYamatoShipmentPageProductDetails({ orderId: 'MIX', productIds: ['STRAP'], itemSummary: 'DGAZ STRAP*3個(BODY-1*3個)' }, 5n);
    expect(products[0]).toMatchObject({ quantity: 3, finishedQuantity: 1, assemblyQuantity: 2 });
    expect(products[0].bodyProductIds).toEqual(['BODY-1']);
    const scan = (scannedCode: string, quantity: number) => ({ productId: 'STRAP', scannedCode, quantity });
    expect(() => service.assertYamatoScannedProducts({ scanRecords: [scan('BODY-1', 3)] }, products)).not.toThrow();
    expect(() => service.assertYamatoScannedProducts({ scanRecords: [scan('STRAP', 3)] }, products)).not.toThrow();
    expect(() => service.assertYamatoScannedProducts({ scanRecords: [scan('BODY-1', 2), scan('STRAP', 1)] }, products)).not.toThrow();
    expect(() => service.assertYamatoScannedProducts({ scanRecords: [scan('BODY-1', 3), scan('STRAP', 3)] }, products)).toThrow();
    expect(() => service.assertYamatoScannedProducts({ scanRecords: [scan('HOOK-2', 3)] }, products)).toThrow();

  });

  it('rejects missing or wrong accessory counts and legacy ID-only confirmation', () => {
    const service = new OrdersService({} as any) as any;
    const valid = { confirmedAssemblyParts: [{ productId: 'HOOK-2', quantity: 4 }] };
    expect(() => service.assertYamatoAssemblyPartsConfirmed(valid, parts)).not.toThrow();
    for (const quantity of [0, 1, 3, 5, NaN]) {
      expect(() => service.assertYamatoAssemblyPartsConfirmed({ confirmedAssemblyParts: [{ productId: 'HOOK-2', quantity }] }, parts)).toThrow();
    }
    expect(() => service.assertYamatoAssemblyPartsConfirmed({ confirmedAssemblyComponentProductIds: ['BODY-1', 'HOOK-2'] }, parts)).toThrow();
    expect(() => service.assertYamatoAssemblyPartsConfirmed(valid, [{ ...parts[1], pickingConfirmedQty: 3 }])).toThrow('拣货数量未完成');
  });

  it('uses the exact order number even when another PDF page contains the same product', () => {
    const service = new OrdersService({} as any) as any;
    const pages = [{ text: 'ORDER-11 STRAP 张三' }, { text: 'ORDER-1 STRAP 李四' }];
    const expected = [{ pageNo: 1, orderId: 'ORDER-1', productIds: ['STRAP'], recipientName: '李四' },
      { pageNo: 2, orderId: 'ORDER-11', productIds: ['STRAP'], recipientName: '张三' }];
    expect(service.matchUploadedPdfPagesToBatchPages(pages, expected)).toEqual([pages[1], pages[0]]);
  });

  it('matches labels without order numbers by product and normalized recipient name', () => {
    const service = new OrdersService({} as any) as any;
    const pages = [{ text: 'DGAZ 12279*1個 花田 里佳 様' }];
    const expected = [{ pageNo: 1, orderId: '421951-20261005-0951508794', productIds: ['12279'], recipientName: '花田里佳' }];
    expect(service.matchUploadedPdfPagesToBatchPages(pages, expected)).toEqual(pages);
    expect(() => service.matchUploadedPdfPagesToBatchPages(pages, [{ ...expected[0], recipientName: null }])).toThrow('失败');
    expect(() => service.matchUploadedPdfPagesToBatchPages(pages, [{ ...expected[0], recipientName: '其他人' }])).toThrow('失败');
  });

  it('refuses ambiguous fallback matches and reused fallback pages', () => {
    const service = new OrdersService({} as any) as any;
    const expected = { pageNo: 1, orderId: 'ORDER-1', productIds: ['ABC1'], recipientName: '张三' };
    const page = { text: 'ABC1 张三' };
    expect(() => service.matchUploadedPdfPagesToBatchPages([page, { ...page }], [expected])).toThrow('不唯一');
    expect(() => service.matchUploadedPdfPagesToBatchPages([page], [expected, { ...expected, orderId: 'ORDER-2', pageNo: 2 }])).toThrow('多个订单');
  });

  it('refuses ambiguous PDFs, reused pages and partial product ID matches', () => {
    const service = new OrdersService({} as any) as any;
    const expected = { pageNo: 1, orderId: 'ABSENT', productIds: ['ABC1'], recipientName: '张三' };
    expect(() => service.matchUploadedPdfPagesToBatchPages([{ text: 'ABSENT ABC1 张三' }, { text: 'ABSENT ABC1 张三' }], [expected])).toThrow('不唯一');
    expect(() => service.matchUploadedPdfPagesToBatchPages([{ text: 'ABC11 张三' }], [expected])).toThrow('失败');
    expect(() => service.matchUploadedPdfPagesToBatchPages([{ text: 'ABSENT ABC1 张三' }], [expected, { ...expected, pageNo: 2 }])).toThrow('多个订单');
  });

  it('returns an existing active print job instead of creating or failing it', async () => {
    const active = { id: 8n, jobType: 'yamato_label', productId: 'STRAP', status: 'claimed', trackingNo: '123', printerName: 'P' };
    const tx = { $queryRaw: jest.fn(), yamatoShipmentBatchPage: { findUnique: jest.fn().mockResolvedValue({ printedAt: null }) },
      printJob: { findFirst: jest.fn().mockResolvedValue(active), create: jest.fn(), updateMany: jest.fn() } };
    const service = new OrdersService({ $transaction: jest.fn(async (work) => work(tx)) } as any) as any;
    const result = await service.reserveYamatoPrintJob({ pageId: 1n, batchId: '2', pageNo: 3 }, 'P', 'yamato_label');
    expect(result).toMatchObject({ queueJobId: '8', reused: true });
    expect(tx.printJob.create).not.toHaveBeenCalled();
    expect(tx.printJob.updateMany).not.toHaveBeenCalled();
  });

  it('serializes simultaneous requests for one page and creates only one job', async () => {
    let active: any = null;
    let transactionTail = Promise.resolve();
    const tx = { $queryRaw: jest.fn(), yamatoShipmentBatchPage: { findUnique: jest.fn().mockResolvedValue({ printedAt: null }) },
      printJob: { findFirst: jest.fn(async () => active) } };
    const service = new OrdersService({ $transaction: (work: any) => {
      const result = transactionTail.then(() => work(tx));
      transactionTail = result.then(() => undefined, () => undefined);
      return result;
    } } as any) as any;
    service.createYamatoShipmentPrintJob = jest.fn(async () => {
      active = { id: 8n, jobType: 'yamato_label', productId: 'STRAP', status: 'pending' };
      return { queueJobId: '8' };
    });
    const prepared = { pageId: 1n, batchId: '2', pageNo: 3 };
    const results = await Promise.all([service.reserveYamatoPrintJob(prepared, 'P', 'yamato_label'), service.reserveYamatoPrintJob(prepared, 'P', 'yamato_label')]);
    expect(results.map((result) => result.queueJobId)).toEqual(['8', '8']);
    expect(service.createYamatoShipmentPrintJob).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('does not mark a browser print as printed when returning the PDF', async () => {
    const service = new OrdersService({} as any) as any;
    service.prepareYamatoShipmentLabelByProductId = jest.fn().mockResolvedValue({ pageId: 1n, batchId: '2', content: Buffer.from('pdf'), pageNo: 1 });
    service.reserveYamatoPrintJob = jest.fn().mockResolvedValue({ queueJobId: '8', reused: true });
    service.confirmYamatoLocalPrintJob = jest.fn();
    const result = await service.printYamatoShipmentLabelByProductId('2', { productId: 'STRAP' });
    expect(result).toMatchObject({ queueJobId: '8', reused: true });
    expect(service.confirmYamatoLocalPrintJob).not.toHaveBeenCalled();
  });

  it('marks completion only after paper confirmation and accepts repeated confirmation safely', async () => {
    const job = { id: 8n, batchPageId: 1n, jobType: 'yamato_browser', status: 'pending', productId: 'STRAP', confirmationSnapshot: {} };
    const tx = { $queryRaw: jest.fn(), printJob: { findUnique: jest.fn(async () => ({ ...job })),
      updateMany: jest.fn(async ({ data }) => { Object.assign(job, data); return { count: 1 }; }) },
      yamatoShipmentBatchPage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const service = new OrdersService({ $transaction: jest.fn(async (work) => work(tx)) } as any);
    await service.confirmYamatoLocalPrintJob('8', true, 'worker');
    expect(tx.yamatoShipmentBatchPage.updateMany).toHaveBeenCalledTimes(1);
    expect(job.confirmationSnapshot).toMatchObject({ paperConfirmedBy: 'worker', paperPrinted: true });
    await service.confirmYamatoLocalPrintJob('8', true, 'worker');
    expect(tx.yamatoShipmentBatchPage.updateMany).toHaveBeenCalledTimes(1);
  });

  it('retains scan progress when printing fails and never uses the requeue endpoint', async () => {
    const session = { batchId: '2', pageNo: 1, printProductId: 'STRAP', products: [{ productId: 'STRAP', scannedQty: 1 }], scanRecords: [{ productId: 'STRAP', scannedCode: 'STRAP', quantity: 1 }], assemblyParts: [] };
    const state = { yamatoMergedScanSession: session };
    const execute = jest.fn().mockRejectedValue(new Error('offline'));
    const context: any = { persistYamatoScanProgress: jest.fn(), newYamatoRequestId: () => 'request-1', getYamatoStationId: () => 'station-1', state, isYamatoMergedScanComplete: () => true, getYamatoShipmentBatchById: () => ({ id: '2' }),
      executeYamatoPrintForProduct: execute, renderYamatoInlineScanProgress: jest.fn(), renderYamatoMergedScanSession: jest.fn(), closeModal: jest.fn() };
    runInNewContext(browserFunction('finishYamatoMergedScanSession'), context);
    await expect(context.finishYamatoMergedScanSession()).rejects.toThrow('offline');
    expect(state.yamatoMergedScanSession).toBe(session);
    expect(session).toMatchObject({ submitting: false });
    expect(context.closeModal).not.toHaveBeenCalled();
    expect(execute.mock.calls[0][2].requestOptions).toMatchObject({ pageNo: 1, scanRecords: [{ productId: 'STRAP', scannedCode: 'STRAP', quantity: 1 }] });
  });

  it('counts either code once per product and rejects excess or accessory scans', async () => {
    const session = { products: [{ productId: 'STRAP', quantity: 3, finishedQuantity: 1, bodyProductIds: ['BODY-1'], scannedQty: 0 }], scanRecords: [], assemblyParts: [] };
    const context: any = { state: { yamatoMergedScanSession: session }, $: () => ({ value: '' }), renderYamatoMergedScanSession: jest.fn(), focusYamatoMergedScanInput: jest.fn() };
    runInNewContext(browserFunction('normalizeYamatoProductId') + browserFunction('handleYamatoMergedScanValue'), context);
    await context.handleYamatoMergedScanValue('BODY-1');
    await context.handleYamatoMergedScanValue('BODY-1');
    await context.handleYamatoMergedScanValue('STRAP');
    expect(session.products[0].scannedQty).toBe(3);
    expect(session.scanRecords).toEqual([{ productId: 'STRAP', scannedCode: 'BODY-1', quantity: 2 }, { productId: 'STRAP', scannedCode: 'STRAP', quantity: 1 }]);
    await expect(context.handleYamatoMergedScanValue('BODY-1')).rejects.toThrow('已扫码完成');
    await expect(context.handleYamatoMergedScanValue('HOOK-2')).rejects.toThrow('不是当前面单');
  });

  it('requires all shoulder units and an accessory count confirmation before enabling print', () => {
    const context: any = { state: {} };
    runInNewContext(browserFunction('isYamatoMergedScanComplete'), context);
    const session = { products: [{ quantity: 3, finishedQuantity: 1, scannedQty: 3 }], assemblyParts: [
      { componentProductType: '肩带本体', requiredQty: 2, scannedQty: 2 },
      { componentProductType: '肩带配件', requiredQty: 4, confirmed: true, confirmedQty: 3 },
    ] };
    expect(context.isYamatoMergedScanComplete(session)).toBe(false);
    session.assemblyParts[1].confirmedQty = 4;
    expect(context.isYamatoMergedScanComplete(session)).toBe(true);
  });
  it('allows explicit reprint of a printed page but blocks replacing an in-flight original job', async () => {
    const active = { id: 8n, jobType: 'yamato_label', productId: 'STRAP', status: 'claimed', confirmationSnapshot: { requestId: 'original' } };
    const tx = { $queryRaw: jest.fn(), yamatoShipmentBatchPage: { findUnique: jest.fn().mockResolvedValue({ printedAt: new Date() }) },
      printJob: { findFirst: jest.fn(async (query) => query.where.status === 'completed' ? null : active) } };
    const service = new OrdersService({ $transaction: jest.fn(async (work) => work(tx)) } as any) as any;
    service.createYamatoShipmentPrintJob = jest.fn().mockResolvedValue({ queueJobId: '9' });
    const prepared = { pageId: 1n, batchId: '2', pageNo: 3, isReprint: true, printRequestId: 'reprint-request-id' };
    await expect(service.reserveYamatoPrintJob(prepared, 'P', 'yamato_label')).rejects.toThrow('占用');
    expect(service.createYamatoShipmentPrintJob).not.toHaveBeenCalled();
    tx.printJob.findFirst.mockResolvedValue(null as any);
    await expect(service.reserveYamatoPrintJob(prepared, 'P', 'yamato_label')).resolves.toMatchObject({ queueJobId: '9' });
    expect(service.createYamatoShipmentPrintJob).toHaveBeenCalledTimes(1);
  });

  it('records agent spool acceptance without claiming physical paper output', async () => {
    const job = { id: 8n, batchPageId: 1n, jobType: 'yamato_label', status: 'claimed', productId: 'STRAP', claimToken: 'secret', confirmationSnapshot: { isReprint: true } };
    const tx = { printJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      yamatoShipmentBatchPage: { updateMany: jest.fn() } };
    const service = new PrintAgentService({ printJob: { findUnique: jest.fn().mockResolvedValue(job) },
      $transaction: jest.fn(async (work) => work(tx)) } as any);
    await expect(service.completeJob('8', { claimToken: 'secret' })).resolves.toEqual({ id: '8', status: 'submitted' });
    expect(tx.yamatoShipmentBatchPage.updateMany).not.toHaveBeenCalled();
    expect(tx.printJob.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'claimed', confirmationSnapshot: { submissionAccepted: true, isReprint: true } });
  });

  it('confirms agent reprint output without replacing the original printed timestamp', async () => {
    const job = { id: 8n, batchPageId: 1n, jobType: 'yamato_label', status: 'claimed', productId: 'STRAP', confirmationSnapshot: { isReprint: true, submissionAccepted: true } };
    const tx = { $queryRaw: jest.fn(), printJob: { findUnique: jest.fn().mockResolvedValue(job), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      yamatoShipmentBatchPage: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };
    const service = new OrdersService({ $transaction: jest.fn(async (work) => work(tx)) } as any);
    await service.confirmYamatoLocalPrintJob('8', true, 'worker');
    expect(tx.yamatoShipmentBatchPage.updateMany.mock.calls[0][0].where).toEqual({ id: 1n, printedAt: null });
    expect(tx.printJob.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'completed', confirmationSnapshot: { paperPrinted: true } });
  });

  it('keeps a paper confirmation decision across a network failure without asking or printing again', async () => {
    const state = { yamatoPendingPaperConfirmations: {} };
    const request = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    const prompt = jest.fn().mockResolvedValue(true);
    const context: any = { persistYamatoScanProgress: jest.fn(), getYamatoStationId: () => 'station-1', state, request, openActionConfirmModal: prompt };
    runInNewContext(browserFunction('confirmYamatoPaperOutput'), context);
    const meta = { queueJobId: '8' };
    await expect(context.confirmYamatoPaperOutput(meta, '2:1')).rejects.toThrow('offline');
    expect(state.yamatoPendingPaperConfirmations).toHaveProperty('2:1');
    await context.confirmYamatoPaperOutput(meta, '2:1');
    expect(prompt).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.yamatoPendingPaperConfirmations).toEqual({});
  });

  it('credits the first body scan once to the associated finished product', () => {
    const context: any = { newYamatoRequestId: () => 'unique-print-request', state: {}, crypto: { randomUUID: () => 'unique-print-request' },
      renderYamatoMergedScanSession: jest.fn(), openModal: jest.fn(), focusYamatoMergedScanInput: jest.fn(), $: () => ({ value: '' }) };
    runInNewContext(browserFunction('normalizeYamatoProductId') + browserFunction('startYamatoMergedScanSession'), context);
    context.startYamatoMergedScanSession({ batchId: '2', pageNo: 1,
      products: [{ productId: 'STRAP', quantity: 3, finishedQuantity: 1, assemblyQuantity: 2, bodyProductIds: ['BODY-1'] }],
      assemblyParts: parts }, 'BODY-1');
    expect(context.state.yamatoMergedScanSession.products[0].scannedQty).toBe(1);
    expect(context.state.yamatoMergedScanSession.scanRecords).toEqual([{ productId: 'STRAP', scannedCode: 'BODY-1', quantity: 1 }]);
    expect(context.state.yamatoMergedScanSession.assemblyParts[1].confirmed).toBe(false);
  });

  it('reuses the pending reprint request when reopening the same label', () => {
    const context: any = { newYamatoRequestId: () => 'new-request', state: { yamatoPrintRequests: { '151:11:reprint': 'original-request' } },
      renderYamatoMergedScanSession: jest.fn(), openModal: jest.fn(), focusYamatoMergedScanInput: jest.fn(), $: () => ({ value: '' }) };
    runInNewContext(browserFunction('normalizeYamatoProductId') + browserFunction('startYamatoMergedScanSession'), context);
    const preview = { batchId: '151', pageNo: 11, products: [{ productId: '102247', quantity: 1 }] };
    context.startYamatoMergedScanSession(preview, '102247', { isReprint: true });
    expect(context.state.yamatoMergedScanSession.printRequestId).toBe('original-request');
    context.startYamatoMergedScanSession(preview, '102247');
    expect(context.state.yamatoMergedScanSession.printRequestId).toBe('new-request');
    delete context.state.yamatoPrintRequests['151:11:reprint'];
    context.startYamatoMergedScanSession(preview, '102247', { isReprint: true });
    expect(context.state.yamatoMergedScanSession.printRequestId).toBe('new-request');
  });

  it('records a declined paper confirmation as failed without marking the page printed', async () => {
    const job = { id: 8n, batchPageId: 1n, jobType: 'yamato_browser', status: 'pending', productId: 'STRAP' };
    const tx = { $queryRaw: jest.fn(), printJob: { findUnique: jest.fn().mockResolvedValue(job), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      yamatoShipmentBatchPage: { updateMany: jest.fn() } };
    const service = new OrdersService({ $transaction: jest.fn(async (work) => work(tx)) } as any);
    await service.confirmYamatoLocalPrintJob('8', false, 'worker');
    expect(tx.yamatoShipmentBatchPage.updateMany).not.toHaveBeenCalled();
    expect(tx.printJob.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'failed', confirmationSnapshot: { paperPrinted: false, paperConfirmedBy: 'worker' } });
  });

  it('requires selection when multiple finished products in one order share a body', async () => {
    const session = { products: [
      { productId: 'STRAP-A', quantity: 1, bodyProductIds: ['BODY-1'], scannedQty: 0 },
      { productId: 'STRAP-B', quantity: 1, bodyProductIds: ['BODY-1'], scannedQty: 0 },
    ], scanRecords: [] };
    const select = { value: '' };
    const context: any = { state: { yamatoMergedScanSession: session }, $: () => select,
      renderYamatoMergedScanSession: jest.fn(), focusYamatoMergedScanInput: jest.fn() };
    runInNewContext(browserFunction('normalizeYamatoProductId') + browserFunction('handleYamatoMergedScanValue'), context);
    await expect(context.handleYamatoMergedScanValue('BODY-1')).rejects.toThrow('请先选择');
    expect(session.products.map((product) => product.scannedQty)).toEqual([0, 0]);
    select.value = 'STRAP-B';
    await context.handleYamatoMergedScanValue('BODY-1');
    expect(session.products.map((product) => product.scannedQty)).toEqual([0, 1]);
  });

  it('keeps uncertain spool results reserved instead of allowing an automatic duplicate print', async () => {
    const job = { id: 8n, status: 'claimed', claimToken: 'secret', confirmationSnapshot: {} };
    const updateMany = jest.fn();
    const service = new PrintAgentService({ printJob: { findUnique: jest.fn().mockResolvedValue(job), updateMany } } as any);
    await expect(service.failJob('8', { claimToken: 'secret', failureStage: 'complete', errorMessage: 'connection lost' }))
      .resolves.toEqual({ id: '8', status: 'uncertain' });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ status: 'claimed', confirmationSnapshot: { submissionUncertain: true } });
    await service.failJob('8', { claimToken: 'secret', failureStage: 'download' });
    expect(updateMany.mock.calls[1][0].data).toMatchObject({ status: 'failed' });
  });

  it('parses parent product quantity without mistaking material quantities or special IDs for products', () => {
    const service = new OrdersService({} as any) as any;
    expect(service.parseYamatoItemSummaryProductQuantities(
      'DGAZ STRAP(01)*3個(BODY/1*3個、HOOK*6個) / NORMAL*2個', ['STRAP(01)', 'NORMAL'],
    )).toEqual([{ productId: 'STRAP(01)', quantity: 3 }, { productId: 'NORMAL', quantity: 2 }]);
  });

  it('automatically confirms submitted prints without a paper confirmation dialog', async () => {
    const state = { yamatoPendingPaperConfirmations: {} };
    const request = jest.fn();
    const context: any = { persistYamatoScanProgress: jest.fn(), getYamatoStationId: () => 'station-1', state, request, openActionConfirmModal: jest.fn().mockResolvedValue(null) };
    runInNewContext(browserFunction('confirmYamatoPaperOutput'), context);
    await context.confirmYamatoPaperOutput({ queueJobId: '8' }, '2:1');
    expect(context.openActionConfirmModal).not.toHaveBeenCalled();
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ printed: true, stationId: 'station-1' });
    expect(state.yamatoPendingPaperConfirmations).toEqual({});
  });

});
