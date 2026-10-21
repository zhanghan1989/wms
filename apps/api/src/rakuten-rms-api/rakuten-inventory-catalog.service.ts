import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, RakutenInventoryCatalog, RakutenInventoryMapping, RakutenRmsConnection } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RakutenRmsApiClient } from './rakuten-rms-api.client';
import { RakutenRmsApiCryptoService } from './rakuten-rms-api-crypto.service';
import { inventoryKey, RakutenCatalogVariant } from './rakuten-inventory.types';

import { inventoryCombos, isInventoryCombo, validInventoryCombo } from './rakuten-inventory-combos';

const DAY_MS = 24 * 60 * 60_000;
const MATERIALS = ['肩带本体', '肩带配件'];
const chunks = <T>(rows: T[], size = 500): T[][] => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));
type Connection = RakutenRmsConnection & { shop: { name: string } };
type MatchRow = Pick<RakutenInventoryCatalog, 'hidden' | 'unlimitedStock' | 'salesStart' | 'salesEnd' | 'matchStatus' | 'productId'>;

export function catalogExclusion(row: Pick<MatchRow, 'hidden' | 'unlimitedStock' | 'salesStart' | 'salesEnd'>, now = new Date()): string | null {
  if (row.hidden) return '仓库/下架';
  if (row.unlimitedStock) return '未启用数量库存';
  if (row.salesStart && row.salesStart > now) return '尚未到销售时间';
  if (row.salesEnd && row.salesEnd < now) return '销售已结束';
  return null;
}

export function catalogCandidates(variant: Pick<RakutenCatalogVariant, 'merchantDefinedSkuId' | 'variantId'>, index: Map<string, Set<string>>, productIds = new Set<string>()): string[] {
  const primary = variant.merchantDefinedSkuId ? index.get(variant.merchantDefinedSkuId) : undefined;
  const candidates = new Set(primary?.size ? primary : index.get(variant.variantId) ?? []);
  if (productIds.has(variant.variantId)) candidates.add(variant.variantId);
  return [...candidates].sort();
}

@Injectable()
export class RakutenInventoryCatalogService {
  constructor(private readonly prisma: PrismaService, private readonly client: RakutenRmsApiClient, private readonly crypto: RakutenRmsApiCryptoService) {}

  isFresh(connection: RakutenRmsConnection) {
    return Boolean(connection.inventoryCatalogVersion && connection.inventoryCatalogRefreshedAt && connection.inventoryCatalogRefreshedAt.getTime() >= Date.now() - DAY_MS);
  }

  async queue(connectionId: bigint) {
    const existing = await this.prisma.rakutenInventoryCatalogJob.findFirst({ where: { connectionId, status: { in: ['queued', 'running'] } }, orderBy: { startedAt: 'desc' } });
    return existing ?? this.prisma.rakutenInventoryCatalogJob.create({ data: { id: randomUUID(), connectionId, status: 'queued', cursorMark: '*' } });
  }

  async needsRefresh(connection: RakutenRmsConnection) {
    if (!this.isFresh(connection)) return true;
    return Boolean(await this.prisma.rakutenInventoryCatalogJob.findFirst({ where: { connectionId: connection.id, status: { in: ['queued', 'running'] } }, select: { id: true } }));
  }

