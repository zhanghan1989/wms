import { Prisma, PrismaClient } from '@prisma/client';
import { companyContext } from '../src/company-scope/company-context';
import { installCompanyIsolation } from '../src/company-scope/company-prisma';

// Exercise the production Prisma isolation extension without a database connection.
function fixture() {
  let run: (args: any) => Promise<any>;
  const client = {
    shop: { findMany: jest.fn().mockResolvedValue([]) },
    company: { findFirst: jest.fn().mockResolvedValue({ id: 2n, status: 1 }) },
    $extends: (extension: any) => {
      run = extension.query.$allOperations;
      return client;
    },
  };
  installCompanyIsolation(client as unknown as PrismaClient);
  return (operation: string, args: any, model: string | null = 'ReturnRecord') =>
    run({ model: model ?? undefined, operation, args, query: async (result: any) => result });
}

it('filters return lists and batch deletes to the Chinese company and assigns ownership on create/import', async () => {
  const run = fixture();
  await companyContext.run({ companyId: 2n, systemAdmin: false, warehouse: false, userId: 5n }, async () => {
    expect(await run('findMany', { take: 30 })).toMatchObject({ where: { AND: [{ companyId: 2n }] } });
    expect(await run('deleteMany', { where: { id: { in: [1n, 2n] } } }))
      .toMatchObject({ where: { id: { in: [1n, 2n] }, AND: [{ companyId: 2n }] } });
    expect(await run('create', { data: { senderName: 'A' } })).toMatchObject({ data: { companyId: 2n } });
    expect(await run('createMany', { data: [{ senderName: 'A' }, { senderName: 'B' }] }))
      .toMatchObject({ data: [{ companyId: 2n }, { companyId: 2n }] });
    await expect(run('create', { data: { companyId: 1n } })).rejects.toThrow('其他公司');
    const query = await run('queryRaw', Prisma.sql`SELECT id FROM return_records WHERE sender_name = ${'A'} LIMIT 100`, null);
    expect(query.sql).toContain('company_id = 2');
    expect(query.values).toEqual(['A']);
  });
});

it('leaves warehouse return lists, searches and deletes global even with a selected company', async () => {
  const run = fixture();
  await companyContext.run({ companyId: 2n, systemAdmin: false, warehouse: true, userId: 6n }, async () => {
    expect(await run('findMany', { take: 30 })).toEqual({ take: 30 });
    expect(await run('deleteMany', { where: { id: { in: [1n, 2n] } } }))
      .toEqual({ where: { id: { in: [1n, 2n] } } });
    const query = Prisma.sql`SELECT id FROM return_records WHERE sender_name = ${'A'}`;
    expect((await run('queryRaw', query, null)).sql).not.toContain('company_id');
  });
});
