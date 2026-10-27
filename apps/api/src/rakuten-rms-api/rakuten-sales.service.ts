import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, RakutenSalesSnapshot } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RakutenRmsApiClient } from './rakuten-rms-api.client';
import { RakutenRmsApiCryptoService } from './rakuten-rms-api-crypto.service';
import { parseRakutenSalesOrder, rakutenSalesRows } from './rakuten-sales';

function snapshotJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v));
}

@Injectable()
export class RakutenSalesService {
  private readonly logger = new Logger(RakutenSalesService.name);
  private readonly running = new Set<string>();
  constructor(private readonly prisma: PrismaService, private readonly client: RakutenRmsApiClient,
    private readonly crypto: RakutenRmsApiCryptoService) {}

  // Read-only RMS endpoints; never invoke warehouse import, shipping, inventory or mail.
  @Cron('0 10 3 * * *', { name: 'rakuten-sales-full', timeZone: 'Asia/Tokyo', waitForCompletion: true })
  async refreshHistory(): Promise<void> { await this.refreshAll(180); }

  @Cron('0 40 * * * *', { name: 'rakuten-sales-recent', timeZone: 'Asia/Tokyo', waitForCompletion: true })
  async refreshRecent(): Promise<void> { await this.refreshAll(7); }

  private async refreshAll(days: number): Promise<void> {
    const connections = await this.prisma.rakutenRmsConnection.findMany({ where: { status: 1, syncOrders: true } });
    for (const connection of connections) {
      if (this.running.has(connection.id.toString())) continue;
      const end = new Date();
      const start = new Date(end.getTime() - (connection.salesCoverageStart ? days : 180) * 86400000);
      try { await this.reconcile(connection.id, start, end); }
      catch (error) { this.logger.warn(`乐天销售对账失败：${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  async read(connectionId: bigint, start: Date, end: Date) {
    const connection = await this.prisma.rakutenRmsConnection.findUniqueOrThrow({ where: { id: connectionId } });
    const snapshots = await this.prisma.rakutenSalesSnapshot.findMany({
      where: { connectionId, orderedAt: { gte: start, lt: end } }, orderBy: [{ orderedAt: 'asc' }, { orderId: 'asc' }],
    });
    return { rows: rakutenSalesRows(snapshots),
      coverageStart: connection.salesCoverageStart?.toISOString() ?? null,
      coverageEnd: connection.salesCoverageEnd?.toISOString() ?? null,
      syncedAt: connection.lastSalesSyncedAt?.toISOString() ?? null,
      error: connection.lastSalesSyncError,
      ready: Boolean(connection.salesCoverageStart && connection.salesCoverageStart <= start
        && connection.salesCoverageEnd && connection.salesCoverageEnd >= new Date(Math.min(end.getTime(), Date.now() - 86400000))),
    };
  }

  async reconcile(connectionId: bigint, start: Date, end: Date, operatorId?: bigint, dryRun = false) {
    start = new Date(Math.floor(start.getTime() / 1000) * 1000);
    end = new Date(Math.floor(end.getTime() / 1000) * 1000);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end
      || end.getTime() - start.getTime() > 190 * 86400000 || end.getTime() > Date.now() + 1000) {
      throw new BadRequestException('销售对账日期无效，单次最多190天');
    }
    const key = connectionId.toString();
    if (this.running.has(key)) throw new ConflictException('此店铺销售对账正在进行');
    this.running.add(key);
    const startedAt = new Date();
    let actor = operatorId;
    try {
      const connection = await this.prisma.rakutenRmsConnection.findUniqueOrThrow({ where: { id: connectionId } });
      actor ??= (await this.prisma.user.findFirstOrThrow({ where: { status: 1, role: { in: ['admin', 'system_admin'] } }, orderBy: { id: 'asc' } })).id;
      const secret = this.crypto.decrypt(connection.encryptedServiceSecret, connection.serviceSecretIv, connection.serviceSecretAuthTag);
      const license = this.crypto.decrypt(connection.encryptedLicenseKey, connection.licenseKeyIv, connection.licenseKeyAuthTag);
      // All statuses and all purchased items, including items not handled by WMS.
      const searched = await this.client.searchOrders(secret, license, { start, end: new Date(end.getTime() - 1), dateType: 1 });
      const known = await this.prisma.rakutenSalesSnapshot.findMany({ where: { connectionId, orderedAt: { gte: start, lt: end } }, select: { orderId: true } });
      const ids = [...new Set([...searched, ...known.map((row) => row.orderId)])];
      const orders = await this.client.getOrders(secret, license, ids);
      const byId = new Map(orders.map((order) => [String(order.orderNumber), order]));
      if (ids.some((id) => !byId.has(id)) || byId.size !== ids.length || orders.length !== ids.length) {
        throw new Error('RMS销售订单响应不完整，未写入销售数据');
      }
      const facts = ids.map((id) => parseRakutenSalesOrder(byId.get(id)!));
      if (facts.some((row) => row.orderedAt < start || row.orderedAt >= end)) throw new Error('RMS销售订单日期超出请求范围');
      const active = facts.filter((row) => !['800', '900'].includes(row.orderProgress));
      const result = { fetched: facts.length, orderCount: active.length,
        salesAmount: active.reduce((sum, row) => sum + row.goodsAmount - row.couponAmount, 0), dryRun };
      if (dryRun) return result;
      await this.prisma.$transaction(async (tx) => {
        // Serialize writers; an older in-flight response must not overwrite a newer refresh.
        await tx.$queryRaw`SELECT id FROM rakuten_rms_connections WHERE id = ${connectionId} FOR UPDATE`;
        const current = await tx.rakutenRmsConnection.findUniqueOrThrow({ where: { id: connectionId } });
        if (current.lastSalesSyncedAt && current.lastSalesSyncedAt > startedAt) throw new ConflictException('较新的销售对账已完成，请重新对账');
        if (current.salesCoverageStart && current.salesCoverageEnd
          && (start > current.salesCoverageEnd || end < current.salesCoverageStart)) throw new BadRequestException('销售对账周期须与已有周期相接');
        const before = await tx.rakutenSalesSnapshot.findMany({ where: { connectionId, orderId: { in: ids } } });
        const existing = new Map(before.map((row) => [row.orderId, row]));
        const added = facts.filter((row) => !existing.has(row.orderId));
        for (let i = 0; i < added.length; i += 100) {
          await tx.rakutenSalesSnapshot.createMany({ data: added.slice(i, i + 100).map((row) => ({ ...row, connectionId,
            items: snapshotJson(row.items), syncedAt: startedAt })) });
        }
        const changed = facts.filter((row) => existing.has(row.orderId) && existing.get(row.orderId)!.contentHash !== row.contentHash);
        for (const row of changed) await tx.rakutenSalesSnapshot.update({ where: { connectionId_orderId: { connectionId, orderId: row.orderId } },
          data: { ...row, items: snapshotJson(row.items), syncedAt: startedAt } });
        const after = await tx.rakutenSalesSnapshot.findMany({ where: { connectionId, orderId: { in: [...added, ...changed].map((row) => row.orderId) } } });
        const auditRows = after.map((row: RakutenSalesSnapshot) => ({ entityType: 'rakuten_sales_snapshot', entityId: row.id,
          action: existing.has(row.orderId) ? 'update' as const : 'create' as const, eventType: 'rakuten_sales_reconciled' as const,
          operatorId: actor!, beforeData: existing.has(row.orderId) ? snapshotJson(existing.get(row.orderId)) : Prisma.JsonNull,
          afterData: snapshotJson(row), remark: 'RMS原订单销售对账；不改变仓库、库存、邮件或物流' }));
        for (let i = 0; i < auditRows.length; i += 100) await tx.operationAuditLog.createMany({ data: auditRows.slice(i, i + 100) });
        const state = { salesCoverageStart: current.salesCoverageStart && current.salesCoverageStart < start ? current.salesCoverageStart : start,
          salesCoverageEnd: current.salesCoverageEnd && current.salesCoverageEnd > end ? current.salesCoverageEnd : end,
          lastSalesSyncedAt: startedAt, lastSalesSyncError: null };
        await tx.rakutenRmsConnection.update({ where: { id: connectionId }, data: state });
        await tx.operationAuditLog.create({ data: { entityType: 'rakuten_sales_connection', entityId: connectionId,
          action: 'update', eventType: 'rakuten_sales_reconciled', operatorId: actor!,
          beforeData: snapshotJson({ salesCoverageStart: current.salesCoverageStart, salesCoverageEnd: current.salesCoverageEnd,
            lastSalesSyncedAt: current.lastSalesSyncedAt, lastSalesSyncError: current.lastSalesSyncError }),
          afterData: snapshotJson(state), remark: `销售对账${start.toISOString()}至${end.toISOString()}，${facts.length}单` } });
      }, { timeout: 120000, maxWait: 10000 });
      return result;
    } catch (error) {
      if (!dryRun && actor && !(error instanceof ConflictException)) await this.prisma.$transaction(async (tx) => {
        const old = await tx.rakutenRmsConnection.findUniqueOrThrow({ where: { id: connectionId } });
        const message = error instanceof Error ? error.message : String(error);
        await tx.rakutenRmsConnection.update({ where: { id: connectionId }, data: { lastSalesSyncError: message } });
        await tx.operationAuditLog.create({ data: { entityType: 'rakuten_sales_connection', entityId: connectionId,
          action: 'update', eventType: 'rakuten_sales_reconciled', operatorId: actor!,
          beforeData: { lastSalesSyncError: old.lastSalesSyncError }, afterData: { lastSalesSyncError: message }, remark: '销售对账失败，未推进完整覆盖周期' } });
      });
      throw error;
    } finally { this.running.delete(key); }
  }
}