  async refresh(connection: Connection, renew: () => Promise<void>) {
    const job = await this.queue(connection.id);
    const credentials = [
      this.crypto.decrypt(connection.encryptedServiceSecret, connection.serviceSecretIv, connection.serviceSecretAuthTag),
      this.crypto.decrypt(connection.encryptedLicenseKey, connection.licenseKeyIv, connection.licenseKeyAuthTag),
    ] as const;
    await this.prisma.rakutenInventoryCatalogJob.update({ where: { id: job.id }, data: { status: 'running', error: null } });
    let cursor = job.cursorMark;
    let productCount = job.productCount;
    let expectedMinimum = job.productCount;
    const visited = new Set<string>();
    try {
      while (true) {
        await renew();
        if (visited.has(cursor)) throw new ServiceUnavailableException('商品搜索游标循环，未替换原有清单');
        visited.add(cursor);
        const page = await this.client.searchCatalogPage(...credentials, cursor);
        expectedMinimum = Math.max(expectedMinimum, page.numFound);
        if (!page.itemCount && page.nextCursorMark !== cursor) throw new ServiceUnavailableException('商品搜索空页未正常结束，未替换原有清单');
        const rows = await this.matchPage(connection, job.id, page.variants);
        await renew();
        // Cursor, staging rows and auto-mappings commit together. The visible
        // catalog version is switched only after a complete successful traversal.
        await this.prisma.$transaction(async (tx) => {
          for (const batch of chunks(rows)) {
            await tx.rakutenInventoryCatalog.createMany({ data: batch });
            const automatic = batch.filter((row) => row.matchStatus === 'matched' && row.productId);
            if (automatic.length) await tx.rakutenInventoryMapping.createMany({ data: automatic.map((row) => ({
              connectionId: connection.id, manageNumber: row.manageNumber, variantId: row.variantId,
              productId: row.productId!, safetyStock: 0, source: 'auto', enabled: true,
            })), skipDuplicates: true });
          }
          await tx.rakutenInventoryCatalogJob.update({ where: { id: job.id }, data: {
            cursorMark: page.nextCursorMark, productCount: { increment: page.itemCount }, skuCount: { increment: rows.length },
          } });
        }, { maxWait: 10000, timeout: 120000 });
        productCount += page.itemCount;
        if (page.nextCursorMark === cursor) {
          if (productCount < expectedMinimum) throw new ServiceUnavailableException('商品搜索提前结束、商品数不完整，未替换原有清单');
          break;
        }
        cursor = page.nextCursorMark;
      }
      await renew();
      await this.prisma.$transaction([
        this.prisma.rakutenRmsConnection.update({ where: { id: connection.id }, data: {
          inventoryCatalogVersion: job.id, inventoryCatalogRefreshedAt: new Date(), inventoryCatalogError: null,
        } }),
        this.prisma.rakutenInventoryCatalogJob.update({ where: { id: job.id }, data: { status: 'success', finishedAt: new Date() } }),
      ]);
      // Only superseded staging/snapshot rows are removed; mappings and run logs remain.
      await this.prisma.rakutenInventoryCatalog.deleteMany({ where: { connectionId: connection.id, version: { not: job.id }, createdAt: { lt: new Date(Date.now() - 2 * DAY_MS) } } }).catch(() => undefined);
      return job.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : '商品清单读取失败';
      await this.prisma.$transaction([
        this.prisma.rakutenInventoryCatalogJob.update({ where: { id: job.id }, data: { status: 'failed', error: message, finishedAt: new Date() } }),
        this.prisma.rakutenRmsConnection.update({ where: { id: connection.id }, data: { inventoryCatalogError: message } }),
      ]);
      throw error;
    }
  }

