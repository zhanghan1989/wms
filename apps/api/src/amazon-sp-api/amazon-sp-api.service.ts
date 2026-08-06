import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  AmazonOrderRecord,
  AmazonSpApiConnection,
  AmazonSpApiSyncStatus,
  AmazonSpApiSyncType,
  Prisma,
} from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { parseId } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { AmazonSpApiClient } from './amazon-sp-api.client';
import { AmazonSpApiCryptoService } from './amazon-sp-api-crypto.service';
import { AmazonOrderItemPayload, AmazonOrderPayload, AmazonSpApiRegion } from './amazon-sp-api.types';
import { buildAmazonStoreDashboard } from './amazon-store-dashboard';
import { ContinueAmazonAppstoreOAuthDto } from './dto/continue-amazon-appstore-oauth.dto';
import { StartAmazonOAuthDto } from './dto/start-amazon-oauth.dto';
import { SyncAmazonConnectionDto } from './dto/sync-amazon-connection.dto';
import { UpdateAmazonConnectionDto } from './dto/update-amazon-connection.dto';

const AMAZON_SYNC_CRON = process.env.AMAZON_SP_API_SYNC_CRON || '0 0 11 * * *';
const AMAZON_SYNC_TIMEZONE = process.env.AMAZON_SP_API_SYNC_TIMEZONE || 'Asia/Shanghai';
const AMAZON_SCHEDULED_SYNC_ENABLED =
  String(process.env.AMAZON_SP_API_SCHEDULED_SYNC_ENABLED ?? 'false').toLowerCase() === 'true';
const DEFAULT_LOOKBACK_DAYS = 90;
const ORDER_SYNC_OVERLAP_MS = 6 * 60 * 60 * 1000;
const DISPATCH_OVERSEAS = 'overseas';
const DISPATCH_CHINA_NO_STOCK = 'china_no_stock';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_AUTHORIZATION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const AMAZON_CALLBACK_PATH_PREFIX = '/apps/authorize/confirm/';
const AMAZON_DOMAIN_SUFFIXES = [
  'amazon.com',
  'amazon.ca',
  'amazon.com.mx',
  'amazon.com.br',
  'amazon.co.uk',
  'amazon.de',
  'amazon.fr',
  'amazon.it',
  'amazon.es',
  'amazon.nl',
  'amazon.se',
  'amazon.pl',
  'amazon.com.be',
  'amazon.co.jp',
  'amazon.com.au',
  'amazon.in',
  'amazon.sg',
  'amazon.ae',
  'amazon.sa',
  'amazon.com.tr',
  'amazon.eg',
];

interface SyncCounters {
  fetched: number;
  created: number;
  updated: number;
  frozen: number;
  excluded: number;
}

interface AmazonSyncResult {
  runId: string;
  status: AmazonSpApiSyncStatus;
  syncType: AmazonSpApiSyncType;
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  frozenCount: number;
  excludedCount: number;
  errors: string[];
}

interface AmazonAllConnectionsSyncResult {
  connectionCount: number;
  completedCount: number;
  skippedCount: number;
  partialCount: number;
  failedCount: number;
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  frozenCount: number;
  excludedCount: number;
  results: Array<{
    connectionId: string;
    shopName: string;
    status: AmazonSpApiSyncStatus | 'skipped';
    fetchedCount: number;
    createdCount: number;
    updatedCount: number;
    frozenCount: number;
    excludedCount: number;
    errors: string[];
  }>;
}

