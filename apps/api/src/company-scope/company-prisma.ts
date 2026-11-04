import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { companyContext } from './company-context';
import { scopeCompanySql } from './company-sql';

const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const scoped = new Set([...models.values()].filter((m) => m.fields.some((f) => f.name === 'companyId')).map((m) => m.name));
const tables = new Set([...models.values()].filter((m) => scoped.has(m.name)).map((m) => m.dbName ?? m.name));
type Args = Record<string, any>; // Prisma's dynamic middleware arguments span every generated model.
function copyArgs(value: any): any {
  if (Array.isArray(value)) return value.map(copyArgs);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyArgs(item)]));
  }
  return value;
}
function expandWhere(model: string, where: Args): Args {
  const result = { ...where };
  for (const fields of [...(models.get(model)?.uniqueFields ?? []), ...(models.get(model)?.primaryKey ? [models.get(model)!.primaryKey!.fields] : [])]) {
    const key = fields.join('_');
    if (result[key]) { Object.assign(result, result[key]); delete result[key]; }
  }
  return result;
}
const delegate = (client: PrismaClient, model: string): any => (client as any)[model[0].toLowerCase() + model.slice(1)];

const transactionContext = new AsyncLocalStorage<Prisma.TransactionClient>();

export function installCompanyIsolation(client: PrismaClient): PrismaClient {
  const lookup = async (model: string, where: Args): Promise<any> => {
    const context = companyContext.getStore();
    return companyContext.run({ systemAdmin: false, warehouse: false, userId: 0n, ...context, bypass: true },
      () => delegate((transactionContext.getStore() ?? client) as PrismaClient, model).findFirst({ where: expandWhere(model, where) }));
  };
  const nestedReads = (model: string, args: Args, companyId: bigint): void => {
    for (const container of [args.include, args.select]) {
      if (!container) continue;
      for (const field of models.get(model)?.fields ?? []) {
        if (field.kind !== 'object' || !container[field.name]) continue;
        if (container[field.name] === true) container[field.name] = {};
        const child = container[field.name];
        if (field.isList && scoped.has(field.type)) child.where = { AND: [child.where ?? {}, { companyId }] };
        nestedReads(field.type, child, companyId);
      }
      if (container._count?.select) {
        for (const [name, value] of Object.entries(container._count.select)) {
          const field = models.get(model)?.fields.find((f) => f.name === name);
          if (value && field && scoped.has(field.type)) container._count.select[name] = { where: { AND: [(value as Args).where ?? {}, { companyId }] } };
        }
      }
    }
  };

  const prepareData = async (model: string, data: Args, initial?: bigint): Promise<bigint | undefined> => {
    if (!data || typeof data !== 'object') return initial;
    const context = companyContext.getStore();
    let owner = initial;
    // Account affiliation is validated by UsersService; global warehouse/system
    // accounts must not inherit the currently selected business company.
    if (model === 'User') {
      if (context && !context.systemAdmin) {
        const expectedCompanyId = context.warehouse ? null : context.companyId;
        if (data.company || data.role === 'system_admin'
          || (data.companyId !== undefined && data.companyId !== expectedCompanyId)
          || (context.warehouse
            ? data.department !== undefined && data.department !== 'overseas_warehouse'
            : data.department === 'overseas_warehouse')) {
          throw new ForbiddenException('只有系统管理员可以修改跨公司归属');
        }
      }
      return owner;
    }
    const accept = (value: unknown): void => {
      if (value === undefined || value === null) return;
      const id = BigInt(String(value));
      if (owner !== undefined && owner !== id) throw new ForbiddenException('不能关联其他公司的数据');
      owner = id;
    };
    if (model === 'OperationAuditLog' && data.entityType && data.entityId) {
      const target = [...models.keys()].find((name) => name.replace(/[A-Z]/g, (letter, index) => (index ? '_' : '') + letter.toLowerCase()) === data.entityType);
      if (target && scoped.has(target)) {
        const row = await lookup(target, { id: data.entityId });
        if (row) accept(row.companyId);
      }
    }
    if (data.companyId !== undefined) {
      if (typeof data.companyId === 'object') throw new ForbiddenException('不能修改公司归属');
      accept(data.companyId);
    }
    for (const field of models.get(model)?.fields ?? []) {
      if (field.kind !== 'object' || !scoped.has(field.type) || field.type === 'User' || field.name === 'company') continue;
      const refs = field.relationFromFields ?? [];
      let where: Args | undefined;
      if (refs.length && refs.every((key) => data[key] !== undefined && data[key] !== null)) {
        where = Object.fromEntries(refs.map((key, i) => [field.relationToFields![i], data[key]]));
      }
      const connect = data[field.name]?.connect;
      if (connect) where = connect;
      if (where) {
        const row = await lookup(field.type, where);
        if (!row) throw new BadRequestException('关联数据不存在');
        accept(row.companyId);
      }
    }
    // Some legacy integrations use scalar keys instead of Prisma relations.
    for (const [key, target, targetKey] of [['rmsConnectionId','RakutenRmsConnection','id'], ['connectionId', model.startsWith('Amazon') ? 'AmazonSpApiConnection' : 'RakutenRmsConnection','id'], ['shop','Shop','name'], ['shopName','Shop','name']] as const) {
      if (data[key] === undefined || data[key] === null || data[key] === '' || typeof data[key] === 'object') continue;
      if (!models.get(model)?.fields.some((f) => f.name === key)) continue;
      const row = await lookup(target, { [targetKey]: data[key] });
      if (row) accept(row.companyId);
    }
    if (model === 'ManualOrderRecord' && data.rawPayload && typeof data.rawPayload === 'object') {
      const productId = data.rawPayload['产品ID'];
      if (typeof productId === 'string' && productId) {
        const product = await lookup('MasterProduct', { productId });
        if (product) accept(product.companyId);
      }
    }
    if (context?.warehouse && owner === undefined && model === 'RakutenComboProduct') {
      const items = data.items?.create ?? data.items?.createMany?.data ?? [];
      for (const item of Array.isArray(items) ? items : [items]) {
        if (item.productId) {
          const product = await lookup('MasterProduct', { productId: item.productId });
          if (product) accept(product.companyId);
        }
      }
    }
    if (context?.warehouse && owner === undefined && model === 'MasterProduct' && data.bagBrand) {
      const brands = await delegate((transactionContext.getStore() ?? client) as PrismaClient, 'Brand').findMany({ where: { name: data.bagBrand }, select: { companyId: true }, take: 2 });
      if (brands.length > 1) throw new BadRequestException('品牌对应多个公司，请使用唯一的品牌名称');
      if (brands.length === 1) accept(brands[0].companyId);
    }
    if (scoped.has(model)) {
      if (owner === undefined && model === 'OperationAuditLog' && data.entityType === 'user') {
        data.companyId = null;
        return undefined;
      }
      if (owner === undefined && (!context || context.warehouse)) owner = 1n;
      if (owner === undefined) throw new BadRequestException('请先选择所属中国公司');
      const company = await lookup('Company', { id: owner, ...(model === 'OperationAuditLog' ? {} : { status: 1 }) });
      if (!company) throw new BadRequestException('公司不存在或已禁用');
      data.companyId = owner;
      if (data.company) throw new ForbiddenException('请通过公司编号指定归属');
      if (model === 'MasterProduct' && data.bagBrand) {
        const brand = await lookup('Brand', { companyId: owner, name: data.bagBrand });
        if (!brand) throw new BadRequestException('产品品牌不属于当前公司，请先新增品牌');
      }
    }
    for (const field of models.get(model)?.fields ?? []) {
      if (field.kind !== 'object' || !data[field.name]) continue;
      const value = data[field.name];
      for (const action of ['create','createMany','update','updateMany','upsert','connectOrCreate']) {
        const values = action === 'createMany' ? value[action]?.data : value[action];
        for (const child of values ? (Array.isArray(values) ? values : [values]) : []) {
          if (action === 'create' || action === 'createMany') await prepareData(field.type, child, owner);
          else if (action === 'upsert') {
            await prepareData(field.type, child.create, owner);
            await prepareData(field.type, child.update, owner);
          } else if (action === 'connectOrCreate') {
            // Prevent connectOrCreate's implicit lookup from crossing a company boundary.
            const row = await lookup(field.type, child.where);
            if (row && row.companyId !== owner) throw new ForbiddenException('不能关联其他公司的数据');
            await prepareData(field.type, child.create, owner);
          } else await prepareData(field.type, child.data ?? child, owner);
        }
      }
      // These nested operations have no independent middleware invocation.
      for (const action of ['connect','set','delete','deleteMany','disconnect','update','updateMany','upsert']) {
        const values = value[action];
        for (const child of values ? (Array.isArray(values) ? values : [values]) : []) {
          if (!scoped.has(field.type) || field.type === 'User') continue;
          const where = child.where ?? child;
          if (typeof where !== 'object') continue;
          const rows = await companyContext.run({ systemAdmin: false, warehouse: false, userId: 0n, ...context, bypass: true },
            () => delegate((transactionContext.getStore() ?? client) as PrismaClient, field.type).findMany({ where, select: { companyId: true } }));
          if (rows.some((r: any) => r.companyId !== owner)) throw new ForbiddenException('不能操作其他公司的关联数据');
        }
      }
    }
    return owner;
  };

  const middleware = async (params: { model?: string; action: string; args: Args }, next: (params: { args: Args }) => Promise<any>): Promise<any> => {
    const context = companyContext.getStore();
    if (context?.bypass) return next(params);
    const args = params.model ? copyArgs(params.args ?? {}) : Array.isArray(params.args) ? [...params.args] : params.args;
    params.args = args;
    const companyId = context?.warehouse && !context.systemAdmin ? undefined : context?.companyId;
    if (!params.model) {
      if (companyId !== undefined && /Raw/.test(params.action)) {
        if (Array.isArray(args)) {
          args[0] = scopeCompanySql(args[0], companyId, tables, /execute/i.test(params.action));
        } else {
          const marker = '__WMS_BOUND_VALUE__';
          const sql = scopeCompanySql(args.strings.join(marker), companyId, tables, /execute/i.test(params.action));
          params.args = Prisma.sql(sql.split(marker), ...args.values);
        }
      }
      return next(params);
    }
    const model = params.model;
    if (companyId !== undefined) nestedReads(model, args, companyId);
    if (model === 'Company' && context && !context.systemAdmin) {
      if (!['findMany','findFirst','findUnique','count'].includes(params.action)) throw new ForbiddenException('只有系统管理员可以管理公司');
      if (!context.warehouse) args.where = { ...args.where, id: companyId };
    }
    if (!scoped.has(model)) {
      if (context && ['create','update','upsert'].includes(params.action)
        && models.get(model)?.fields.some((field) => field.kind === 'object' && scoped.has(field.type)
          && (args.data?.[field.name] || args.create?.[field.name] || args.update?.[field.name]))) {
        await prepareData(model, args.data ?? args.create, companyId);
        if (args.update) await prepareData(model, args.update, companyId);
      }
      return next(params);
    }
    const ownUserRead = model === 'User' && args.where?.id === context?.userId
      && ['findUnique','findFirst'].includes(params.action);
    // Warehouse business access spans companies, but account management is
    // restricted to the Japan warehouse's own affiliation, regardless of selector.
    const warehouseUser = model === 'User' && context?.warehouse && !context.systemAdmin;
    if (warehouseUser && !['create', 'createMany'].includes(params.action)) {
      args.where = { ...args.where, AND: [...(args.where?.AND ? (Array.isArray(args.where.AND) ? args.where.AND : [args.where.AND]) : []), { companyId: null, department: 'overseas_warehouse', role: { not: 'system_admin' } }] };
    }
    if (model === 'User' && !['create','createMany'].includes(params.action) && context && !context.systemAdmin && !context.warehouse && !ownUserRead) {
      args.where = { ...args.where, AND: [...(args.where?.AND ? (Array.isArray(args.where.AND) ? args.where.AND : [args.where.AND]) : []), { department: { not: 'overseas_warehouse' }, role: { not: 'system_admin' } }] };
    }
    if (companyId !== undefined && !ownUserRead && !warehouseUser && !['create','createMany'].includes(params.action)) {
      // Prisma extendedWhereUnique requires unique fields at the top level.
      args.where = { ...args.where, AND: [...(args.where?.AND ? (Array.isArray(args.where.AND) ? args.where.AND : [args.where.AND]) : []), { companyId }] };
    }
    if (['create','createMany','update','updateMany','upsert'].includes(params.action)) {
      let owner = companyId;
      if (['update','upsert'].includes(params.action)) {
        const row = await lookup(model, args.where);
        if (row) owner = row.companyId;
      }
      if (params.action === 'updateMany' && owner === undefined) {
        const rows = await delegate((transactionContext.getStore() ?? client) as PrismaClient, model).findMany({ where: args.where, select: { companyId: true } });
        for (const id of new Set<bigint>(rows.map((r: any) => r.companyId))) {
          await prepareData(model, { ...args.data }, id);
        }
        if (args.data.companyId !== undefined) throw new ForbiddenException('不能批量修改公司归属');
        return next(params);
      }
      if (params.action === 'upsert') {
        await prepareData(model, args.create, owner);
        await prepareData(model, args.update, owner);
      } else {
        for (const row of Array.isArray(args.data) ? args.data : [args.data]) {
          // Background legacy creates remain in company 1 only when no association supplies ownership.
          await prepareData(model, row, owner);
        }
      }
    }
    return next(params);
  };
  const extended = client.$extends({ query: { $allOperations({ model, operation, args, query }) {
    return middleware({ model, action: operation, args: args as Args }, (params) => query(params.args as never));
  } } }) as unknown as PrismaClient;
  return new Proxy(extended, { get(target, property, receiver) {
    if (property === '$transaction') {
      return (work: any, options?: any) => typeof work === 'function'
        ? target.$transaction((tx) => transactionContext.run(tx, () => work(tx)), options)
        : target.$transaction(work, options);
    }
    return Reflect.get(target, property, receiver);
  } });
}