  private async matchPage(connection: Connection, version: string, variants: RakutenCatalogVariant[]) {
    const codes = [...new Set(variants.flatMap((row) => [row.merchantDefinedSkuId, row.variantId]).filter((value): value is string => Boolean(value)))];
    const index = new Map<string, Set<string>>();
    for (const batch of chunks(codes)) {
      const skus = await this.prisma.sku.findMany({ where: {
        status: 1, shop: connection.shop.name, productId: { not: null },
        masterProduct: { is: { status: 1, OR: [{ productType: null }, { productType: { notIn: MATERIALS } }] } },
        OR: [{ sku: { in: batch } }, { rbSku: { in: batch } }, { fbmSku: { in: batch } }],
      }, select: { sku: true, rbSku: true, fbmSku: true, productId: true } });
      for (const sku of skus) {
        for (const code of [sku.sku, sku.rbSku, sku.fbmSku]) {
          if (!code || !sku.productId) continue;
          const values = index.get(code) ?? new Set<string>();
          values.add(sku.productId); index.set(code, values);
        }
      }
    }
    // Query only this page's exact product IDs; JS equality protects against
    // case-insensitive database collations and never strips SKU prefixes.
    const productsById = new Map<string, { productId: string; status: number; productType: string | null }>();
    for (const batch of chunks([...new Set(variants.map((row) => row.variantId))])) {
      const products = await this.prisma.masterProduct.findMany({ where: { productId: { in: batch } },
        select: { productId: true, status: true, productType: true } });
      for (const product of products) if (batch.includes(product.productId)) productsById.set(product.productId, product);
    }
    const combos = await inventoryCombos(this.prisma, codes);
    const directIds = new Set([...productsById.keys()].filter((id) => !isInventoryCombo(id)));
    for (const [name, combo] of combos) if (validInventoryCombo(combo)) {
      directIds.add(name);
      const targets = index.get(name) ?? new Set<string>();
      targets.add(name); index.set(name, targets);
    }
    const existing = variants.length ? await this.prisma.rakutenInventoryMapping.findMany({ where: {
      connectionId: connection.id, manageNumber: { in: [...new Set(variants.map((row) => row.manageNumber))] },
    } }) : [];
    const mappings = new Map(existing.map((row) => [inventoryKey(row), row]));
    const manualIds = [...new Set(existing.filter((row) => row.source === 'manual').map((row) => row.productId))];
    const validManual = new Set<string>();
    for (const batch of chunks(manualIds)) {
      const products = await this.prisma.masterProduct.findMany({ where: { productId: { in: batch }, status: 1,
        OR: [{ productType: null }, { productType: { notIn: MATERIALS } }] }, select: { productId: true } });
      products.forEach((row) => validManual.add(row.productId));
    }
    const manualCombos = await inventoryCombos(this.prisma, manualIds);
    for (const id of manualIds.filter(isInventoryCombo)) {
      validManual.delete(id);
      const combo = manualCombos.get(id);
      if (combo && validInventoryCombo(combo)) validManual.add(id);
    }
    return variants.map((variant) => {
      const candidates = catalogCandidates(variant, index, directIds);
      const mapping = mappings.get(inventoryKey(variant));
      let productId = candidates.length === 1 ? candidates[0] : null;
      let matchStatus = candidates.length === 1 ? 'matched' : candidates.length ? 'ambiguous' : 'unmatched';
      const direct = productsById.get(variant.variantId);
      if (!isInventoryCombo(variant.variantId) && productId === variant.variantId && direct && (direct.status !== 1 || MATERIALS.includes(String(direct.productType ?? '').trim()))) {
        productId = null; matchStatus = 'excluded';
      }
      if ([variant.variantId, variant.merchantDefinedSkuId].some((code) => code && isInventoryCombo(code) && (!combos.has(code) || !validInventoryCombo(combos.get(code)!)))) {
        productId = null; matchStatus = 'unmatched';
      }
      if (mapping?.source === 'manual') {
        productId = validManual.has(mapping.productId) ? mapping.productId : null;
        matchStatus = productId ? 'manual' : 'invalid';
      } else if (mapping && matchStatus !== 'excluded' && mapping.productId !== productId) {
        productId = null; matchStatus = 'conflict';
      }
      return { connectionId: connection.id, version, manageNumber: variant.manageNumber, variantId: variant.variantId,
        merchantDefinedSkuId: variant.merchantDefinedSkuId, title: variant.title, hidden: variant.hidden,
        unlimitedStock: variant.unlimitedStock, salesStart: variant.salesStart ? new Date(variant.salesStart) : null,
        salesEnd: variant.salesEnd ? new Date(variant.salesEnd) : null,
        productId, matchStatus, candidates: candidates as Prisma.InputJsonValue };
    });
  }