@Injectable()
export class AmazonSpApiService {
  private readonly logger = new Logger(AmazonSpApiService.name);
  private readonly runningConnections = new Set<string>();
  private lastAllSyncStartedAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AmazonSpApiClient,
    private readonly cryptoService: AmazonSpApiCryptoService,
  ) {}

  async listConnections(): Promise<unknown[]> {
    const rows = await this.prisma.amazonSpApiConnection.findMany({
      include: { shop: { select: { id: true, name: true, status: true } } },
      orderBy: [{ status: 'desc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.serializeConnection(row));
  }

  async startOAuth(payload: StartAmazonOAuthDto, createdBy: bigint): Promise<{
    authorizationUrl: string;
    expiresAt: string;
  }> {
    const { rawState, expiresAt } = await this.createOAuthState(payload, createdBy);
    return {
      authorizationUrl: this.buildAuthorizationUrl(rawState),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async continueAppstoreOAuth(
    payload: ContinueAmazonAppstoreOAuthDto,
    createdBy: bigint,
  ): Promise<{ amazonConfirmationUrl: string; expiresAt: string }> {
    const callbackUrl = this.validateAmazonCallbackUri(payload.amazonCallbackUri);
    const amazonState = String(payload.amazonState ?? '').trim();
    const expectedSellerId = String(payload.sellingPartnerId ?? '').trim();
    if (!amazonState || !expectedSellerId) {
      throw new BadRequestException('Amazon应用商店授权参数不完整');
    }

    const shopId = parseId(payload.shopId, 'shopId');
    const existingForShop = await this.prisma.amazonSpApiConnection.findUnique({ where: { shopId } });
    if (existingForShop && existingForShop.sellerId !== expectedSellerId) {
      throw new ConflictException('所选系统店铺已关联另一个Amazon Seller ID');
    }
    const existingForSeller = await this.prisma.amazonSpApiConnection.findFirst({
      where: { sellerId: expectedSellerId, NOT: { shopId } },
    });
    if (existingForSeller) {
      throw new ConflictException('该Amazon店铺已关联其他系统店铺，不能重复绑定');
    }

    const { rawState, expiresAt } = await this.createOAuthState(
      payload,
      createdBy,
      expectedSellerId,
    );
    callbackUrl.searchParams.set('amazon_state', amazonState);
    callbackUrl.searchParams.set('state', rawState);
    callbackUrl.searchParams.set('redirect_uri', this.getOAuthRedirectUri());
    if (payload.version === 'beta' || this.isDraftApplication()) {
      callbackUrl.searchParams.set('version', 'beta');
    }

    return {
      amazonConfirmationUrl: callbackUrl.toString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async completeOAuth(input: {
    state?: string;
    authorizationCode?: string;
    sellingPartnerId?: string;
  }): Promise<void> {
    const state = String(input.state ?? '').trim();
    const authorizationCode = String(input.authorizationCode ?? '').trim();
    const sellingPartnerId = String(input.sellingPartnerId ?? '').trim();
    if (!state || !authorizationCode || !sellingPartnerId) {
      throw new BadRequestException('Amazon OAuth回调参数不完整');
    }
    const stateHash = createHash('sha256').update(state).digest('hex');
    const pending = await this.prisma.amazonSpApiOAuthState.findUnique({ where: { stateHash } });
    if (!pending || pending.consumedAt || pending.expiresAt <= new Date()) {
      throw new BadRequestException('Amazon OAuth state无效或已过期，请重新发起授权');
    }
    if (pending.expectedSellerId && pending.expectedSellerId !== sellingPartnerId) {
      throw new BadRequestException('Amazon OAuth回调Seller ID与授权请求不一致');
    }
    const existing = await this.prisma.amazonSpApiConnection.findUnique({
      where: { shopId: pending.shopId },
    });
    if (existing && existing.sellerId !== sellingPartnerId) {
      throw new ConflictException('回调Seller ID与该系统店铺原授权不一致');
    }
    const duplicate = await this.prisma.amazonSpApiConnection.findFirst({
      where: { sellerId: sellingPartnerId, NOT: { shopId: pending.shopId } },
    });
    if (duplicate) {
      throw new ConflictException('该Amazon店铺已关联其他系统店铺，不能重复绑定');
    }
    const claimedAt = new Date();
    const claimed = await this.prisma.amazonSpApiOAuthState.updateMany({
      where: { id: pending.id, consumedAt: null, expiresAt: { gt: claimedAt } },
      data: { consumedAt: claimedAt },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException('Amazon OAuth state已被使用，请重新发起授权');
    }
    const redirectUri = this.getOAuthRedirectUri();
    const token = await this.client.exchangeAuthorizationCode(authorizationCode, redirectUri);
    const credential = this.cryptoService.encrypt(token.refreshToken);
    const authorizedAt = new Date();
    const authorizationExpiresAt = new Date(authorizedAt.getTime() + OAUTH_AUTHORIZATION_TTL_MS);
    await this.prisma.$transaction(async (tx) => {
      await tx.amazonSpApiConnection.upsert({
        where: { shopId: pending.shopId },
        create: {
          shopId: pending.shopId,
          sellerId: sellingPartnerId,
          region: pending.region,
          marketplaceIds: pending.marketplaceIds as Prisma.InputJsonValue,
          encryptedRefreshToken: credential.encryptedValue,
          tokenIv: credential.iv,
          tokenAuthTag: credential.authTag,
          authorizationMode: 'oauth',
          authorizedAt,
          authorizationExpiresAt,
          syncFbmOrders: pending.syncFbmOrders,
          syncFbaOrders: pending.syncFbaOrders,
          syncFbaInventory: pending.syncFbaInventory,
        },
        update: {
          region: pending.region,
          marketplaceIds: pending.marketplaceIds as Prisma.InputJsonValue,
          encryptedRefreshToken: credential.encryptedValue,
          tokenIv: credential.iv,
          tokenAuthTag: credential.authTag,
          authorizationMode: 'oauth',
          authorizedAt,
          authorizationExpiresAt,
          status: 1,
          syncFbmOrders: pending.syncFbmOrders,
          syncFbaOrders: pending.syncFbaOrders,
          syncFbaInventory: pending.syncFbaInventory,
          lastSyncError: null,
        },
      });
    });
  }

  async updateConnection(idRaw: string, payload: UpdateAmazonConnectionDto): Promise<unknown> {
    const id = parseId(idRaw, 'connectionId');
    const existing = await this.prisma.amazonSpApiConnection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Amazon SP-API连接不存在');

    const updated = await this.prisma.amazonSpApiConnection.update({
      where: { id },
      data: {
        ...(payload.region === undefined ? {} : { region: payload.region }),
        ...(payload.marketplaceIds === undefined
          ? {}
          : { marketplaceIds: this.normalizeMarketplaceIds(payload.marketplaceIds) }),
        ...(payload.status === undefined ? {} : { status: payload.status }),
        ...(payload.syncFbmOrders === undefined ? {} : { syncFbmOrders: payload.syncFbmOrders }),
        ...(payload.syncFbaOrders === undefined ? {} : { syncFbaOrders: payload.syncFbaOrders }),
        ...(payload.syncFbaInventory === undefined ? {} : { syncFbaInventory: payload.syncFbaInventory }),
      },
      include: { shop: { select: { id: true, name: true, status: true } } },
    });
    return this.serializeConnection(updated);
  }

  async testConnection(idRaw: string): Promise<{ success: true; marketplaces: unknown }> {
    const connection = await this.getConnection(idRaw);
    const accessToken = await this.getAccessToken(connection);
    const marketplaces = await this.client.testConnection(
      accessToken,
      this.normalizeRegion(connection.region),
    );
    return { success: true, marketplaces };
  }

  async syncConnection(idRaw: string, payload: SyncAmazonConnectionDto = {}): Promise<unknown> {
    const connection = await this.getConnection(idRaw);
    const key = connection.id.toString();
    if (this.runningConnections.has(key)) {
      throw new ConflictException('该店铺的Amazon同步任务正在运行');
    }
    this.runningConnections.add(key);
    try {
      const result = await this.runSync(
        connection,
        (payload.syncType ?? 'full') as AmazonSpApiSyncType,
        payload.initialLookbackDays ?? DEFAULT_LOOKBACK_DAYS,
      );
      if ((payload.syncType ?? 'full') === 'full' && result.status === AmazonSpApiSyncStatus.success) {
        await this.materializeDashboardSnapshotIfComplete();
      }
      return result;
    } finally {
      this.runningConnections.delete(key);
    }
  }

  async syncAllConnections(bypassCooldown = false): Promise<AmazonAllConnectionsSyncResult> {
    const now = Date.now();
    if (!bypassCooldown && now - this.lastAllSyncStartedAt < 60_000) {
      throw new ConflictException('订单拉取操作过于频繁，请在60秒后重试');
    }
    this.lastAllSyncStartedAt = now;
    const connections = await this.prisma.amazonSpApiConnection.findMany({
      where: { status: 1 },
      include: { shop: { select: { name: true } } },
      orderBy: { id: 'asc' },
    });
    const summary: AmazonAllConnectionsSyncResult = {
      connectionCount: connections.length,
      completedCount: 0,
      skippedCount: 0,
      partialCount: 0,
      failedCount: 0,
      fetchedCount: 0,
      createdCount: 0,
      updatedCount: 0,
      frozenCount: 0,
      excludedCount: 0,
      results: [],
    };
    for (const connection of connections) {
      const connectionId = connection.id.toString();
      if (this.runningConnections.has(connectionId)) {
        summary.skippedCount += 1;
        summary.results.push({
          connectionId,
          shopName: connection.shop.name,
          status: 'skipped',
          fetchedCount: 0,
          createdCount: 0,
          updatedCount: 0,
          frozenCount: 0,
          excludedCount: 0,
          errors: ['该店铺已有Amazon同步任务正在运行'],
        });
        continue;
      }
      this.runningConnections.add(connectionId);
      try {
        const result = await this.runSync(
          connection,
          AmazonSpApiSyncType.full,
          DEFAULT_LOOKBACK_DAYS,
        );
        summary.completedCount += 1;
        if (result.status === AmazonSpApiSyncStatus.partial) summary.partialCount += 1;
        if (result.status === AmazonSpApiSyncStatus.failed) summary.failedCount += 1;
        summary.fetchedCount += result.fetchedCount;
        summary.createdCount += result.createdCount;
        summary.updatedCount += result.updatedCount;
        summary.frozenCount += result.frozenCount ?? 0;
        summary.excludedCount += result.excludedCount ?? 0;
        summary.results.push({
          connectionId,
          shopName: connection.shop.name,
          status: result.status,
          fetchedCount: result.fetchedCount,
          createdCount: result.createdCount,
          updatedCount: result.updatedCount,
          frozenCount: result.frozenCount ?? 0,
          excludedCount: result.excludedCount ?? 0,
          errors: result.errors,
        });
      } catch (error) {
        summary.completedCount += 1;
        summary.failedCount += 1;
        summary.results.push({
          connectionId,
          shopName: connection.shop.name,
          status: AmazonSpApiSyncStatus.failed,
          fetchedCount: 0,
          createdCount: 0,
          updatedCount: 0,
          frozenCount: 0,
          excludedCount: 0,
          errors: [this.errorMessage(error)],
        });
      } finally {
        this.runningConnections.delete(connectionId);
      }
    }
    await this.materializeDashboardSnapshotIfComplete();
    return summary;
  }

  async listSyncRuns(connectionIdRaw?: string, limitRaw?: string): Promise<unknown[]> {
    const connectionId = connectionIdRaw ? parseId(connectionIdRaw, 'connectionId') : undefined;
    const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 200);
    const rows = await this.prisma.amazonSpApiSyncRun.findMany({
      where: connectionId ? { connectionId } : undefined,
      include: { connection: { include: { shop: { select: { name: true } } } } },
      orderBy: { id: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id.toString(),
      connectionId: row.connectionId.toString(),
      shopName: row.connection.shop.name,
      syncType: row.syncType,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      fetchedCount: row.fetchedCount,
      createdCount: row.createdCount,
      updatedCount: row.updatedCount,
      errorMessage: row.errorMessage,
    }));
  }

  async getCoverage(): Promise<unknown> {
    const rows = await this.prisma.amazonSpApiConnection.findMany({
      where: { status: 1 },
      include: { shop: { select: { name: true } } },
      orderBy: { id: 'asc' },
    });
    const staleBefore = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const shops = rows.map((row) => {
      const stale = !row.lastSuccessfulSyncAt || row.lastSuccessfulSyncAt < staleBefore;
      return {
        connectionId: row.id.toString(),
        shopName: row.shop.name,
        complete: !stale && !row.lastSyncError,
        stale,
        lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
        lastSyncError: row.lastSyncError,
      };
    });
    return {
      complete: shops.length > 0 && shops.every((row) => row.complete),
      activeShopCount: shops.length,
      healthyShopCount: shops.filter((row) => row.complete).length,
      shops,
    };
  }

  async getLatestDashboardSnapshot(): Promise<unknown> {
    const row = await this.prisma.fbaSalesSnapshot.findFirst({
      where: { fileName: { startsWith: 'Amazon SP-API' } },
      orderBy: { id: 'desc' },
      select: {
        id: true,
        fileName: true,
        periodStart: true,
        periodEnd: true,
        fbaRows: true,
        fbaOrderedQty: true,
        createdAt: true,
      },
    });
    return row
      ? {
          snapshotId: row.id.toString(),
          fileName: row.fileName,
          periodStart: row.periodStart?.toISOString().slice(0, 10) ?? null,
          periodEnd: row.periodEnd?.toISOString().slice(0, 10) ?? null,
          fbaRows: row.fbaRows,
          fbaOrderedQty: row.fbaOrderedQty,
          createdAt: row.createdAt.toISOString(),
        }
      : null;
  }

  async getStoreDashboard(connectionIdRaw?: string, daysRaw?: string): Promise<unknown> {
    const allowedDays = new Set([7, 30, 90]);
    const requestedDays = Number(daysRaw ?? 30);
    const days = allowedDays.has(requestedDays) ? requestedDays : 30;
    const connections = await this.prisma.amazonSpApiConnection.findMany({
      where: { status: 1 },
      include: { shop: { select: { id: true, name: true, status: true } } },
      orderBy: [{ shop: { name: 'asc' } }, { id: 'asc' }],
    });
    if (!connections.length) {
      return {
        generatedAt: new Date().toISOString(),
        days,
        shops: [],
        selectedShop: null,
        dashboard: null,
      };
    }

    const requestedConnectionId = connectionIdRaw ? parseId(connectionIdRaw, 'connectionId') : null;
    const connection = requestedConnectionId
      ? connections.find((row) => row.id === requestedConnectionId)
      : connections[0];
    if (!connection) throw new NotFoundException('所选Amazon店铺连接不存在或已停用');

    const now = new Date();
    const queryStart = new Date(now.getTime() - days * 2 * 24 * 60 * 60 * 1000);
    const [fbaOrders, fbmOrderRows, inventory, skus, latestRun] = await Promise.all([
      this.prisma.amazonFbaOrderItem.findMany({
        where: { connectionId: connection.id, purchaseDate: { gte: queryStart } },
        select: {
          amazonOrderId: true,
          sellerSku: true,
          asin: true,
          productName: true,
          orderStatus: true,
          quantityOrdered: true,
          quantityShipped: true,
          itemAmount: true,
          currency: true,
          purchaseDate: true,
        },
      }),
      this.prisma.amazonOrderRecord.findMany({
        where: {
          OR: [
            { spApiConnectionId: connection.id, sourceKind: 'sp_api' },
            { sourceKind: { not: 'sp_api' }, shopName: connection.shop.name },
          ],
        },
        select: {
          orderId: true,
          orderItemId: true,
          sku: true,
          productName: true,
          orderStatus: true,
          quantityPurchased: true,
          quantityShipped: true,
          quantityToShip: true,
          purchaseDateRaw: true,
          sourceKind: true,
          rawPayload: true,
        },
      }),
      this.prisma.amazonFbaInventoryItem.findMany({
        where: { connectionId: connection.id },
        select: {
          sellerSku: true,
          asin: true,
          productName: true,
          fulfillableQty: true,
          inboundWorkingQty: true,
          inboundShippedQty: true,
          inboundReceivingQty: true,
          reservedQty: true,
          unfulfillableQty: true,
          totalQty: true,
          snapshotAt: true,
        },
      }),
      this.prisma.sku.findMany({
        where: { shop: connection.shop.name, status: 1 },
        select: {
          sku: true,
          fbmSku: true,
          rbSku: true,
          asin: true,
          fnsku: true,
          productId: true,
          masterProduct: { select: { productName: true } },
        },
      }),
      this.prisma.amazonSpApiSyncRun.findFirst({
        where: { connectionId: connection.id },
        orderBy: { id: 'desc' },
        select: {
          id: true,
          syncType: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          fetchedCount: true,
          createdCount: true,
          updatedCount: true,
          errorMessage: true,
        },
      }),
    ]);

    const deduplicatedFbmOrders = new Map<string, (typeof fbmOrderRows)[number]>();
    for (const row of fbmOrderRows) {
      const orderId = String(row.orderId ?? '').trim();
      const originalItemId = this.getOriginalAmazonOrderItemId(row.rawPayload);
      const itemKey = originalItemId || String(row.orderItemId ?? '').trim() || this.normalizeSku(row.sku);
      const key = `${orderId}|${itemKey}`;
      const current = deduplicatedFbmOrders.get(key);
      if (!current || (row.sourceKind !== 'sp_api' && current.sourceKind === 'sp_api')) {
        deduplicatedFbmOrders.set(key, row);
      }
    }

    const dashboard = buildAmazonStoreDashboard({
      now,
      days,
      fbaOrders: fbaOrders.map((row) => ({
        orderId: row.amazonOrderId,
        sellerSku: row.sellerSku,
        asin: row.asin,
        productName: row.productName,
        orderStatus: row.orderStatus,
        quantityOrdered: row.quantityOrdered,
        quantityShipped: row.quantityShipped,
        itemAmount: Number(row.itemAmount),
        currency: row.currency,
        purchaseDate: row.purchaseDate,
      })),
      fbmOrders: Array.from(deduplicatedFbmOrders.values()),
      inventory,
      skus: skus.map((row) => ({
        sku: row.sku,
        fbmSku: row.fbmSku,
        rbSku: row.rbSku,
        asin: row.asin,
        fnsku: row.fnsku,
        productId: row.productId,
        productName: row.masterProduct?.productName ?? null,
      })),
    }) as Record<string, unknown>;
    const inventoryPermissionRequired = connection.syncFbaInventory
      && !inventory.length
      && /FBA库存|HTTP 403|Access to requested resource is denied/i.test(connection.lastSyncError ?? '');

    return {
      generatedAt: now.toISOString(),
      days,
      shops: connections.map((row) => ({
        connectionId: row.id.toString(),
        shopName: row.shop.name,
        healthy: Boolean(row.lastSuccessfulSyncAt && !row.lastSyncError),
        lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
        hasSyncError: Boolean(row.lastSyncError),
      })),
      selectedShop: {
        connectionId: connection.id.toString(),
        shopName: connection.shop.name,
        region: connection.region,
        marketplaceIds: this.readMarketplaceIds(connection.marketplaceIds),
        authorizedAt: connection.authorizedAt?.toISOString() ?? null,
        authorizationExpiresAt: connection.authorizationExpiresAt?.toISOString() ?? null,
        lastOrdersSyncedAt: connection.lastOrdersSyncedAt?.toISOString() ?? null,
        lastInventorySyncedAt: connection.lastInventorySyncedAt?.toISOString() ?? null,
        lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt?.toISOString() ?? null,
        syncFbmOrders: connection.syncFbmOrders,
        syncFbaOrders: connection.syncFbaOrders,
        syncFbaInventory: connection.syncFbaInventory,
        syncIssue: inventoryPermissionRequired
          ? {
              code: 'FBA_INVENTORY_PERMISSION_REQUIRED',
              message: '订单已同步；FBA库存接口缺少Amazon Fulfillment（亚马逊配送）或Product Listing（商品信息）权限。',
            }
          : connection.lastSyncError
            ? { code: 'SYNC_ERROR', message: connection.lastSyncError }
            : null,
      },
      latestSyncRun: latestRun
        ? {
            id: latestRun.id.toString(),
            syncType: latestRun.syncType,
            status: latestRun.status,
            startedAt: latestRun.startedAt.toISOString(),
            finishedAt: latestRun.finishedAt?.toISOString() ?? null,
            fetchedCount: latestRun.fetchedCount,
            createdCount: latestRun.createdCount,
            updatedCount: latestRun.updatedCount,
            hasError: Boolean(latestRun.errorMessage),
          }
        : null,
      dashboard,
    };
  }

  @Cron(AMAZON_SYNC_CRON, { name: 'amazon-sp-api-sync', timeZone: AMAZON_SYNC_TIMEZONE })
  async runScheduledSync(): Promise<void> {
    if (!AMAZON_SCHEDULED_SYNC_ENABLED) return;
    try {
      const result = await this.syncAllConnections(true);
      for (const row of result.results) {
        if (row.errors.length) {
          this.logger.error(
            `Amazon scheduled sync failed for connection ${row.connectionId} (${row.shopName}): ${row.errors.join('; ')}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Amazon scheduled sync failed: ${this.errorMessage(error)}`);
    }
  }

  private async materializeDashboardSnapshotIfComplete(): Promise<void> {
    const activeConnections = await this.prisma.amazonSpApiConnection.findMany({
      where: { status: 1 },
      include: { shop: { select: { name: true } } },
      orderBy: { id: 'asc' },
    });
    if (!activeConnections.length) return;
    const staleBefore = new Date(Date.now() - 6 * 60 * 60 * 1000);
    if (activeConnections.some((row) => row.lastSyncError || !row.lastSuccessfulSyncAt || row.lastSuccessfulSyncAt < staleBefore)) {
      return;
    }

    const now = new Date();
    const periodStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const connectionIds = activeConnections.map((row) => row.id);
    const [orders, inventories, skus] = await Promise.all([
      this.prisma.amazonFbaOrderItem.findMany({
        where: {
          connectionId: { in: connectionIds },
          purchaseDate: { gte: periodStart },
          orderStatus: { in: ['SHIPPED', 'PARTIALLY_SHIPPED'] },
        },
        include: { connection: { include: { shop: { select: { name: true } } } } },
      }),
      this.prisma.amazonFbaInventoryItem.findMany({
        where: { connectionId: { in: connectionIds } },
        include: { connection: { include: { shop: { select: { name: true } } } } },
      }),
      this.prisma.sku.findMany({
        where: { status: 1, productId: { not: null } },
        select: { shop: true, sku: true, productId: true },
      }),
    ]);

    const productByShopSku = new Map<string, string>();
    for (const sku of skus) {
      const productId = String(sku.productId ?? '').trim();
      if (productId) productByShopSku.set(this.shopSkuKey(sku.shop, sku.sku), productId);
    }
    type SnapshotRow = {
      sellerSku: string;
      asin: string | null;
      productName: string | null;
      productId: string | null;
      channel: 'fba' | 'unmatched';
      orderedQty: number;
      orderItemQty: number;
      salesAmount: number;
      fbaAvailableQty: number;
      fbaInboundQty: number;
      fbaReservedQty: number;
      fbaUnfulfillableQty: number;
    };
    const grouped = new Map<string, SnapshotRow>();
    const resolveGroup = (
      connectionId: bigint,
      shopName: string,
      sellerSkuRaw: string | null,
      asin: string | null,
      productName: string | null,
    ): SnapshotRow | null => {
      const sellerSku = String(sellerSkuRaw ?? '').trim();
      if (!sellerSku) return null;
      const productId = productByShopSku.get(this.shopSkuKey(shopName, sellerSku)) ?? null;
      const groupKey = productId ? `product:${productId}` : `unmatched:${connectionId.toString()}:${sellerSku}`;
      let row = grouped.get(groupKey);
      if (!row) {
        row = {
          sellerSku: `SP:${createHash('sha1').update(groupKey).digest('hex')}`,
          asin,
          productName,
          productId,
          channel: productId ? 'fba' : 'unmatched',
          orderedQty: 0,
          orderItemQty: 0,
          salesAmount: 0,
          fbaAvailableQty: 0,
          fbaInboundQty: 0,
          fbaReservedQty: 0,
          fbaUnfulfillableQty: 0,
        };
        grouped.set(groupKey, row);
      }
      if (!row.asin && asin) row.asin = asin;
      if (!row.productName && productName) row.productName = productName;
      return row;
    };

    for (const order of orders) {
      const row = resolveGroup(
        order.connectionId,
        order.connection.shop.name,
        order.sellerSku,
        order.asin,
        order.productName,
      );
      if (!row) continue;
      row.orderedQty += Math.max(0, order.quantityShipped);
      row.orderItemQty += 1;
      row.salesAmount += Number(order.itemAmount ?? 0);
    }
    for (const inventory of inventories) {
      const row = resolveGroup(
        inventory.connectionId,
        inventory.connection.shop.name,
        inventory.sellerSku,
        inventory.asin,
        inventory.productName,
      );
      if (!row) continue;
      row.fbaAvailableQty += inventory.fulfillableQty;
      row.fbaInboundQty += inventory.inboundWorkingQty + inventory.inboundShippedQty + inventory.inboundReceivingQty;
      row.fbaReservedQty += inventory.reservedQty;
      row.fbaUnfulfillableQty += inventory.unfulfillableQty;
    }

    const rows = Array.from(grouped.values());
    const fbaRows = rows.filter((row) => row.channel === 'fba');
    const unmatchedRows = rows.filter((row) => row.channel === 'unmatched');
    const fbaOrderedQty = fbaRows.reduce((sum, row) => sum + row.orderedQty, 0);
    const fbaAvailableQty = fbaRows.reduce((sum, row) => sum + row.fbaAvailableQty, 0);
    const fbaInboundQty = fbaRows.reduce((sum, row) => sum + row.fbaInboundQty, 0);
    const fbaReservedQty = fbaRows.reduce((sum, row) => sum + row.fbaReservedQty, 0);
    const fbaUnfulfillableQty = fbaRows.reduce((sum, row) => sum + row.fbaUnfulfillableQty, 0);
    await this.prisma.$transaction(async (tx) => {
      await tx.fbaSalesSnapshot.create({
        data: {
          fileName: 'Amazon SP-API 自动同步',
          inventoryFileName: 'Amazon SP-API FBA Inventory API',
          inventorySnapshotDate: now,
          inventoryRows: inventories.length,
          periodDays: 90,
          periodStart,
          periodEnd: now,
          totalRows: rows.length,
          fbaRows: fbaRows.length,
          fbmRows: 0,
          unmatchedRows: unmatchedRows.length,
          ambiguousRows: 0,
          fbaOrderedQty,
          fbaAvailableQty,
          fbaInboundQty,
          fbaReservedQty,
          fbaUnfulfillableQty,
          importedBy: BigInt(0),
          items: { create: rows },
        },
      });
      const expired = await tx.fbaSalesSnapshot.findMany({
        where: { fileName: { startsWith: 'Amazon SP-API' } },
        orderBy: { id: 'desc' },
        skip: 30,
        select: { id: true },
      });
      if (expired.length) {
        await tx.fbaSalesSnapshot.deleteMany({ where: { id: { in: expired.map((row) => row.id) } } });
      }
    });
  }

  private async runSync(
    connection: AmazonSpApiConnection,
    syncType: AmazonSpApiSyncType,
    lookbackDays: number,
  ): Promise<AmazonSyncResult> {
    const run = await this.prisma.amazonSpApiSyncRun.create({
      data: { connectionId: connection.id, syncType },
    });
    const counters: SyncCounters = { fetched: 0, created: 0, updated: 0, frozen: 0, excluded: 0 };
    const errors: string[] = [];
    const now = new Date();
    try {
      const accessToken = await this.getAccessToken(connection);
      const marketplaceIds = this.readMarketplaceIds(connection.marketplaceIds);
      const region = this.normalizeRegion(connection.region);
      const orderWatermark = connection.lastOrdersSyncedAt
        ? new Date(connection.lastOrdersSyncedAt.getTime() - ORDER_SYNC_OVERLAP_MS)
        : new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
      let attemptedOrderSync = false;
      let orderSyncSuccessful = true;

      if ((syncType === AmazonSpApiSyncType.full || syncType === AmazonSpApiSyncType.fbm_orders)
          && connection.syncFbmOrders) {
        attemptedOrderSync = true;
        try {
          this.addCounters(counters, await this.syncFbmOrders(connection, accessToken, region, marketplaceIds, orderWatermark));
        } catch (error) {
          orderSyncSuccessful = false;
          errors.push(`FBM订单：${this.errorMessage(error)}`);
        }
      }
      if ((syncType === AmazonSpApiSyncType.full || syncType === AmazonSpApiSyncType.fba_orders)
          && connection.syncFbaOrders) {
        attemptedOrderSync = true;
        try {
          this.addCounters(counters, await this.syncFbaOrders(connection, accessToken, region, marketplaceIds, orderWatermark));
        } catch (error) {
          orderSyncSuccessful = false;
          errors.push(`FBA订单：${this.errorMessage(error)}`);
        }
      }

      let attemptedInventorySync = false;
      let inventorySyncSuccessful = true;
      if ((syncType === AmazonSpApiSyncType.full || syncType === AmazonSpApiSyncType.fba_inventory)
          && connection.syncFbaInventory) {
        attemptedInventorySync = true;
        try {
          this.addCounters(counters, await this.syncFbaInventory(connection, accessToken, region, marketplaceIds, now));
        } catch (error) {
          inventorySyncSuccessful = false;
          errors.push(`FBA库存：${this.errorMessage(error)}`);
        }
      }

      const status = errors.length === 0
        ? AmazonSpApiSyncStatus.success
        : counters.fetched > 0
          ? AmazonSpApiSyncStatus.partial
          : AmazonSpApiSyncStatus.failed;
      const finishedAt = new Date();
      await this.prisma.$transaction([
        this.prisma.amazonSpApiSyncRun.update({
          where: { id: run.id },
          data: {
            status,
            finishedAt,
            fetchedCount: counters.fetched,
            createdCount: counters.created,
            updatedCount: counters.updated,
            errorMessage: errors.length ? errors.join('\n').slice(0, 10000) : null,
          },
        }),
        this.prisma.amazonSpApiConnection.update({
          where: { id: connection.id },
          data: {
            ...(attemptedOrderSync && orderSyncSuccessful ? { lastOrdersSyncedAt: now } : {}),
            ...(attemptedInventorySync && inventorySyncSuccessful ? { lastInventorySyncedAt: now } : {}),
            ...(status === AmazonSpApiSyncStatus.success ? { lastSuccessfulSyncAt: finishedAt } : {}),
            lastSyncError: errors.length ? errors.join('\n').slice(0, 10000) : null,
          },
        }),
      ]);
      return {
        runId: run.id.toString(),
        status,
        syncType,
        fetchedCount: counters.fetched,
        createdCount: counters.created,
        updatedCount: counters.updated,
        frozenCount: counters.frozen,
        excludedCount: counters.excluded,
        errors,
      };
    } catch (error) {
      const message = this.errorMessage(error);
      await this.prisma.$transaction([
        this.prisma.amazonSpApiSyncRun.update({
          where: { id: run.id },
          data: {
            status: AmazonSpApiSyncStatus.failed,
            finishedAt: new Date(),
            fetchedCount: counters.fetched,
            createdCount: counters.created,
            updatedCount: counters.updated,
            errorMessage: message.slice(0, 10000),
          },
        }),
        this.prisma.amazonSpApiConnection.update({
          where: { id: connection.id },
          data: { lastSyncError: message.slice(0, 10000) },
        }),
      ]);
      throw error;
    }
  }

  private async syncFbmOrders(
    connection: AmazonSpApiConnection,
    accessToken: string,
    region: AmazonSpApiRegion,
    marketplaceIds: string[],
    lastUpdatedAfter: Date,
  ): Promise<SyncCounters> {
    const includeRecipient = String(process.env.AMAZON_SP_API_INCLUDE_RECIPIENT ?? 'false').toLowerCase() === 'true';
    const orders = await this.client.searchOrders({
      accessToken,
      region,
      marketplaceIds,
      fulfilledBy: 'MERCHANT',
      lastUpdatedAfter,
      includeRecipient,
    });
    const counters: SyncCounters = { fetched: 0, created: 0, updated: 0, frozen: 0, excluded: 0 };
    const shop = await this.prisma.shop.findUnique({ where: { id: connection.shopId }, select: { name: true } });
    const shopSkus = await this.prisma.sku.findMany({
      where: { status: 1, shop: shop?.name ?? '', productId: { not: null } },
      select: {
        sku: true,
        fbmSku: true,
        rbSku: true,
        masterProduct: { select: { stockQty: true } },
      },
    });
    const availableStockBySku = new Map<string, number>();
    for (const sku of shopSkus) {
      for (const candidate of [sku.sku, sku.fbmSku, sku.rbSku]) {
        const key = this.normalizeSku(candidate);
        if (key && !availableStockBySku.has(key)) {
          availableStockBySku.set(key, Number(sku.masterProduct?.stockQty ?? 0));
        }
      }
    }
    for (const order of orders) {
      const dispatchMode = (order.orderItems ?? []).some((item) => {
        const stockQty = availableStockBySku.get(this.normalizeSku(item.product?.sellerSku));
        return stockQty === undefined || stockQty <= 0;
      })
        ? DISPATCH_CHINA_NO_STOCK
        : DISPATCH_OVERSEAS;
      for (const item of order.orderItems ?? []) {
        counters.fetched += 1;
        const result = await this.upsertFbmOrderItem(
          connection,
          shop?.name ?? null,
          order,
          item,
          dispatchMode,
        );
        if (result) counters[result] += 1;
      }
    }
    return counters;
  }

  private async upsertFbmOrderItem(
    connection: AmazonSpApiConnection,
    shopName: string | null,
    order: AmazonOrderPayload,
    item: AmazonOrderItemPayload,
    dispatchMode: string,
  ): Promise<'created' | 'updated' | 'frozen' | 'excluded' | null> {
    const address = order.recipient?.deliveryAddress;
    const fulfillment = order.fulfillment;
    const itemFulfillment = item.fulfillment;
    const excluded = await this.prisma.amazonOrderSyncExclusion.findFirst({
      where: {
        isActive: true,
        orderId: order.orderId,
        AND: [
          {
            OR: [
              { spApiConnectionId: connection.id },
              { spApiConnectionId: null },
            ],
          },
          {
            OR: [
              { orderItemId: item.orderItemId },
              { orderItemId: null },
            ],
          },
        ],
      },
      select: { id: true },
    });
    if (excluded) return 'excluded';
    const candidates = await this.prisma.amazonOrderRecord.findMany({
      where: {
        orderId: order.orderId,
        OR: [
          { spApiConnectionId: connection.id },
          { spApiConnectionId: null },
        ],
      },
      orderBy: { id: 'asc' },
    });
    const existing = this.selectExistingFbmOrderItem(candidates, connection.id, item);
    const orderStatus = String(fulfillment?.fulfillmentStatus ?? '').trim();
    const quantityOrdered = this.nonNegativeInt(item.quantityOrdered);
    const quantityShipped = this.nonNegativeInt(itemFulfillment?.quantityFulfilled);
    const quantityToShip = ['SHIPPED', 'CANCELLED', 'UNFULFILLABLE'].includes(orderStatus)
      ? 0
      : itemFulfillment?.quantityUnfulfilled === undefined
        ? Math.max(0, quantityOrdered - quantityShipped)
        : this.nonNegativeInt(itemFulfillment.quantityUnfulfilled);
    const manualOrderExists = candidates.some((candidate) => candidate.sourceKind !== 'sp_api');
    const freezeReason = manualOrderExists
      ? 'manual_import'
      : existing
        ? this.resolveExistingFbmFreezeReason(existing)
        : null;
    await this.recordFbmObservation(connection.id, order, item, {
      orderStatus: orderStatus || null,
      quantityOrdered,
      quantityShipped,
      quantityToShip,
      freezeReason,
    });
    if (manualOrderExists || freezeReason) return 'frozen';
    if (!existing && !['UNSHIPPED', 'PARTIALLY_SHIPPED'].includes(orderStatus)) return null;
    const manualOverrides = this.readManualOverrideFields(existing?.rawPayload ?? null);
    const mayUpdate = (field: string): boolean => !manualOverrides.has(field);
    const lastUpdatedAt = this.parseOptionalDate(order.lastUpdatedTime);
    const data = {
      spApiConnectionId: connection.id,
      orderId: order.orderId,
      ...(mayUpdate('orderItemId') ? { orderItemId: item.orderItemId } : {}),
      purchaseDateRaw: order.createdTime ?? null,
      buyerEmail: order.buyer?.buyerEmail ?? null,
      buyerName: order.buyer?.buyerName ?? null,
      ...(mayUpdate('buyerPhoneNumber') ? { buyerPhoneNumber: address?.phone ?? null } : {}),
      ...(mayUpdate('sku') ? { sku: item.product?.sellerSku ?? null } : {}),
      ...(mayUpdate('productName') ? { productName: item.product?.title ?? null } : {}),
      customizedUrl: item.product?.customization?.customizedUrl ?? null,
      ...(mayUpdate('quantityPurchased') ? { quantityPurchased: quantityOrdered } : {}),
      quantityShipped,
      quantityToShip,
      shipServiceLevel: fulfillment?.fulfillmentServiceLevel ?? null,
      ...(mayUpdate('recipientName') ? { recipientName: address?.name ?? null } : {}),
      ...(mayUpdate('shipAddress1') ? { shipAddress1: address?.addressLine1 ?? null } : {}),
      ...(mayUpdate('shipAddress2') ? { shipAddress2: address?.addressLine2 ?? null } : {}),
      ...(mayUpdate('shipAddress3') ? { shipAddress3: address?.addressLine3 ?? null } : {}),
      shipCity: address?.city ?? null,
      ...(mayUpdate('shipState') ? { shipState: address?.stateOrRegion ?? null } : {}),
      ...(mayUpdate('shipPostalCode') ? { shipPostalCode: address?.postalCode ?? null } : {}),
      shipCountry: address?.countryCode ?? null,
      isBusinessOrder: order.programs?.includes('AMAZON_BUSINESS') ?? false,
      purchaseOrderNumber: order.buyer?.buyerPurchaseOrderNumber ?? null,
      priceDesignation: item.product?.price?.priceDesignation ?? null,
      vergeOfCancellation: Boolean(item.cancellation?.cancellationRequest),
      ...(mayUpdate('mallName') ? {
        mallName: order.salesChannel?.marketplaceName ?? order.salesChannel?.marketplaceId ?? null,
      } : {}),
      ...(mayUpdate('shopName') ? { shopName } : {}),
      ...(!existing?.dispatchMode && mayUpdate('dispatchMode') && mayUpdate('shippingOrigin') ? {
        dispatchMode,
        shippingOrigin: dispatchMode === DISPATCH_OVERSEAS ? '日本発' : '中国発',
      } : {}),
      orderStatus: orderStatus || null,
      fulfillmentChannel: 'MFN',
      amazonLastUpdatedAt: lastUpdatedAt,
      sourceKind: 'sp_api',
      sourceFileName: 'Amazon SP-API Orders v2026-01-01',
      sourceFilePath: `sp-api:${connection.id.toString()}`,
      rawPayload: this.mergeSpApiRawPayload(existing?.rawPayload ?? null, order, item),
      csvImportedAt: new Date(),
    } satisfies Prisma.AmazonOrderRecordUncheckedUpdateInput;

    if (existing) {
      await this.prisma.amazonOrderRecord.update({ where: { id: existing.id }, data });
      return 'updated';
    }
    await this.prisma.amazonOrderRecord.create({
      data: {
        ...data,
        rowHash: createHash('sha1')
          .update(`${connection.id.toString()}|${order.orderId}|${item.orderItemId}`)
          .digest('hex'),
      },
    });
    return 'created';
  }

  private selectExistingFbmOrderItem(
    candidates: AmazonOrderRecord[],
    connectionId: bigint,
    item: AmazonOrderItemPayload,
  ): AmazonOrderRecord | null {
    if (candidates.length === 0) return null;
    const incomingItemId = String(item.orderItemId ?? '').trim();
    const incomingSku = this.normalizeSku(item.product?.sellerSku);
    const exact = candidates.filter((candidate) => {
      const currentItemId = String(candidate.orderItemId ?? '').trim();
      const originalItemId = this.getOriginalAmazonOrderItemId(candidate.rawPayload);
      return Boolean(incomingItemId && (currentItemId === incomingItemId || originalItemId === incomingItemId));
    });
    const skuMatches = candidates.filter(
      (candidate) => Boolean(incomingSku && this.normalizeSku(candidate.sku) === incomingSku),
    );
    const matches = exact.length > 0 ? exact : skuMatches.length > 0 ? skuMatches : candidates.length === 1 ? candidates : [];
    if (matches.length === 0) return null;
    return [...matches].sort((left, right) => {
      const score = (candidate: AmazonOrderRecord): number =>
        (String(candidate.shipmentNo ?? '').trim() ? 400 : 0) +
        (candidate.xiyaExportedAt ? 300 : 0) +
        (candidate.sourceKind !== 'sp_api' ? 200 : 0) +
        (candidate.spApiConnectionId === connectionId ? 10 : 0);
      return score(right) - score(left) || Number(left.id - right.id);
    })[0];
  }

  private resolveExistingFbmFreezeReason(existing: AmazonOrderRecord): string | null {
    if (existing.sourceKind !== 'sp_api') return 'manual_import';
    if (String(existing.shipmentNo ?? '').trim()) return 'tracking_registered';
    if (this.readManualOverrideFields(existing.rawPayload).size > 0) return 'manual_edit';
    return null;
  }

  private async recordFbmObservation(
    connectionId: bigint,
    order: AmazonOrderPayload,
    item: AmazonOrderItemPayload,
    state: {
      orderStatus: string | null;
      quantityOrdered: number;
      quantityShipped: number;
      quantityToShip: number;
      freezeReason: string | null;
    },
  ): Promise<void> {
    const key = {
      spApiConnectionId: connectionId,
      orderId: order.orderId,
      orderItemId: item.orderItemId,
    };
    const data = {
      ...state,
      rawPayload: JSON.parse(JSON.stringify({ order, item })) as Prisma.InputJsonValue,
      observedAt: new Date(),
    };
    await this.prisma.amazonOrderSyncObservation.upsert({
      where: { spApiConnectionId_orderId_orderItemId: key },
      create: { ...key, ...data },
      update: data,
    });
  }

  private getOriginalAmazonOrderItemId(rawPayload: Prisma.JsonValue | null): string {
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return '';
    const item = (rawPayload as Prisma.JsonObject).item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
    return String((item as Prisma.JsonObject).orderItemId ?? '').trim();
  }

  private readManualOverrideFields(rawPayload: Prisma.JsonValue | null): Set<string> {
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return new Set();
    const value = (rawPayload as Prisma.JsonObject)._wmsManualOverrideFields;
    if (typeof value !== 'string') return new Set();
    return new Set(value.split(',').map((field) => field.trim()).filter(Boolean));
  }

  private mergeSpApiRawPayload(
    rawPayload: Prisma.JsonValue | null,
    order: AmazonOrderPayload,
    item: AmazonOrderItemPayload,
  ): Prisma.InputJsonValue {
    const base = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
      ? { ...(rawPayload as Prisma.JsonObject) }
      : {};
    return JSON.parse(JSON.stringify({ ...base, order, item })) as Prisma.InputJsonValue;
  }

  private async syncFbaOrders(
    connection: AmazonSpApiConnection,
    accessToken: string,
    region: AmazonSpApiRegion,
    marketplaceIds: string[],
    lastUpdatedAfter: Date,
  ): Promise<SyncCounters> {
    const orders = await this.client.searchOrders({
      accessToken,
      region,
      marketplaceIds,
      fulfilledBy: 'AMAZON',
      lastUpdatedAfter,
      includeRecipient: false,
    });
    const counters: SyncCounters = { fetched: 0, created: 0, updated: 0, frozen: 0, excluded: 0 };
    for (const order of orders) {
      for (const item of order.orderItems ?? []) {
        counters.fetched += 1;
        const key = {
          connectionId: connection.id,
          amazonOrderId: order.orderId,
          amazonOrderItemId: item.orderItemId,
        };
        const existing = await this.prisma.amazonFbaOrderItem.findUnique({
          where: { connectionId_amazonOrderId_amazonOrderItemId: key },
          select: { id: true },
        });
        const proceeds = item.proceeds?.proceedsTotal;
        const itemSubtotal = item.proceeds?.breakdowns?.find((row) => row.type === 'ITEM')?.subtotal;
        const money = proceeds ?? itemSubtotal ?? item.product?.price?.unitPrice ?? item.product?.price?.listingPrice;
        const rawAmount = this.decimalNumber(money?.amount);
        const itemAmount = proceeds || itemSubtotal
          ? rawAmount
          : rawAmount * this.nonNegativeInt(item.quantityOrdered);
        await this.prisma.amazonFbaOrderItem.upsert({
          where: { connectionId_amazonOrderId_amazonOrderItemId: key },
          create: {
            ...key,
            marketplaceId: order.salesChannel?.marketplaceId ?? null,
            sellerSku: item.product?.sellerSku ?? null,
            asin: item.product?.asin ?? null,
            productName: item.product?.title ?? null,
            orderStatus: order.fulfillment?.fulfillmentStatus ?? null,
            quantityOrdered: this.nonNegativeInt(item.quantityOrdered),
            quantityShipped: this.nonNegativeInt(item.fulfillment?.quantityFulfilled),
            currency: money?.currencyCode ?? null,
            itemAmount: new Prisma.Decimal(itemAmount),
            purchaseDate: this.parseOptionalDate(order.createdTime),
            lastUpdateDate: this.parseOptionalDate(order.lastUpdatedTime),
            rawPayload: JSON.parse(JSON.stringify({ order, item })) as Prisma.InputJsonValue,
          },
          update: {
            marketplaceId: order.salesChannel?.marketplaceId ?? null,
            sellerSku: item.product?.sellerSku ?? null,
            asin: item.product?.asin ?? null,
            productName: item.product?.title ?? null,
            orderStatus: order.fulfillment?.fulfillmentStatus ?? null,
            quantityOrdered: this.nonNegativeInt(item.quantityOrdered),
            quantityShipped: this.nonNegativeInt(item.fulfillment?.quantityFulfilled),
            currency: money?.currencyCode ?? null,
            itemAmount: new Prisma.Decimal(itemAmount),
            purchaseDate: this.parseOptionalDate(order.createdTime),
            lastUpdateDate: this.parseOptionalDate(order.lastUpdatedTime),
            rawPayload: JSON.parse(JSON.stringify({ order, item })) as Prisma.InputJsonValue,
          },
        });
        counters[existing ? 'updated' : 'created'] += 1;
      }
    }
    return counters;
  }

  private async syncFbaInventory(
    connection: AmazonSpApiConnection,
    accessToken: string,
    region: AmazonSpApiRegion,
    marketplaceIds: string[],
    snapshotAt: Date,
  ): Promise<SyncCounters> {
    const counters: SyncCounters = { fetched: 0, created: 0, updated: 0, frozen: 0, excluded: 0 };
    for (const marketplaceId of marketplaceIds) {
      const rows = await this.client.getInventorySummaries({ accessToken, region, marketplaceId });
      const currentSellerSkus: string[] = [];
      for (const row of rows) {
        const sellerSku = String(row.sellerSku ?? '').trim();
        if (!sellerSku) continue;
        currentSellerSkus.push(sellerSku);
        counters.fetched += 1;
        const key = { connectionId: connection.id, marketplaceId, sellerSku };
        const existing = await this.prisma.amazonFbaInventoryItem.findUnique({
          where: { connectionId_marketplaceId_sellerSku: key },
          select: { id: true },
        });
        const inventory = row.inventoryDetails;
        const values = {
          fnSku: row.fnSku ?? null,
          asin: row.asin ?? null,
          productName: row.productName ?? null,
          fulfillableQty: this.nonNegativeInt(inventory?.fulfillableQuantity),
          inboundWorkingQty: this.nonNegativeInt(inventory?.inboundWorkingQuantity),
          inboundShippedQty: this.nonNegativeInt(inventory?.inboundShippedQuantity),
          inboundReceivingQty: this.nonNegativeInt(inventory?.inboundReceivingQuantity),
          reservedQty: this.nonNegativeInt(inventory?.reservedQuantity?.totalReservedQuantity),
          unfulfillableQty: this.nonNegativeInt(inventory?.unfulfillableQuantity?.totalUnfulfillableQuantity),
          totalQty: this.nonNegativeInt(row.totalQuantity),
          snapshotAt,
          rawPayload: JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue,
        };
        await this.prisma.amazonFbaInventoryItem.upsert({
          where: { connectionId_marketplaceId_sellerSku: key },
          create: { ...key, ...values },
          update: values,
        });
        counters[existing ? 'updated' : 'created'] += 1;
      }
      await this.prisma.amazonFbaInventoryItem.deleteMany({
        where: {
          connectionId: connection.id,
          marketplaceId,
          ...(currentSellerSkus.length ? { sellerSku: { notIn: currentSellerSkus } } : {}),
        },
      });
    }
    return counters;
  }

  private async getConnection(idRaw: string): Promise<AmazonSpApiConnection> {
    const id = parseId(idRaw, 'connectionId');
    const connection = await this.prisma.amazonSpApiConnection.findUnique({ where: { id } });
    if (!connection) throw new NotFoundException('Amazon SP-API连接不存在');
    if (connection.status !== 1) throw new BadRequestException('Amazon SP-API连接已停用');
    return connection;
  }

  private async getAccessToken(connection: AmazonSpApiConnection): Promise<string> {
    if (connection.authorizationExpiresAt && connection.authorizationExpiresAt <= new Date()) {
      throw new BadRequestException('Amazon授权已到期，请由该店铺主用户重新授权');
    }
    const refreshToken = this.cryptoService.decrypt(
      connection.encryptedRefreshToken,
      connection.tokenIv,
      connection.tokenAuthTag,
    );
    return this.client.exchangeRefreshToken(refreshToken);
  }

  private serializeConnection(row: AmazonSpApiConnection & { shop: { id: bigint; name: string; status: number } }): unknown {
    return {
      id: row.id.toString(),
      shop: { id: row.shop.id.toString(), name: row.shop.name, status: row.shop.status },
      sellerId: row.sellerId,
      region: row.region,
      marketplaceIds: this.readMarketplaceIds(row.marketplaceIds),
      status: row.status,
      syncFbmOrders: row.syncFbmOrders,
      syncFbaOrders: row.syncFbaOrders,
      syncFbaInventory: row.syncFbaInventory,
      lastOrdersSyncedAt: row.lastOrdersSyncedAt?.toISOString() ?? null,
      lastInventorySyncedAt: row.lastInventorySyncedAt?.toISOString() ?? null,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
      lastSyncError: row.lastSyncError,
      hasRefreshToken: Boolean(row.encryptedRefreshToken),
      authorizationMode: row.authorizationMode,
      authorizedAt: row.authorizedAt?.toISOString() ?? null,
      authorizationExpiresAt: row.authorizationExpiresAt?.toISOString() ?? null,
      renewalDue: Boolean(
        row.authorizationExpiresAt
          && row.authorizationExpiresAt.getTime() <= Date.now() + 30 * 24 * 60 * 60 * 1000,
      ),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private normalizeMarketplaceIds(values: string[]): Prisma.InputJsonValue {
    const normalized = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
    if (!normalized.length) throw new BadRequestException('请至少配置一个Marketplace ID');
    return normalized;
  }

  private shopSkuKey(shop: unknown, sku: unknown): string {
    return `${String(shop ?? '').trim()}\u0000${String(sku ?? '').trim()}`;
  }

  private normalizeSku(value: unknown): string {
    return String(value ?? '').trim().toUpperCase();
  }

  private readMarketplaceIds(value: Prisma.JsonValue): string[] {
    if (!Array.isArray(value)) throw new BadRequestException('Amazon Marketplace配置格式无效');
    const values = value.map((item) => String(item ?? '').trim()).filter(Boolean);
    if (!values.length) throw new BadRequestException('Amazon Marketplace配置为空');
    return values;
  }

  private normalizeRegion(value: string): AmazonSpApiRegion {
    if (value === 'NA' || value === 'EU' || value === 'FE') return value;
    throw new BadRequestException(`不支持的Amazon SP-API区域：${value}`);
  }

  private async createOAuthState(
    payload: StartAmazonOAuthDto,
    createdBy: bigint,
    expectedSellerId?: string,
  ): Promise<{ rawState: string; expiresAt: Date }> {
    const shopId = parseId(payload.shopId, 'shopId');
    const shop = await this.prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) throw new NotFoundException('店铺不存在');

    const rawState = randomBytes(32).toString('base64url');
    const stateHash = createHash('sha256').update(rawState).digest('hex');
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
    await this.prisma.amazonSpApiOAuthState.create({
      data: {
        shopId,
        stateHash,
        region: payload.region,
        marketplaceIds: this.normalizeMarketplaceIds(payload.marketplaceIds),
        syncFbmOrders: payload.syncFbmOrders ?? true,
        syncFbaOrders: payload.syncFbaOrders ?? true,
        syncFbaInventory: payload.syncFbaInventory ?? true,
        expectedSellerId: expectedSellerId || null,
        createdBy,
        expiresAt,
      },
    });
    await this.prisma.amazonSpApiOAuthState.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
    return { rawState, expiresAt };
  }

  private validateAmazonCallbackUri(value: string): URL {
    let url: URL;
    try {
      url = new URL(String(value ?? '').trim());
    } catch {
      throw new BadRequestException('Amazon callback URI格式无效');
    }
    const hostname = url.hostname.toLowerCase();
    const isAmazonHostname = AMAZON_DOMAIN_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
    if (
      url.protocol !== 'https:'
      || (url.port && url.port !== '443')
      || url.username
      || url.password
      || url.hash
      || !isAmazonHostname
      || !url.pathname.startsWith(AMAZON_CALLBACK_PATH_PREFIX)
    ) {
      throw new BadRequestException('Amazon callback URI未通过安全校验');
    }
    return url;
  }

  private isDraftApplication(): boolean {
    return String(process.env.AMAZON_SP_API_OAUTH_DRAFT ?? 'true').toLowerCase() === 'true';
  }

  private buildAuthorizationUrl(state: string): string {
    const applicationId = String(process.env.AMAZON_SP_API_APPLICATION_ID ?? '').trim();
    if (!applicationId) {
      throw new BadRequestException('请配置 AMAZON_SP_API_APPLICATION_ID');
    }
    const sellerCentralUrl = String(
      process.env.AMAZON_SP_API_SELLER_CENTRAL_URL ?? 'https://sellercentral.amazon.co.jp',
    ).trim().replace(/\/$/, '');
    const url = new URL(`${sellerCentralUrl}/apps/authorize/consent`);
    url.searchParams.set('application_id', applicationId);
    url.searchParams.set('state', state);
    if (this.isDraftApplication()) {
      url.searchParams.set('version', 'beta');
    }
    return url.toString();
  }

  private getOAuthRedirectUri(): string {
    const redirectUri = String(process.env.AMAZON_SP_API_OAUTH_REDIRECT_URI ?? '').trim();
    if (!redirectUri || !redirectUri.startsWith('https://')) {
      throw new BadRequestException('请配置HTTPS的 AMAZON_SP_API_OAUTH_REDIRECT_URI');
    }
    return redirectUri;
  }

  getOAuthReturnUrl(status: 'success' | 'error', reason?: string): string {
    const configured = String(process.env.AMAZON_SP_API_OAUTH_RETURN_URL ?? '/').trim() || '/';
    const separator = configured.includes('?') ? '&' : '?';
    return `${configured}${separator}amazon_oauth=${encodeURIComponent(status)}${
      reason ? `&amazon_oauth_reason=${encodeURIComponent(reason)}` : ''
    }`;
  }

  private addCounters(target: SyncCounters, value: SyncCounters): void {
    target.fetched += value.fetched;
    target.created += value.created;
    target.updated += value.updated;
    target.frozen += value.frozen;
    target.excluded += value.excluded;
  }

  private nonNegativeInt(value: unknown): number {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
  }

  private decimalNumber(value: unknown): number {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
  }

  private parseOptionalDate(value: unknown): Date | null {
    const date = new Date(String(value ?? ''));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
