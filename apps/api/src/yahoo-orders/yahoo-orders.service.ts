import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, YahooOrderConnection } from '@prisma/client';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { companyContext } from '../company-scope/company-context';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeYahooPublicKey, YahooCredentials, YahooOrder, YahooOrdersClient, YahooRequestError, yahooItems } from './yahoo-orders.client';

type Connection = YahooOrderConnection & { shop: { name: string; status: number; platformDefinition: { name: string } } };
type SyncIssue = { orderId: string; message: string };
type SyncResult = { matched: number; imported: number; skipped: number; issueCount: number; issues: SyncIssue[] };
type Authorization = { credentials: YahooCredentials; verifier: string };

const connectionId = 1;
const shopInclude = { shop: { select: { name: true, status: true, platformDefinition: { select: { name: true } } } } } as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const minutes = 60000;
const days = 24 * 60 * minutes;

function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}

function unseal<T>(value: string): T {
  try {
    const [iv, tag, ciphertext] = value.split('.').map(part => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as T;
  } catch {
    throw new YahooRequestError('Yahoo 凭证无法读取，请重新授权');
  }
}

function encryptionKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new YahooRequestError('WMS 未配置服务端凭证加密密钥');
  return createHmac('sha256', secret).update('wms/yahoo-orders/credentials/v1').digest();
}

function required(value: unknown, pattern: RegExp, name: string): string {
  if (typeof value !== 'string' || !pattern.test(value.trim())) throw new BadRequestException(name + '格式无效');
  return value.trim();
}

function errorMessage(error: unknown): string {
  if (error instanceof YahooRequestError || error instanceof BadRequestException || error instanceof ConflictException) {
    return error.message.slice(0, 255);
  }
  return 'WMS 无法完成雅虎订单处理，请查看应用日志';
}

@Injectable()
export class YahooOrdersService {
  private readonly logger = new Logger(YahooOrdersService.name);

  constructor(private readonly db: PrismaService, private readonly orders: OrdersService, private readonly client: YahooOrdersClient) {}

  async status() {
    const row = await this.db.yahooOrderConnection.findUnique({ where: { id: connectionId }, include: shopInclude });
    return {
      shopId: row?.shopId.toString(), shopName: row?.shop.name, sellerId: row?.sellerId, importFrom: row?.importFrom,
      authorized: Boolean(row?.credentials), enabled: row?.enabled ?? false, proxyConfigured: this.client.proxyConfigured,
      running: Boolean(row?.lockedUntil && row.lockedUntil > new Date()), lastCheckedAt: row?.lastCheckedAt,
      lastError: row?.lastError, lastResult: row?.lastResult, callbackUrl: this.client.callbackUrl,
    };
  }

  async listOrders(limit?: string, offset?: string): Promise<unknown[]> {
    const shops = await this.db.shop.findMany({
      where: { platformDefinition: { name: 'yahoo' } }, select: { name: true },
    });
    return this.orders.listAmazonManualOrders(limit, offset, {
      OR: [{ mallName: 'yahoo' }, { shopName: { in: shops.map(shop => shop.name) } }],
    });
  }