  async scope(connection: Connection, mappings: RakutenInventoryMapping[]) {
    if (!this.isFresh(connection)) throw new ConflictException('请先刷新乐天商品清单；仅同步最近24小时成功读取的在售SKU');
    const eligible: RakutenInventoryMapping[] = [];
    const now = new Date();
    // Keep only one batch of catalog fields in memory. Titles/candidate JSON
    // from the entire shop are not needed to determine the sync scope.
    for (const batch of chunks(mappings.filter((mapping) => mapping.enabled))) {
      const rows = await this.prisma.rakutenInventoryCatalog.findMany({ where: {
        connectionId: connection.id, version: connection.inventoryCatalogVersion!,
        OR: batch.map(({ manageNumber, variantId }) => ({ manageNumber, variantId })),
      }, select: { manageNumber: true, variantId: true, merchantDefinedSkuId: true, title: true,
        hidden: true, unlimitedStock: true, salesStart: true, salesEnd: true, productId: true, matchStatus: true } });
      const byKey = new Map(rows.map((row) => [inventoryKey(row), row]));
      const accepted = batch.filter((mapping) => {
        const entry = byKey.get(inventoryKey(mapping));
        return entry && !catalogExclusion(entry, now) && entry.productId === mapping.productId && ['matched', 'manual'].includes(entry.matchStatus);
      });
      const automatic = accepted.filter((mapping) => mapping.source === 'auto');
      if (automatic.length) {
        const variants = automatic.map((mapping) => {
          const row = byKey.get(inventoryKey(mapping))!;
          return { ...row, salesStart: row.salesStart?.toISOString() ?? null, salesEnd: row.salesEnd?.toISOString() ?? null };
        });
        const checked = await this.matchPage(connection, connection.inventoryCatalogVersion!, variants);
        const byTarget = new Map(checked.map((row) => [inventoryKey(row), row]));
        if (automatic.some((mapping) => byTarget.get(inventoryKey(mapping))?.productId !== mapping.productId)) {
          throw new ConflictException('WMS自动对应关系已有变化，请刷新乐天清单并处理冲突后再同步');
        }
      }
      eligible.push(...accepted);
    }
    return eligible;
  }

  async summary(connection: RakutenRmsConnection, page = 1, issuesOnly = false, search = '', matchStatus = '', pageSize = 50) {
    const job = await this.prisma.rakutenInventoryCatalogJob.findFirst({ where: { connectionId: connection.id }, orderBy: { startedAt: 'desc' } });
    const base = { connectionId: connection.id, version: connection.inventoryCatalogVersion ?? '' };
    const now = new Date();
    const active: Prisma.RakutenInventoryCatalogWhereInput = { ...base, hidden: false, unlimitedStock: false,
      matchStatus: { not: 'excluded' }, AND: [
        { OR: [{ salesStart: null }, { salesStart: { lte: now } }] },
        { OR: [{ salesEnd: null }, { salesEnd: { gte: now } }] },
      ] };
    const where: Prisma.RakutenInventoryCatalogWhereInput = { ...(issuesOnly ? active : base),
      ...(issuesOnly ? { matchStatus: { notIn: ['matched', 'manual', 'excluded'] } } : {}),
      ...(['unmatched', 'ambiguous', 'conflict', 'invalid'].includes(matchStatus) ? { matchStatus } : {}),
      ...(search ? { OR: ['variantId', 'manageNumber', 'merchantDefinedSkuId', 'productId', 'title'].map((field) => ({ [field]: { contains: search } })) } : {}) };
    const excluded = await this.prisma.rakutenInventoryCatalog.count({ where: { ...base, NOT: active } });
    const [total, counts, rows] = await Promise.all([
      this.prisma.rakutenInventoryCatalog.count({ where }),
      this.prisma.rakutenInventoryCatalog.groupBy({ by: ['matchStatus'], where: active, _count: { _all: true } }),
      this.prisma.rakutenInventoryCatalog.findMany({ where, orderBy: { id: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    const mappings = rows.length ? await this.prisma.rakutenInventoryMapping.findMany({ where: { connectionId: connection.id,
      OR: rows.map((row) => ({ manageNumber: row.manageNumber, variantId: row.variantId })) },
      select: { manageNumber: true, variantId: true, safetyStock: true, enabled: true, source: true } }) : [];
    const mappingByKey = new Map(mappings.map((row) => [inventoryKey(row), row]));
    return { version: connection.inventoryCatalogVersion, refreshedAt: connection.inventoryCatalogRefreshedAt, error: connection.inventoryCatalogError,
      fresh: this.isFresh(connection), job, total, excluded, counts: Object.fromEntries(counts.map((row) => [row.matchStatus, row._count._all])), page, pageSize,
      rows: rows.map(({ id, connectionId, ...row }) => ({ ...row, id: id.toString(), connectionId: connectionId.toString(), exclusion: catalogExclusion(row), mapping: mappingByKey.get(inventoryKey(row)) ?? null })) };
  }
}
