import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  AmazonSpApiConnection,
  AmazonSpApiSyncStatus,
  AmazonSpApiSyncType,
  Prisma,
  ShopPlatform,
} from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import * as XLSX from 'xlsx';
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
const SYNC_LOCK_STALE_MS = 30 * 60 * 1000;
const SYNC_LOCK_HEARTBEAT_MS = 5 * 60 * 1000;
const MANUAL_SYNC_COOLDOWN_MS = 60 * 1000;
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
  unchanged: number;
  frozen: number;
  excluded: number;
  conflicts: number;
}

type SyncProgressCallback = (counters: SyncCounters) => Promise<void>;

interface AmazonSyncResult {
  runId: string;
  status: AmazonSpApiSyncStatus;
  syncType: AmazonSpApiSyncType;
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  frozenCount: number;
  excludedCount: number;
  conflictCount: number;
  errors: string[];
}

type AmazonSyncTrigger = 'manual' | 'scheduled';

interface AmazonAllConnectionsSyncResult {
  connectionCount: number;
  completedCount: number;
  skippedCount: number;
  partialCount: number;
  failedCount: number;
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  frozenCount: number;
  excludedCount: number;
  conflictCount: number;
  results: Array<{
    connectionId: string;
    shopName: string;
    status: AmazonSpApiSyncStatus | 'skipped';
    fetchedCount: number;
    createdCount: number;
    updatedCount: number;
    unchangedCount: number;
    frozenCount: number;
    excludedCount: number;
    conflictCount: number;
    errors: string[];
  }>;
}

@Injectable()
export class AmazonSpApiService {
  private readonly logger = new Logger(AmazonSpApiService.name);
  private readonly runningConnections = new Set<string>();
  private readonly queuedConnections = new Set<string>();
  private readonly lastManualSyncQueuedAt = new Map<string, number>();
  private allConnectionsSyncQueued = false;
  private syncQueueTail: Promise<void> = Promise.resolve();
  private queuedSyncTaskCount = 0;
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

  async enqueueConnectionSync(idRaw: string, payload: SyncAmazonConnectionDto = {}): Promise<unknown> {
    const connection = await this.getConnection(idRaw);
    const key = connection.id.toString();
    if (this.runningConnections.has(key) || this.queuedConnections.has(key)) {
      throw new ConflictException('该店铺的Amazon同步任务正在运行或排队');
    }
    const now = Date.now();
    const lastQueuedAt = this.lastManualSyncQueuedAt.get(key) ?? 0;
    if (now - lastQueuedAt < MANUAL_SYNC_COOLDOWN_MS) {
      throw new ConflictException('Amazon同步操作过于频繁，请在60秒后重试');
    }
    this.lastManualSyncQueuedAt.set(key, now);
    this.queuedConnections.add(key);
    const queuedAt = new Date();
    const queuePosition = this.queuedSyncTaskCount + 1;
    void this.enqueueSyncTask(async () => {
        try {
          await this.syncConnection(key, payload);
        } catch (error) {
          this.logger.error(`Amazon queued sync failed for connection ${key}: ${this.errorMessage(error)}`);
        } finally {
          this.queuedConnections.delete(key);
        }
      }).catch(() => undefined);
    return {
      accepted: true,
      connectionId: key,
      queuedAt: queuedAt.toISOString(),
      queuePosition,
    };
  }

  async enqueueAllConnectionsSync(trigger: AmazonSyncTrigger = 'manual'): Promise<unknown> {
    if (this.allConnectionsSyncQueued) {
      throw new ConflictException('全部Amazon店铺同步任务正在运行或排队');
    }
    this.allConnectionsSyncQueued = true;
    const queuedAt = new Date();
    const queuePosition = this.queuedSyncTaskCount + 1;
    void this.enqueueSyncTask(() => this.syncAllConnections(trigger === 'scheduled', trigger))
      .catch((error) => {
        this.logger.error(`Amazon queued all-store sync failed: ${this.errorMessage(error)}`);
      })
      .finally(() => {
        this.allConnectionsSyncQueued = false;
      });
    return { accepted: true, queuedAt: queuedAt.toISOString(), queuePosition };
  }