  async startAuthorization(input: Record<string, unknown>) {
    if (!this.client.proxyConfigured) throw new BadRequestException('飞牛 OS 日本出口未配置');
    const shopId = BigInt(required(input.shopId, /^[1-9]\d{0,18}$/, '店铺'));
    const sellerId = required(input.sellerId, /^[a-zA-Z0-9_-]{1,50}$/, 'Seller ID');
    const clientId = required(input.clientId, /^[A-Za-z0-9._~-]{8,512}$/, 'Client ID');
    const clientSecret = required(input.clientSecret, /^[A-Za-z0-9._~-]{8,512}$/, 'Client Secret');
    const keyVersion = required(input.keyVersion, /^[1-9]\d{0,9}$/, '公开密钥版本');
    const date = required(input.importFrom, /^\d{4}-\d{2}-\d{2}$/, '导入起始日期');
    const importFrom = new Date(date + 'T00:00:00+09:00');
    if (!Number.isFinite(importFrom.getTime()) || new Date(importFrom.getTime() + 9 * 60 * minutes).toISOString().slice(0, 10) !== date ||
        importFrom.getTime() > Date.now() || importFrom.getTime() < Date.now() - 90 * days) {
      throw new BadRequestException('请选择最近 90 天内的导入起始日期（日本时间）');
    }
    const shop = await this.db.shop.findUnique({ where: { id: shopId }, include: { platformDefinition: true } });
    if (!shop || shop.status !== 1 || !/^yahoo$/i.test(shop.platformDefinition.name.trim())) {
      throw new BadRequestException('请选择已启用的 Yahoo 店铺');
    }
    let publicKey: string;
    try {
      publicKey = normalizeYahooPublicKey(required(input.publicKey, /^[\s\S]{100,4096}$/, '公开密钥'));
    } catch (error) {
      throw new BadRequestException(errorMessage(error));
    }
    const state = randomBytes(32).toString('hex');
    const verifier = randomBytes(48).toString('base64url');
    const authorization = {
      authStateHash: hash(state), authExpiresAt: new Date(Date.now() + 10 * minutes),
      pendingAuth: seal({ credentials: { clientId, clientSecret, publicKey, keyVersion }, verifier }),
      enabled: false, importFrom, lastError: null, lastResult: Prisma.DbNull,
    };
    const where = { id: connectionId, OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }] };
    const existing = await this.db.yahooOrderConnection.findUnique({ where: { id: connectionId } });
    if (existing && (existing.shopId !== shopId || existing.sellerId !== sellerId)) {
      throw new BadRequestException('已有 Yahoo 店铺连接。请使用相同店铺及 Seller ID 重新授权');
    }
    if (existing) {
      const changed = await this.db.yahooOrderConnection.updateMany({ where, data: authorization });
      if (!changed.count) throw new ConflictException('雅虎后台正在查询，请稍后再试');
    } else {
      await this.db.yahooOrderConnection.create({ data: { id: connectionId, shopId, sellerId, ...authorization } });
    }
    return { state, url: this.client.authorizationUrl(clientId, state, Buffer.from(hash(verifier), 'hex').toString('base64url')) };
  }

  async completeAuthorization(state: string, code: string, cookie: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(state) || state !== cookie || !/^[A-Za-z0-9._~-]{1,4096}$/.test(code)) return false;
    const token = randomUUID();
    const row = await this.db.yahooOrderConnection.findUnique({ where: { id: connectionId } });
    if (!row?.pendingAuth || row.authStateHash !== hash(state) || !row.authExpiresAt || row.authExpiresAt <= new Date()) return false;
    const claimed = await this.db.yahooOrderConnection.updateMany({
      where: { id: connectionId, authStateHash: row.authStateHash, authExpiresAt: { gt: new Date() } },
      data: { authStateHash: null, pendingAuth: null, authExpiresAt: null, lockToken: token, lockedUntil: new Date(Date.now() + minutes) },
    });
    if (!claimed.count) return false;
    try {
      const pending = unseal<Authorization>(row.pendingAuth);
      const credential = await this.client.exchange(pending.credentials, {
        grant_type: 'authorization_code', redirect_uri: this.client.callbackUrl, code, code_verifier: pending.verifier,
      });
      await this.db.yahooOrderConnection.updateMany({
        where: { id: connectionId, lockToken: token }, data: { credentials: seal(credential), lastError: null },
      });
      return true;
    } catch (error) {
      await this.db.yahooOrderConnection.updateMany({
        where: { id: connectionId, lockToken: token }, data: { lastError: errorMessage(error) },
      });
      return false;
    } finally {
      await this.release(token);
    }
  }

  async test() {
    return this.run('test');
  }

  async setEnabled(enabled: boolean) {
    if (!enabled) {
      await this.db.yahooOrderConnection.updateMany({ where: { id: connectionId }, data: { enabled: false } });
      return this.status();
    }
    await this.run('enable');
    return this.status();
  }

  async syncNow() {
    return this.run('sync');
  }

  @Cron('0 */20 * * * *', { name: 'yahoo-order-sync', timeZone: 'Asia/Tokyo' })
  async scheduledSync(): Promise<void> {
    try {
      const row = await this.db.yahooOrderConnection.findUnique({ where: { id: connectionId }, select: { enabled: true } });
      if (row?.enabled) await this.run('sync');
    } catch (error) {
      if (!(error instanceof ConflictException)) this.logger.warn(errorMessage(error));
    }
  }

  private async run(mode: 'test' | 'enable' | 'sync') {
    const token = randomUUID();
    const claimed = await this.db.yahooOrderConnection.updateMany({
      where: {
        id: connectionId, credentials: { not: null }, ...(mode === 'sync' ? { enabled: true } : {}),
        AND: [
          { OR: [{ authExpiresAt: null }, { authExpiresAt: { lte: new Date() } }] },
          { OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }] },
        ],
      },
      data: { lockToken: token, lockedUntil: new Date(Date.now() + 9 * minutes) },
    });
    if (!claimed.count) throw new ConflictException('雅虎订单未授权、未开启或另一项查询正在运行');
    try {
      const row = await this.db.yahooOrderConnection.findUniqueOrThrow({ where: { id: connectionId }, include: shopInclude });
      if (row.shop.status !== 1 || !/^yahoo$/i.test(row.shop.platformDefinition.name.trim())) {
        throw new YahooRequestError('雅虎店铺已停用或平台已变更');
      }
      const signal = AbortSignal.timeout(8 * minutes);
      let credential = unseal<YahooCredentials>(row.credentials!);
      if (!credential.accessToken || (credential.accessUntil ?? 0) < Date.now() + 9 * minutes) {
        credential = await this.client.exchange(credential, { grant_type: 'refresh_token', refresh_token: credential.refreshToken! }, signal);
        await this.db.yahooOrderConnection.updateMany({ where: { id: connectionId, lockToken: token }, data: { credentials: seal(credential) } });
      }
      const to = new Date();
      const since = new Date(Math.max(to.getTime() - 90 * days, row.importFrom.getTime()));
      const first = await this.client.list(row.sellerId, credential, since, to, 1, mode === 'sync' ? 100 : 1, signal);
      const result: SyncResult = { matched: first.total, imported: 0, skipped: 0, issueCount: 0, issues: [] };
      if (mode === 'sync') {
        await this.importOrders(row, token, credential, first, since, to, signal, result);
      } else if (first.ids.length) {
        await this.client.detail(row.sellerId, credential, first.ids[0], signal);
      }
      await this.db.yahooOrderConnection.updateMany({
        where: { id: connectionId, lockToken: token },
        data: {
          ...(mode === 'enable' ? { enabled: true } : {}),
          lastCheckedAt: new Date(), lastError: null,
          ...(mode !== 'test' ? { lastResult: result } : {}),
        },
      });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      await this.db.yahooOrderConnection.updateMany({
        where: { id: connectionId, lockToken: token }, data: { lastCheckedAt: new Date(), lastError: message },
      });
      throw new BadRequestException(message);
    } finally {
      await this.release(token);
    }
  }

  private release(token: string) {
    return this.db.yahooOrderConnection.updateMany({
      where: { id: connectionId, lockToken: token }, data: { lockToken: null, lockedUntil: null },
    });
  }

  private async importOrders(row: Connection, token: string, credential: YahooCredentials, first: { total: number; ids: string[] },
    since: Date, to: Date, signal: AbortSignal, result: SyncResult) {
    const ids = new Set(first.ids);
    for (let offset = 101; offset <= first.total; offset += 100) {
      await delay(1050, undefined, { signal });
      const page = await this.client.list(row.sellerId, credential, since, to, offset, 100, signal);
      if (page.total !== first.total || page.ids.some(id => ids.has(id))) {
        throw new YahooRequestError('Yahoo 查询期间订单列表发生变化，将在下一轮重试');
      }
      for (const id of page.ids) ids.add(id);
    }
    if (ids.size !== first.total) throw new YahooRequestError('Yahoo 订单搜索结果包含重复订单');
    const idsList = [...ids];
    for (let offset = 0; offset < idsList.length; offset += 100) {
      const group = idsList.slice(offset, offset + 100);
      const existing = await this.db.manualOrderRecord.findMany({
        where: { orderId: { in: group }, shopName: row.shop.name }, select: { orderId: true }, distinct: ['orderId'],
      });
      const saved = new Set(existing.map(x => x.orderId));
      for (const orderId of group) {
        signal.throwIfAborted();
        if (saved.has(orderId)) {
          result.skipped++;
          continue;
        }
        const active = await this.db.yahooOrderConnection.count({ where: { id: connectionId, lockToken: token, enabled: true } });
        if (!active) return;
        await delay(1050, undefined, { signal });
        const order = await this.client.detail(row.sellerId, credential, orderId, signal);
        try {
          const items = await this.mapOrder(row, orderId, order);
          if (!items) {
            result.skipped++;
            continue;
          }
          await companyContext.run({ systemAdmin: true, warehouse: false, japanOperations: true, userId: 0n },
            () => this.orders.batchCreateAmazonManualOrders({ items }, 'yahoo_api'));
          result.imported++;
        } catch (error) {
          if (error instanceof ConflictException && await this.db.manualOrderRecord.count({ where: { orderId, shopName: row.shop.name } })) {
            result.skipped++;
            continue;
          }
          result.issueCount++;
          if (result.issues.length < 100) result.issues.push({ orderId, message: errorMessage(error) });
        }
      }
    }
  }

  private async mapOrder(row: Connection, orderId: string, order: YahooOrder) {
    const ship = order.Ship;
    if (order.OrderStatus !== '2' || ship?.ShipStatus !== '1' || order.Suspect === '1' ||
        (order.IsLineGiftOrder === 'true' && order.IsLineGiftShippable !== 'true')) return null;

    const recipientName = [ship.ShipLastName, ship.ShipFirstName].map(s => s?.trim()).filter(Boolean).join(' ');
    if (!recipientName || !ship.ShipPhoneNumber || !ship.ShipZipCode || !ship.ShipPrefecture || !ship.ShipCity || !ship.ShipAddress1) {
      throw new YahooRequestError('配送地址或收件信息不全');
    }
    if (ship.ReceiveSatelliteType && ship.ReceiveSatelliteType !== '0') {
      throw new YahooRequestError('此单含自提要求，请人工核对');
    }
    const requestedDate = ship.ShipRequestDate?.trim();
    const deliveryDateRaw = requestedDate && !['0', '指定なし', 'なし'].includes(requestedDate)
      ? requestedDate.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null;
    const requestedTime = ship.ShipRequestTime?.normalize('NFKC').trim();
    const deliveryTimeSlot = requestedTime === '午前中' ? '0812'
      : requestedTime && !['0', '指定なし', 'なし'].includes(requestedTime)
        ? requestedTime.replace(/^(\d{1,2}):00\s*[-~〜～]\s*(\d{1,2}):00$/,
          (_, start: string, end: string) => start.padStart(2, '0') + end.padStart(2, '0'))
        : null;
    const lines = yahooItems(order);
    if (!lines.length) throw new YahooRequestError('Yahoo 订单明细为空');
    const codes = lines.map(item => item.SubCode?.trim() || item.ItemId?.trim() || '');
    const skuRows = await this.db.sku.findMany({
      where: { sku: { in: [...new Set(codes)] }, shop: row.shop.name, status: 1, productId: { not: null } },
      select: { sku: true, productId: true },
    });
    const mapping = new Map(skuRows.map(sku => [sku.sku, sku.productId!]));
    const missing = [...new Set(codes.filter(code => !mapping.has(code)))];
    if (missing.length) throw new YahooRequestError('未匹配店铺 SKU：' + missing.map(code => code || '空编码').join('、'));
    return lines.map((item, index) => {
      const orderItemId = item.LineId?.trim();
      const quantityPurchased = Number(item.Quantity);
      if (!orderItemId || !Number.isSafeInteger(quantityPurchased) || quantityPurchased <= 0) {
        throw new YahooRequestError('Yahoo 明细号或商品数量无效');
      }
      return {
        orderId, orderItemId, sku: codes[index], productId: mapping.get(codes[index])!, quantityPurchased,
        productName: item.Title, mallName: row.shop.platformDefinition.name, shopName: row.shop.name, recipientName,
        buyerPhoneNumber: ship.ShipPhoneNumber, shipPostalCode: ship.ShipZipCode, shipState: ship.ShipPrefecture,
        shipAddress1: ship.ShipCity, shipAddress2: ship.ShipAddress1, shipAddress3: ship.ShipAddress2,
        yahooOrderTime: order.OrderTime, deliveryDateRaw, deliveryTimeSlot,
      };
    });
  }
}
