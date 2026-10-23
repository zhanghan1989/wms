import { ReturnRecordsService } from '../src/return-records/return-records.service';

function fixture(fail = false) {
  let active = 0;
  let peak = 0;
  const findUnique = jest.fn(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (fail) throw new Error('lookup failed');
    return { productName: 'Product' };
  });
  const create = jest.fn(({ data }) => Promise.resolve({ ...data, id: 1n }));
  const prisma = {
    masterProduct: { findUnique },
    returnRecord: { create },
    $transaction: jest.fn(async (queries: Promise<unknown>[]) => Promise.all(queries)),
  };
  const service = new ReturnRecordsService(prisma as never);
  jest.spyOn(service as any, 'parseExcelRows').mockReturnValue(
    Array.from({ length: 123 }, (_, i) => ({ productId: `P${i}` })),
  );
  return { service, prisma, peak: () => peak };
}

it('bounds product lookups while preserving row order and a single write transaction', async () => {
  const { service, prisma, peak } = fixture();
  const result = await service.importExcel(Buffer.alloc(0), 'returns.xlsx', 7n);
  expect(peak()).toBeLessThanOrEqual(50);
  expect(result.createdCount).toBe(123);
  expect(result.rows.map((row: any) => row.productId)).toEqual(
    Array.from({ length: 123 }, (_, i) => `P${i}`),
  );
  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
});

it('does not start writes if product preparation fails', async () => {
  const { service, prisma } = fixture(true);
  await expect(service.importExcel(Buffer.alloc(0), 'returns.xlsx', 7n)).rejects.toThrow('lookup failed');
  expect(prisma.returnRecord.create).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