  async syncConnection(idRaw: string, payload: SyncAmazonConnectionDto = {}): Promise<unknown> {
    const connection = await this.getConnection(idRaw);
    const key = connection.id.toString();
    if (this.runningConnections.has(key)) {
      throw new ConflictException('该店铺的Amazon同步任务正在运行');
    }
    const lockToken = randomUUID();
    if (!(await this.acquireConnectionLock(connection.id, lockToken))) {
      throw new ConflictException('该店铺的Amazon同步任务正在运行');
    }
    this.runningConnections.add(key);
    const heartbeat = this.startConnectionLockHeartbeat(connection.id, lockToken);
    try {
      const result = await this.runSync(
        connection,
        (payload.syncType ?? 'full') as AmazonSpApiSyncType,
        payload.initialLookbackDays ?? DEFAULT_LOOKBACK_DAYS,
      );
      return result;
    } finally {
      clearInterval(heartbeat);
      this.runningConnections.delete(key);
      await this.releaseConnectionLock(connection.id, lockToken);
    }
  }

  async syncAllConnections(
    bypassCooldown = false,
    trigger: AmazonSyncTrigger = 'manual',
  ): Promise<AmazonAllConnectionsSyncResult> {
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
      unchangedCount: 0,
      frozenCount: 0,
      excludedCount: 0,
      conflictCount: 0,
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
          unchangedCount: 0,
          frozenCount: 0,
          excludedCount: 0,
          conflictCount: 0,
          errors: ['该店铺已有Amazon同步任务正在运行'],
        });
        continue;
      }
      const lockToken = randomUUID();
      if (!(await this.acquireConnectionLock(connection.id, lockToken))) {
        summary.skippedCount += 1;
        summary.results.push({
          connectionId,
          shopName: connection.shop.name,
          status: 'skipped',
          fetchedCount: 0,
          createdCount: 0,
          updatedCount: 0,
          unchangedCount: 0,
          frozenCount: 0,
          excludedCount: 0,
          conflictCount: 0,
          errors: ['该店铺已有Amazon同步任务正在运行'],
        });
        continue;
      }
      this.runningConnections.add(connectionId);
      const heartbeat = this.startConnectionLockHeartbeat(connection.id, lockToken);
      try {
        const result = await this.runSync(
          connection,
          AmazonSpApiSyncType.full,
          DEFAULT_LOOKBACK_DAYS,
          trigger,
        );
        summary.completedCount += 1;
        if (result.status === AmazonSpApiSyncStatus.partial) summary.partialCount += 1;
        if (result.status === AmazonSpApiSyncStatus.failed) summary.failedCount += 1;
        summary.fetchedCount += result.fetchedCount;
        summary.createdCount += result.createdCount;
        summary.updatedCount += result.updatedCount;
        summary.unchangedCount += result.unchangedCount ?? 0;
        summary.frozenCount += result.frozenCount ?? 0;
        summary.excludedCount += result.excludedCount ?? 0;
        summary.conflictCount += result.conflictCount ?? 0;
        summary.results.push({
          connectionId,
          shopName: connection.shop.name,
          status: result.status,
          fetchedCount: result.fetchedCount,
          createdCount: result.createdCount,
          updatedCount: result.updatedCount,
          unchangedCount: result.unchangedCount ?? 0,
          frozenCount: result.frozenCount ?? 0,
          excludedCount: result.excludedCount ?? 0,
          conflictCount: result.conflictCount ?? 0,
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
          unchangedCount: 0,
          frozenCount: 0,
          excludedCount: 0,
          conflictCount: 0,
          errors: [this.errorMessage(error)],
        });
      } finally {
        clearInterval(heartbeat);
        this.runningConnections.delete(connectionId);
        await this.releaseConnectionLock(connection.id, lockToken);
      }
    }
    if (trigger === 'scheduled') {
      await this.materializeDashboardSnapshotIfComplete();
    }
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
      unchangedCount: row.unchangedCount,
      frozenCount: row.frozenCount,
      excludedCount: row.excludedCount,
      conflictCount: row.conflictCount,
      progressStage: row.progressStage,
      trigger: row.trigger,
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
    const queryDays = Math.max(days * 2, 90);
    const queryStart = new Date(now.getTime() - queryDays * 24 * 60 * 60 * 1000);
    const trackingStartedAt = connection.dashboardTrackingStartedAt ?? now;
    const [fbaOrders, fbmOrderRows, inventory, skus, latestRun] = await Promise.all([
      this.prisma.amazonFbaOrderItem.findMany({
        where: {
          connectionId: connection.id,
          purchaseDate: { gte: queryStart },
          dashboardVisibleAt: { not: null },
        },
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
      this.prisma.amazonFbmOrderItem.findMany({
        where: {
          connectionId: connection.id,
          purchaseDate: { gte: queryStart },
        },
        select: {
          amazonOrderId: true,
          sellerSku: true,
          productName: true,
          orderStatus: true,
          quantityOrdered: true,
          quantityShipped: true,
          quantityUnfulfilled: true,
          purchaseDate: true,
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
          unchangedCount: true,
          frozenCount: true,
          excludedCount: true,
          conflictCount: true,
          progressStage: true,
          trigger: true,
          errorMessage: true,
        },
      }),
    ]);
    const [fbaLastSales, fbmLastSales] = await Promise.all([
      this.prisma.amazonFbaOrderItem.groupBy({
        by: ['sellerSku'],
        where: {
          connectionId: connection.id,
          sellerSku: { not: null },
          dashboardVisibleAt: { not: null },
          orderStatus: { in: ['SHIPPED', 'PARTIALLY_SHIPPED'] },
          purchaseDate: { gte: trackingStartedAt },
        },
        _max: { purchaseDate: true },
      }),
      this.prisma.amazonFbmOrderItem.groupBy({
        by: ['sellerSku'],
        where: {
          connectionId: connection.id,
          sellerSku: { not: null },
          orderStatus: { notIn: ['CANCELLED', 'UNFULFILLABLE'] },
          purchaseDate: { gte: queryStart },
        },
        _max: { purchaseDate: true },
      }),
    ]);

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
      fbmOrders: fbmOrderRows.map((row) => ({
        orderId: row.amazonOrderId,
        sku: row.sellerSku,
        productName: row.productName,
        orderStatus: row.orderStatus,
        quantityPurchased: row.quantityOrdered,
        quantityShipped: row.quantityShipped,
        quantityToShip: row.quantityUnfulfilled,
        purchaseDateRaw: row.purchaseDate?.toISOString() ?? null,
      })),
      inventory,
      inventorySnapshotAt: connection.lastInventorySyncedAt,
      trackingStartedAt,
      lastSales: [
        ...fbaLastSales.map((row) => ({ sellerSku: row.sellerSku, lastSaleAt: row._max.purchaseDate })),
        ...fbmLastSales.map((row) => ({ sellerSku: row.sellerSku, lastSaleAt: row._max.purchaseDate })),
      ],
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
        lastFbmOrdersSyncedAt: connection.lastFbmOrdersSyncedAt?.toISOString() ?? null,
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
            unchangedCount: latestRun.unchangedCount,
            frozenCount: latestRun.frozenCount,
            excludedCount: latestRun.excludedCount,
            conflictCount: latestRun.conflictCount,
            progressStage: latestRun.progressStage,
            trigger: latestRun.trigger,
            hasError: Boolean(latestRun.errorMessage),
          }
        : null,
      dashboard,
    };
  }

  async buildStoreFactoryRecommendationsExcel(
    connectionIdRaw?: string,
  ): Promise<{ fileName: string; content: Buffer }> {
    const payload = await this.getStoreDashboard(connectionIdRaw, '90') as {
      selectedShop?: { shopName?: string } | null;
      dashboard?: {
        factoryRecommendations?: {
          inventoryAvailable?: boolean;
          rows?: Array<{
            sellerSku?: string;
            asin?: string | null;
            productId?: string | null;
            productName?: string | null;
            fbaUnitCount90d?: number;
            fbmUnitCount90d?: number;
            totalUnitCount90d?: number;
            availableQty?: number;
            inboundQty?: number;
            suggestedFbaShipmentQty?: number;
          }>;
        };
      } | null;
    };
    if (!payload.selectedShop) throw new NotFoundException('尚无已启用的Amazon店铺连接');
    const recommendations = payload.dashboard?.factoryRecommendations;
    if (!recommendations?.inventoryAvailable) {
      throw new BadRequestException('尚无该店铺的FBA库存数据，无法计算工厂直发FBA数量');
    }
    const shopName = String(payload.selectedShop.shopName ?? '').trim();
    const data = (recommendations.rows ?? []).map((row) => ({
      'Amazon店铺': shopName,
      '产品ID': row.productId ?? '',
      'FBA SKU': row.sellerSku ?? '',
      'ASIN': row.asin ?? '',
      '产品名称': row.productName ?? '',
      '90天FBA销量': Number(row.fbaUnitCount90d ?? 0),
      '90天FBM销量': Number(row.fbmUnitCount90d ?? 0),
      '90天FBA+FBM销量': Number(row.totalUnitCount90d ?? 0),
      'FBA可售库存': Number(row.availableQty ?? 0),
      'FBA入库中': Number(row.inboundQty ?? 0),
      '建议工厂直发FBA数量': Number(row.suggestedFbaShipmentQty ?? 0),
    }));
    const worksheet = XLSX.utils.json_to_sheet(data, {
      header: [
        'Amazon店铺',
        '产品ID',
        'FBA SKU',
        'ASIN',
        '产品名称',
        '90天FBA销量',
        '90天FBM销量',
        '90天FBA+FBM销量',
        'FBA可售库存',
        'FBA入库中',
        '建议工厂直发FBA数量',
      ],
    });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '工厂直发FBA建议');
    const content = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const dateParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const dateRecord = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
    const date = `${dateRecord.year}-${dateRecord.month}-${dateRecord.day}`;
    return {
      fileName: `工厂直发FBA建议-${shopName}-${date}.xlsx`,
      content,
    };
  }

  @Cron(AMAZON_SYNC_CRON, { name: 'amazon-sp-api-sync', timeZone: AMAZON_SYNC_TIMEZONE })
  async runScheduledSync(): Promise<void> {
    if (!AMAZON_SCHEDULED_SYNC_ENABLED) return;
    try {
      const result = await this.enqueueSyncTask(() => this.syncAllConnections(true, 'scheduled'));
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
    trigger: AmazonSyncTrigger = 'manual',
  ): Promise<AmazonSyncResult> {
    const run = await this.prisma.amazonSpApiSyncRun.create({
      data: { connectionId: connection.id, syncType, trigger },
    });
    const counters: SyncCounters = {
      fetched: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      frozen: 0,
      excluded: 0,
      conflicts: 0,
    };
    const errors: string[] = [];
    const now = new Date();
    const reportProgress = async (stage: string, phaseCounters?: SyncCounters): Promise<void> => {
      const phase = phaseCounters ?? this.emptySyncCounters();
      try {
        await this.prisma.amazonSpApiSyncRun.update({
          where: { id: run.id },
          data: {
            progressStage: stage,
            fetchedCount: counters.fetched + phase.fetched,
            createdCount: counters.created + phase.created,
            updatedCount: counters.updated + phase.updated,
            unchangedCount: counters.unchanged + phase.unchanged,
          },
        });
      } catch (error) {
        this.logger.warn(`Amazon sync progress update failed: ${this.errorMessage(error)}`);
      }
    };
    try {
      if (!connection.dashboardTrackingStartedAt) {
        await this.prisma.amazonSpApiConnection.updateMany({
          where: { id: connection.id, dashboardTrackingStartedAt: null },
          data: { dashboardTrackingStartedAt: now },
        });
      }
      const accessToken = await this.getAccessToken(connection);
      const marketplaceIds = this.readMarketplaceIds(connection.marketplaceIds);
      const region = this.normalizeRegion(connection.region);
      const orderWatermark = connection.lastOrdersSyncedAt
        ? new Date(connection.lastOrdersSyncedAt.getTime() - ORDER_SYNC_OVERLAP_MS)
        : new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
      const fbmOrderWatermark = connection.lastFbmOrdersSyncedAt
        ? new Date(connection.lastFbmOrdersSyncedAt.getTime() - ORDER_SYNC_OVERLAP_MS)
        : null;
      let attemptedFbmOrderSync = false;
      let fbmOrderSyncSuccessful = true;
      let attemptedFbaOrderSync = false;
      let fbaOrderSyncSuccessful = true;

      if ((syncType === AmazonSpApiSyncType.full || syncType === AmazonSpApiSyncType.fbm_orders)
          && connection.syncFbmOrders) {
        attemptedFbmOrderSync = true;
        try {
          await reportProgress('fbm_orders');
          // The first independent FBM run establishes the "from now on" boundary only.
          // Amazon rejects lastUpdatedAfter values newer than its two-minute safety window.
          if (fbmOrderWatermark) {
            const fbmCounters = await this.syncFbmOrders(
              connection,
              accessToken,
              region,
              marketplaceIds,
              fbmOrderWatermark,
              (progress) => reportProgress('fbm_orders', progress),
            );
            this.addCounters(counters, fbmCounters);
          }
        } catch (error) {
          fbmOrderSyncSuccessful = false;
          errors.push(`FBM订单：${this.errorMessage(error)}`);
        }
      }
      if ((syncType === AmazonSpApiSyncType.full || syncType === AmazonSpApiSyncType.fba_orders)
          && connection.syncFbaOrders) {
        attemptedFbaOrderSync = true;
        try {
          await reportProgress('fba_orders');
          this.addCounters(counters, await this.syncFbaOrders(
            connection,
            accessToken,
            region,
            marketplaceIds,
            orderWatermark,
            (progress) => reportProgress('fba_orders', progress),
          ));
        } catch (error) {
          fbaOrderSyncSuccessful = false;
          errors.push(`FBA订单：${this.errorMessage(error)}`);
        }
      }

      let attemptedInventorySync = false;
      let inventorySyncSuccessful = true;
      if ((syncType === AmazonSpApiSyncType.full || syncType === AmazonSpApiSyncType.fba_inventory)
          && connection.syncFbaInventory) {
        attemptedInventorySync = true;
        try {
          await reportProgress('fba_inventory');
          this.addCounters(counters, await this.syncFbaInventory(
            connection,
            accessToken,
            region,
            marketplaceIds,
            now,
            (progress) => reportProgress('fba_inventory', progress),
          ));
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
      await reportProgress('finalizing');
      await this.prisma.$transaction([
        this.prisma.amazonSpApiSyncRun.update({
          where: { id: run.id },
          data: {
            status,
            finishedAt,
            fetchedCount: counters.fetched,
            createdCount: counters.created,
            updatedCount: counters.updated,
            unchangedCount: counters.unchanged,
            frozenCount: counters.frozen,
            excludedCount: counters.excluded,
            conflictCount: counters.conflicts,
            progressStage: 'completed',
            errorMessage: errors.length ? errors.join('\n').slice(0, 10000) : null,
          },
        }),
        this.prisma.amazonSpApiConnection.update({
          where: { id: connection.id },
          data: {
            ...(attemptedFbaOrderSync && fbaOrderSyncSuccessful ? { lastOrdersSyncedAt: now } : {}),
            ...(attemptedFbmOrderSync && fbmOrderSyncSuccessful ? { lastFbmOrdersSyncedAt: now } : {}),
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
        unchangedCount: counters.unchanged,
        frozenCount: counters.frozen,
        excludedCount: counters.excluded,
        conflictCount: counters.conflicts,
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
            unchangedCount: counters.unchanged,
            frozenCount: counters.frozen,
            excludedCount: counters.excluded,
            conflictCount: counters.conflicts,
            progressStage: 'failed',
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
    onProgress?: SyncProgressCallback,
  ): Promise<SyncCounters> {
    const counters = this.emptySyncCounters();
    await this.client.forEachOrderPage({
      accessToken,
      region,
      marketplaceIds,
      fulfilledBy: 'MERCHANT',
      lastUpdatedAfter,
      includeRecipient: false,
    }, async (orders) => {
      const pageItems = orders.flatMap((order) =>
        (order.orderItems ?? []).map((item) => ({ order, item })));
      const existingRows = pageItems.length
        ? await this.prisma.amazonFbmOrderItem.findMany({
            where: {
              connectionId: connection.id,
              OR: pageItems.map(({ order, item }) => ({
                amazonOrderId: order.orderId,
                amazonOrderItemId: item.orderItemId,
              })),
            },
            select: {
              amazonOrderId: true,
              amazonOrderItemId: true,
              lastUpdateDate: true,
            },
          })
        : [];
      const existingByKey = new Map(existingRows.map((row) => [
        this.amazonOrderItemKey(row.amazonOrderId, row.amazonOrderItemId),
        row,
      ]));
      for (const order of orders) {
        for (const item of order.orderItems ?? []) {
          counters.fetched += 1;
          const result = await this.upsertFbmOrderItem(connection.id, order, item, existingByKey);
          if (result) counters[result] += 1;
        }
      }
      await onProgress?.(counters);
    });
    return counters;
  }

  private amazonOrderItemKey(orderId: unknown, orderItemId: unknown): string {
    return `${String(orderId ?? '').trim()}\u0000${String(orderItemId ?? '').trim()}`;
  }

  private async upsertFbmOrderItem(
    connectionId: bigint,
    order: AmazonOrderPayload,
    item: AmazonOrderItemPayload,
    existingByKey?: Map<string, { lastUpdateDate: Date | null }>,
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const fulfillment = order.fulfillment;
    const itemFulfillment = item.fulfillment;
    const orderStatus = String(fulfillment?.fulfillmentStatus ?? '').trim();
    const quantityOrdered = this.nonNegativeInt(item.quantityOrdered);
    const quantityShipped = this.nonNegativeInt(itemFulfillment?.quantityFulfilled);
    const quantityUnfulfilled = ['SHIPPED', 'CANCELLED', 'UNFULFILLABLE'].includes(orderStatus)
      ? 0
      : itemFulfillment?.quantityUnfulfilled === undefined
        ? Math.max(0, quantityOrdered - quantityShipped)
        : this.nonNegativeInt(itemFulfillment.quantityUnfulfilled);
    const lastUpdateDate = this.parseOptionalDate(order.lastUpdatedTime);
    const itemKey = this.amazonOrderItemKey(order.orderId, item.orderItemId);
    const existing = existingByKey?.get(itemKey)
      ?? await this.prisma.amazonFbmOrderItem.findUnique({
        where: {
          connectionId_amazonOrderId_amazonOrderItemId: {
            connectionId,
            amazonOrderId: order.orderId,
            amazonOrderItemId: item.orderItemId,
          },
        },
        select: { lastUpdateDate: true },
      });
    if (existing?.lastUpdateDate && lastUpdateDate
      && existing.lastUpdateDate.getTime() >= lastUpdateDate.getTime()) {
      return 'unchanged';
    }
    const data = {
      marketplaceId: order.salesChannel?.marketplaceId ?? null,
      sellerSku: item.product?.sellerSku ?? null,
      asin: item.product?.asin ?? null,
      productName: item.product?.title ?? null,
      orderStatus: orderStatus || null,
      quantityOrdered,
      quantityShipped,
      quantityUnfulfilled,
      purchaseDate: this.parseOptionalDate(order.createdTime),
      lastUpdateDate,
      rawPayload: JSON.parse(JSON.stringify({ order, item })) as Prisma.InputJsonValue,
    } satisfies Prisma.AmazonFbmOrderItemUncheckedUpdateInput;
    await this.prisma.amazonFbmOrderItem.upsert({
      where: {
        connectionId_amazonOrderId_amazonOrderItemId: {
          connectionId,
          amazonOrderId: order.orderId,
          amazonOrderItemId: item.orderItemId,
        },
      },
      create: {
        connectionId,
        amazonOrderId: order.orderId,
        amazonOrderItemId: item.orderItemId,
        ...data,
      },
      update: data,
    });
    return existing ? 'updated' : 'created';
  }

  private async syncFbaOrders(
    connection: AmazonSpApiConnection,
    accessToken: string,
    region: AmazonSpApiRegion,
    marketplaceIds: string[],
    lastUpdatedAfter: Date,
    onProgress?: SyncProgressCallback,
  ): Promise<SyncCounters> {
    const counters = this.emptySyncCounters();
    await this.client.forEachOrderPage({
      accessToken,
      region,
      marketplaceIds,
      fulfilledBy: 'AMAZON',
      lastUpdatedAfter,
      includeRecipient: false,
    }, async (orders) => {
      const pageItems = orders.flatMap((order) =>
        (order.orderItems ?? []).map((item) => ({ order, item })));
      const existingRows = pageItems.length
        ? await this.prisma.amazonFbaOrderItem.findMany({
            where: {
              connectionId: connection.id,
              OR: pageItems.map(({ order, item }) => ({
                amazonOrderId: order.orderId,
                amazonOrderItemId: item.orderItemId,
              })),
            },
            select: { amazonOrderId: true, amazonOrderItemId: true, lastUpdateDate: true },
          })
        : [];
      const existingByKey = new Map(existingRows.map((row) => [
        this.amazonOrderItemKey(row.amazonOrderId, row.amazonOrderItemId),
        row,
      ]));
      for (const { order, item } of pageItems) {
        counters.fetched += 1;
        const key = {
          connectionId: connection.id,
          amazonOrderId: order.orderId,
          amazonOrderItemId: item.orderItemId,
        };
        const existing = existingByKey.get(this.amazonOrderItemKey(order.orderId, item.orderItemId));
        const lastUpdateDate = this.parseOptionalDate(order.lastUpdatedTime);
        if (existing?.lastUpdateDate && lastUpdateDate
          && existing.lastUpdateDate.getTime() >= lastUpdateDate.getTime()) {
          counters.unchanged += 1;
          continue;
        }
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
            lastUpdateDate,
            dashboardVisibleAt: new Date(),
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
            lastUpdateDate,
            rawPayload: JSON.parse(JSON.stringify({ order, item })) as Prisma.InputJsonValue,
          },
        });
        counters[existing ? 'updated' : 'created'] += 1;
      }
      await onProgress?.(counters);
    });
    return counters;
  }

  private async syncFbaInventory(
    connection: AmazonSpApiConnection,
    accessToken: string,
    region: AmazonSpApiRegion,
    marketplaceIds: string[],
    snapshotAt: Date,
    onProgress?: SyncProgressCallback,
  ): Promise<SyncCounters> {
    const counters = this.emptySyncCounters();
    for (const marketplaceId of marketplaceIds) {
      const currentSellerSkus: string[] = [];
      await this.client.forEachInventorySummaryPage(
        { accessToken, region, marketplaceId },
        async (rows) => {
          const pageRows = rows
            .map((row) => ({ row, sellerSku: String(row.sellerSku ?? '').trim() }))
            .filter(({ sellerSku }) => Boolean(sellerSku));
          if (!pageRows.length) return;
          const sellerSkus = pageRows.map(({ sellerSku }) => sellerSku);
          currentSellerSkus.push(...sellerSkus);
          counters.fetched += pageRows.length;
          const existingRows = await this.prisma.amazonFbaInventoryItem.findMany({
            where: { connectionId: connection.id, marketplaceId, sellerSku: { in: sellerSkus } },
            select: {
              sellerSku: true,
              fnSku: true,
              asin: true,
              productName: true,
              fulfillableQty: true,
              inboundWorkingQty: true,
              inboundShippedQty: true,
              inboundReceivingQty: true,
              reservedQty: true,
              unfulfillableQty: true,
              totalQty: true,
            },
          });
          const existingBySku = new Map(existingRows.map((row) => [row.sellerSku, row]));
          const operations = pageRows.flatMap(({ row, sellerSku }) => {
            const key = { connectionId: connection.id, marketplaceId, sellerSku };
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
            const existing = existingBySku.get(sellerSku);
            const unchanged = existing
              && existing.fnSku === values.fnSku
              && existing.asin === values.asin
              && existing.productName === values.productName
              && existing.fulfillableQty === values.fulfillableQty
              && existing.inboundWorkingQty === values.inboundWorkingQty
              && existing.inboundShippedQty === values.inboundShippedQty
              && existing.inboundReceivingQty === values.inboundReceivingQty
              && existing.reservedQty === values.reservedQty
              && existing.unfulfillableQty === values.unfulfillableQty
              && existing.totalQty === values.totalQty;
            if (unchanged) {
              counters.unchanged += 1;
              return [];
            }
            counters[existing ? 'updated' : 'created'] += 1;
            return [this.prisma.amazonFbaInventoryItem.upsert({
              where: { connectionId_marketplaceId_sellerSku: key },
              create: { ...key, ...values },
              update: values,
            })];
          });
          if (operations.length) await this.prisma.$transaction(operations);
          await onProgress?.(counters);
        },
      );
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
      lastFbmOrdersSyncedAt: row.lastFbmOrdersSyncedAt?.toISOString() ?? null,
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
    if (shop.platform !== ShopPlatform.amazon) {
      throw new BadRequestException('只有亚马逊店铺可以配置 Amazon SP-API 连接');
    }

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
    target.unchanged += value.unchanged;
    target.frozen += value.frozen;
    target.excluded += value.excluded;
    target.conflicts += value.conflicts;
  }

  private enqueueSyncTask<T>(task: () => Promise<T>): Promise<T> {
    this.queuedSyncTaskCount += 1;
    const result = this.syncQueueTail
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        this.queuedSyncTaskCount = Math.max(0, this.queuedSyncTaskCount - 1);
      });
    this.syncQueueTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async acquireConnectionLock(connectionId: bigint, lockToken: string): Promise<boolean> {
    const staleBefore = new Date(Date.now() - SYNC_LOCK_STALE_MS);
    const result = await this.prisma.amazonSpApiConnection.updateMany({
      where: {
        id: connectionId,
        OR: [
          { syncLockToken: null },
          { syncLockedAt: null },
          { syncLockedAt: { lt: staleBefore } },
        ],
      },
      data: { syncLockToken: lockToken, syncLockedAt: new Date() },
    });
    return result.count === 1;
  }

  private startConnectionLockHeartbeat(
    connectionId: bigint,
    lockToken: string,
  ): ReturnType<typeof setInterval> {
    return setInterval(() => {
      void this.prisma.amazonSpApiConnection.updateMany({
        where: { id: connectionId, syncLockToken: lockToken },
        data: { syncLockedAt: new Date() },
      }).then((result) => {
        if (result.count !== 1) {
          this.logger.error(`Amazon sync lock lost for connection ${connectionId.toString()}`);
        }
      }).catch((error) => {
        this.logger.error(
          `Amazon sync lock heartbeat failed for connection ${connectionId.toString()}: ${this.errorMessage(error)}`,
        );
      });
    }, SYNC_LOCK_HEARTBEAT_MS);
  }

  private async releaseConnectionLock(connectionId: bigint, lockToken: string): Promise<void> {
    try {
      await this.prisma.amazonSpApiConnection.updateMany({
        where: { id: connectionId, syncLockToken: lockToken },
        data: { syncLockToken: null, syncLockedAt: null },
      });
    } catch (error) {
      this.logger.error(
        `Amazon sync lock release failed for connection ${connectionId.toString()}: ${this.errorMessage(error)}`,
      );
    }
  }

  private emptySyncCounters(): SyncCounters {
    return {
      fetched: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      frozen: 0,
      excluded: 0,
      conflicts: 0,
    };
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
