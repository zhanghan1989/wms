import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import {
  BatchInboundItemStatus,
  BatchInboundOrderStatus,
  OrderSendStatus,
  Prisma,
  RakutenOrderRecord,
  RakutenRmsConnection,
  RakutenRmsSyncStatus,
  ShopPlatform,
} from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import * as XLSX from "xlsx";
import { parseRakutenOrderDate } from "../common/rakuten-order-date";
import { parseId } from "../common/utils";
import { PrismaService } from "../prisma/prisma.service";
import { CreateRakutenRmsConnectionDto } from "./dto/create-rakuten-rms-connection.dto";
import { IgnoreRakutenRmsConflictsDto } from "./dto/ignore-rakuten-rms-conflicts.dto";
import { PreviewRakutenRmsSyncDto } from "./dto/preview-rakuten-rms-sync.dto";
import { SyncRakutenRmsConnectionDto } from "./dto/sync-rakuten-rms-connection.dto";
import { UpdateRakutenRmsConnectionDto } from "./dto/update-rakuten-rms-connection.dto";
import { RakutenRmsApiClient } from "./rakuten-rms-api.client";
import { RakutenRmsApiCryptoService } from "./rakuten-rms-api-crypto.service";
import { RakutenJsonObject } from "./rakuten-rms-api.types";
import { buildRakutenStoreDashboard } from "./rakuten-store-dashboard";

const RAKUTEN_SYNC_CRON = process.env.RAKUTEN_RMS_API_SYNC_CRON || "0 */15 * * * *";
const RAKUTEN_SYNC_TIMEZONE = process.env.RAKUTEN_RMS_API_SYNC_TIMEZONE || "Asia/Tokyo";
const RAKUTEN_SCHEDULED_SYNC_ENABLED =
  String(process.env.RAKUTEN_RMS_API_SCHEDULED_SYNC_ENABLED ?? "false").toLowerCase() === "true";
const ORDER_SYNC_OVERLAP_MS = 6 * 60 * 60 * 1000;
const PENDING_SHIPMENT_ORDER_PROGRESS = 300;
const IMPORTABLE_ORDER_PROGRESS = [PENDING_SHIPMENT_ORDER_PROGRESS];
const CONNECTION_TEST_LOOKBACK_DAYS = 62;
const PREVIEW_EXPIRY_MS = 30 * 60 * 1000;
const MANUAL_OVERRIDE_KEY = "_wmsManualOverrideFields";
const LEGACY_RAKUTEN_DEFAULT_SHOP_NAME = "乐天-1号店";
const RAKUTEN_FACTORY_LOOKBACK_DAYS = 90;

type SyncCounters = {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  manualActions: number;
};
type SyncPlanAction =
  | "create"
  | "update"
  | "claim"
  | "frozen"
  | "manual_action"
  | "excluded"
  | "ignored"
  | "conflict";
type RakutenOrderWriteData = Omit<Prisma.RakutenOrderRecordUncheckedCreateInput, "rowHash" | "sendStatus">;

interface SyncPlan {
  action: SyncPlanAction;
  item: MappedRakutenItem;
  existing: RakutenOrderRecord | null;
  reason: string | null;
  changedFields: string[];
  manualActionType?: "update" | "cancel";
  observedHash?: string;
}

interface SyncPlanDescriptor {
  itemKey: string;
  action: SyncPlanAction;
  existingId: string | null;
  existingUpdatedAt: string | null;
}

interface SyncChangeSnapshot {
  action: "created" | "updated";
  recordId: string;
  before: Record<string, unknown> | null;
  afterUpdatedAt: string;
}

interface MappedRakutenItem {
  orderId: string;
  itemKey: string;
  skuCode: string | null;
  isComboOrder: boolean;
  comboOrderSku: string | null;
  setComponentSkuCode: string | null;
  orderQuantity: number;
  productName: string | null;
  productNameExtra: string | null;
  deliveryClass: string | null;
  orderStatusText: string | null;
  orderImportedAtRaw: string | null;
  orderRemark: string | null;
  shippingName: string | null;
  shippingPostalCode: string | null;
  shippingPrefecture: string | null;
  shippingCity: string | null;
  shippingAddress: string | null;
  shippingPhone: string | null;
  deliveryMethod: string | null;
  deliveryDateRaw: string | null;
  deliveryTimeSlot: string | null;
  rawPayload: Prisma.InputJsonValue;
}

interface RakutenDashboardQueryRow {
  rmsConnectionId: bigint | null;
  orderId: string | null;
  skuCode: string | null;
  productName: string | null;
  orderQuantity: number | null;
  orderStatusText: string | null;
  orderImportedAtRaw: Date | null;
  dispatchMode: string | null;
  shipmentNo: string | null;
  trackingIsDelivered: boolean | number;
  salesAmount: Prisma.Decimal | number | string | null;
}

@Injectable()
export class RakutenRmsApiService {
  private readonly logger = new Logger(RakutenRmsApiService.name);
  private readonly runningConnectionIds = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: RakutenRmsApiClient,
    private readonly crypto: RakutenRmsApiCryptoService,
  ) {}

  async listConnections(): Promise<unknown[]> {
    const rows = await this.prisma.rakutenRmsConnection.findMany({
      include: { shop: { select: { id: true, name: true } } },
      orderBy: { id: "asc" },
    });
    return rows.map((row) => this.serializeConnection(row));
  }

  async getStoreDashboard(connectionIdRaw?: string, daysRaw?: string): Promise<unknown> {
    const days = [7, 30, 90].includes(Number(daysRaw)) ? Number(daysRaw) : 30;
    const connections = await this.prisma.rakutenRmsConnection.findMany({
      where: { status: 1, syncOrders: true },
      include: { shop: { select: { id: true, name: true } } },
      orderBy: { id: "asc" },
    });
    const requestedId = connectionIdRaw ? parseId(connectionIdRaw, "connectionId") : null;
    const selected = requestedId ? connections.find((row) => row.id === requestedId) : connections[0];
    if (requestedId && !selected) throw new NotFoundException("所选乐天店铺连接不存在或已停用");
    const shops = connections.map((row) => ({
      connectionId: row.id.toString(),
      shopId: row.shopId.toString(),
      shopName: row.shop.name,
      lastOrdersSyncedAt: row.lastOrdersSyncedAt?.toISOString() ?? null,
      hasSyncError: Boolean(row.lastSyncError),
    }));
    if (!selected) {
      return { generatedAt: new Date().toISOString(), days, shops, selectedShop: null, dashboard: null };
    }
    const includesLegacyData = selected.shop.name === LEGACY_RAKUTEN_DEFAULT_SHOP_NAME;
    const now = new Date();
    const analysisDays = Math.max(days * 2, 90);
    const analysisStart = new Date(now.getTime() - analysisDays * 24 * 60 * 60 * 1000);
    const analysisEndDay = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const orderScope = includesLegacyData
      ? Prisma.sql`(rms_connection_id = ${selected.id} OR rms_connection_id IS NULL)`
      : Prisma.sql`rms_connection_id = ${selected.id}`;
    const latestSyncRunPromise = this.prisma.rakutenRmsSyncRun.findFirst({
      where: { connectionId: selected.id },
      orderBy: { startedAt: "desc" },
      select: {
        status: true, startedAt: true, finishedAt: true, fetchedCount: true,
        createdCount: true, updatedCount: true, skippedCount: true, errorMessage: true,
      },
    });
    const factoryPeriodStart = new Date(now.getTime() - RAKUTEN_FACTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const factoryDateStart = new Date(`${this.formatTokyoDateKey(factoryPeriodStart, "-")}T00:00:00.000Z`);
    const factoryDateEnd = new Date(`${this.formatTokyoDateKey(analysisEndDay, "-")}T00:00:00.000Z`);
    const activeConnectionIds = connections.map((connection) => connection.id);
    const [orderRows, factoryOrderRows] = await Promise.all([
      this.prisma.$queryRaw<RakutenDashboardQueryRow[]>(Prisma.sql`
        SELECT /*+ MAX_EXECUTION_TIME(15000) */
          rms_connection_id AS rmsConnectionId,
          order_id AS orderId,
          sku_code AS skuCode,
          product_name AS productName,
          order_quantity AS orderQuantity,
          order_status_text AS orderStatusText,
          order_imported_date AS orderImportedAtRaw,
          dispatch_mode AS dispatchMode,
          shipment_no AS shipmentNo,
          tracking_is_delivered AS trackingIsDelivered,
          COALESCE(
            CAST(NULLIF(NULLIF(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.rmsItem.subtotalPrice')), ',', ''), ''), 'null') AS DECIMAL(16, 2)),
            CAST(NULLIF(NULLIF(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.rmsItem.subtotal')), ',', ''), ''), 'null') AS DECIMAL(16, 2)),
            CAST(NULLIF(NULLIF(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.rmsItem.price')), ',', ''), ''), 'null') AS DECIMAL(16, 2)) * COALESCE(order_quantity, 0),
            CAST(NULLIF(NULLIF(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.rmsItem.itemPrice')), ',', ''), ''), 'null') AS DECIMAL(16, 2)) * COALESCE(order_quantity, 0),
            CAST(NULLIF(NULLIF(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.rmsItem.unitPrice')), ',', ''), ''), 'null') AS DECIMAL(16, 2)) * COALESCE(order_quantity, 0),
            CAST(NULLIF(NULLIF(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$."単価"')), ',', ''), ''), 'null') AS DECIMAL(16, 2)) * COALESCE(order_quantity, 0),
            CAST(NULLIF(NULLIF(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.unitPrice')), ',', ''), ''), 'null') AS DECIMAL(16, 2)) * COALESCE(order_quantity, 0),
            0
          ) AS salesAmount
        FROM rakuten_order_records
        WHERE ${orderScope}
          AND order_imported_date >= ${this.formatTokyoDateKey(analysisStart, "-")}
          AND order_imported_date < ${this.formatTokyoDateKey(analysisEndDay, "-")}
      `),
      this.prisma.rakutenOrderRecord.findMany({
        where: {
          OR: [
            { rmsConnectionId: { in: activeConnectionIds } },
            { rmsConnectionId: null },
          ],
          orderImportedDate: { gte: factoryDateStart, lt: factoryDateEnd },
        },
        select: {
          rmsConnectionId: true,
          orderId: true,
          skuCode: true,
          productName: true,
          orderQuantity: true,
          orderStatusText: true,
          orderImportedDate: true,
          dispatchMode: true,
          shipmentNo: true,
          trackingIsDelivered: true,
        },
      }),
    ]);
    const orders = orderRows.map((row) => ({
      ...row,
      trackingIsDelivered: Boolean(row.trackingIsDelivered),
      salesAmount: Number(row.salesAmount ?? 0),
    }));
    const factoryOrders = factoryOrderRows.map((row) => ({
      ...row,
      orderImportedAtRaw: row.orderImportedDate,
      salesAmount: 0,
    }));
    const productIds = Array.from(new Set(
      [...orders, ...factoryOrders]
        .map((row) => String(row.skuCode ?? "").trim())
        .filter(Boolean),
    ));
    const [products, inTransitRows, latestSyncRun] = await Promise.all([
      productIds.length
        ? this.prisma.masterProduct.findMany({
          where: { productId: { in: productIds } },
          select: { productId: true, productName: true, stockQty: true },
        })
        : Promise.resolve([]),
      productIds.length
        ? this.prisma.batchInboundItem.groupBy({
          by: ["productId"],
          where: {
            productId: { in: productIds },
            status: BatchInboundItemStatus.pending,
            order: {
              domesticOrderNo: { not: "" },
              status: {
                in: [
                  BatchInboundOrderStatus.waiting_upload,
                  BatchInboundOrderStatus.waiting_inbound,
                ],
              },
            },
          },
          _sum: { qty: true },
        })
        : Promise.resolve([]),
      latestSyncRunPromise,
    ]);
    const selectedShop = {
      connectionId: selected.id.toString(),
      shopId: selected.shopId.toString(),
      shopName: selected.shop.name,
      lastOrdersSyncedAt: selected.lastOrdersSyncedAt?.toISOString() ?? null,
      lastSuccessfulSyncAt: selected.lastSuccessfulSyncAt?.toISOString() ?? null,
      licenseExpiresAt: selected.licenseExpiresAt?.toISOString() ?? null,
      syncIssue: selected.lastSyncError ? { message: selected.lastSyncError } : null,
      includesLegacyData,
    };
    return {
      generatedAt: new Date().toISOString(),
      days,
      shops,
      selectedShop,
      latestSyncRun: latestSyncRun ? {
        ...latestSyncRun,
        startedAt: latestSyncRun.startedAt.toISOString(),
        finishedAt: latestSyncRun.finishedAt?.toISOString() ?? null,
      } : null,
      sourceSummary: {
        apiItemCount: orders.filter((row) => row.rmsConnectionId === selected.id).length,
        legacyItemCount: orders.filter((row) => row.rmsConnectionId === null).length,
        includesLegacyData,
      },
      dashboard: buildRakutenStoreDashboard({
        now,
        days,
        orders,
        factoryOrders,
        products,
        inTransit: inTransitRows.map((row) => ({
          productId: row.productId,
          inTransitQty: Number(row._sum.qty ?? 0),
        })),
      }),
    };
  }

  async buildStoreFactoryRecommendationsExcel(
    connectionIdRaw?: string,
  ): Promise<{ fileName: string; content: Buffer }> {
    const payload = await this.getStoreDashboard(connectionIdRaw, "90") as {
      selectedShop?: { shopName?: string } | null;
      dashboard?: { factoryRecommendations?: { rows?: Array<{
        skuCode?: string; productId?: string; productName?: string | null;
        unitCount90d?: number; averageDaily90d?: number; pendingShipmentQty?: number;
        stockQty?: number; inTransitQty?: number; effectiveStockQty?: number;
        productionLogisticsDemandQty?: number; remainingQtyAtArrival?: number;
        targetStockQty?: number; suggestedFactoryQty?: number;
      }> } } | null;
    };
    if (!payload.selectedShop) throw new NotFoundException("尚无已启用的乐天店铺连接");
    const scopeName = "乐天渠道（全部店铺）";
    const data = (payload.dashboard?.factoryRecommendations?.rows ?? []).map((row) => ({
      "统计范围": scopeName,
      "产品ID": row.productId ?? "",
      "乐天SKU": row.skuCode ?? "",
      "产品名称": row.productName ?? "",
      "近90天销量": Number(row.unitCount90d ?? 0),
      "90天日均销量": Number(row.averageDaily90d ?? 0),
      "当前日本库存": Number(row.stockQty ?? 0),
      "国内单号在途数量": Number(row.inTransitQty ?? 0),
      "待发货占用": Number(row.pendingShipmentQty ?? 0),
      "有效库存": Number(row.effectiveStockQty ?? 0),
      "45天预计消耗": Number(row.productionLogisticsDemandQty ?? 0),
      "预计到货剩余": Number(row.remainingQtyAtArrival ?? 0),
      "90天目标库存": Number(row.targetStockQty ?? 0),
      "建议工厂备货数量": Number(row.suggestedFactoryQty ?? 0),
    }));
    const worksheet = XLSX.utils.json_to_sheet(data, {
      header: ["统计范围", "产品ID", "乐天SKU", "产品名称", "近90天销量", "90天日均销量", "当前日本库存", "国内单号在途数量", "待发货占用", "有效库存", "45天预计消耗", "预计到货剩余", "90天目标库存", "建议工厂备货数量"],
    });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "乐天工厂备货建议");
    const content = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const date = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      fileName: `乐天工厂备货建议-全部店铺-${date.year}-${date.month}-${date.day}.xlsx`,
      content,
    };
  }

  async createConnection(payload: CreateRakutenRmsConnectionDto): Promise<unknown> {
    const shopId = parseId(payload.shopId, "shopId");
    const shop = await this.prisma.shop.findUnique({
      where: { id: shopId },
      select: { id: true, platform: true },
    });
    if (!shop) throw new NotFoundException("店铺不存在");
    if (shop.platform !== ShopPlatform.rakuten) {
      throw new BadRequestException("只有乐天店铺可以配置乐天 RMS API 连接");
    }
    const existing = await this.prisma.rakutenRmsConnection.findUnique({
      where: { shopId },
    });
    if (existing) throw new ConflictException("该店铺已经配置乐天 RMS API 连接");
    const serviceSecret = this.crypto.encrypt(payload.serviceSecret.trim());
    const licenseKey = this.crypto.encrypt(payload.licenseKey.trim());
    const created = await this.prisma.rakutenRmsConnection.create({
      data: {
        shopId,
        encryptedServiceSecret: serviceSecret.encryptedValue,
        serviceSecretIv: serviceSecret.iv,
        serviceSecretAuthTag: serviceSecret.authTag,
        encryptedLicenseKey: licenseKey.encryptedValue,
        licenseKeyIv: licenseKey.iv,
        licenseKeyAuthTag: licenseKey.authTag,
        licenseExpiresAt: this.parseOptionalDate(payload.licenseExpiresAt),
        status: payload.status ?? 1,
        syncOrders: payload.syncOrders ?? true,
      },
      include: { shop: { select: { id: true, name: true } } },
    });
    return this.serializeConnection(created);
  }

  async updateConnection(idRaw: string, payload: UpdateRakutenRmsConnectionDto): Promise<unknown> {
    const id = parseId(idRaw, "id");
    const current = await this.prisma.rakutenRmsConnection.findUnique({
      where: { id },
    });
    if (!current) throw new NotFoundException("乐天 RMS API 连接不存在");
    const serviceSecret = payload.serviceSecret ? this.crypto.encrypt(payload.serviceSecret.trim()) : null;
    const licenseKey = payload.licenseKey ? this.crypto.encrypt(payload.licenseKey.trim()) : null;
    const updated = await this.prisma.rakutenRmsConnection.update({
      where: { id },
      data: {
        ...(serviceSecret
          ? {
              encryptedServiceSecret: serviceSecret.encryptedValue,
              serviceSecretIv: serviceSecret.iv,
              serviceSecretAuthTag: serviceSecret.authTag,
            }
          : {}),
        ...(licenseKey
          ? {
              encryptedLicenseKey: licenseKey.encryptedValue,
              licenseKeyIv: licenseKey.iv,
              licenseKeyAuthTag: licenseKey.authTag,
              lastSyncError: null,
            }
          : {}),
        ...(payload.licenseExpiresAt !== undefined
          ? {
              licenseExpiresAt: this.parseOptionalDate(payload.licenseExpiresAt),
            }
          : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.syncOrders !== undefined ? { syncOrders: payload.syncOrders } : {}),
      },
      include: { shop: { select: { id: true, name: true } } },
    });
    return this.serializeConnection(updated);
  }

  async testConnection(idRaw: string): Promise<unknown> {
    const connection = await this.loadConnection(idRaw, false);
    this.assertLicenseActive(connection);
    const credentials = this.decryptCredentials(connection);
    const end = new Date();
    const probe = await this.client.probeOrders(credentials.serviceSecret, credentials.licenseKey, {
      start: new Date(end.getTime() - CONNECTION_TEST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
      end,
    });
    const sampleOrderNumber = probe.sampleOrderNumber;
    if (sampleOrderNumber) {
      await this.client.getOrders(credentials.serviceSecret, credentials.licenseKey, [sampleOrderNumber]);
    }
    return {
      ok: true,
      matchedOrderCount: probe.matchedOrderCount,
      testedOperations: {
        searchOrder: true,
        getOrder: Boolean(sampleOrderNumber),
      },
      getOrderSkippedReason: sampleOrderNumber ? null : "近62天没有可用于测试 getOrder 的订单",
      testedAt: end.toISOString(),
    };
  }

  async syncConnection(idRaw: string, payload: SyncRakutenRmsConnectionDto): Promise<unknown> {
    const connection = await this.loadConnection(idRaw, true);
    const preview = await this.prisma.rakutenRmsSyncPreview.findUnique({
      where: { token: payload.previewToken },
    });
    if (!preview || preview.connectionId !== connection.id) {
      throw new BadRequestException("同步预览不存在或不属于当前店铺");
    }
    if (preview.usedAt) throw new ConflictException("该同步预览已经使用，请重新预览");
    if (preview.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException("同步预览已过期，请重新预览");
    }
    const previewData = preview.previewData as unknown as {
      mappedItems: MappedRakutenItem[];
      planDescriptors: SyncPlanDescriptor[];
      searchedOrderCount: number;
      reconciledOrderCount: number;
      requestedOrderCount: number;
      truncated: boolean;
    };
    if (previewData.planDescriptors.some((plan) => plan.action === "conflict")) {
      throw new ConflictException("预览中存在冲突订单，请处理后重新预览");
    }
    if (previewData.mappedItems.length !== previewData.planDescriptors.length) {
      throw new BadRequestException("同步预览数据不完整，请重新预览");
    }
    return this.runSync(connection, {
      previewToken: preview.token,
      mappedItems: previewData.mappedItems,
      expectedPlans: previewData.planDescriptors,
      searchedOrderCount: previewData.searchedOrderCount,
      reconciledOrderCount: previewData.reconciledOrderCount,
      requestedOrderCount: previewData.requestedOrderCount,
      truncated: previewData.truncated,
    });
  }

  async previewConnection(idRaw: string, payload: PreviewRakutenRmsSyncDto = {}): Promise<unknown> {
    const connection = await this.loadConnection(idRaw, true);
    const initialLookbackDays = payload.initialLookbackDays ?? 7;
    const maxOrders = payload.maxOrders;
    const fetched = await this.fetchSyncItems(connection, initialLookbackDays, maxOrders);
    const plans: SyncPlan[] = [];
    for (const item of fetched.mappedItems) {
      plans.push(await this.planOrderItem(this.prisma, connection, item));
    }
    const conflictCount = plans.filter((plan) => plan.action === "conflict").length;
    const summary = {
      fetched: plans.length,
      create: plans.filter((plan) => plan.action === "create").length,
      update: plans.filter((plan) => plan.action === "update" && plan.changedFields.length > 0).length,
      unchanged: plans.filter((plan) => plan.action === "update" && plan.changedFields.length === 0).length,
      claim: plans.filter((plan) => plan.action === "claim").length,
      frozen: plans.filter((plan) => plan.action === "frozen").length,
      manualAction: plans.filter((plan) => plan.action === "manual_action").length,
      excluded: plans.filter((plan) => plan.action === "excluded").length,
      ignored: plans.filter((plan) => plan.action === "ignored").length,
      conflict: conflictCount,
    };
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + PREVIEW_EXPIRY_MS);
    const planDescriptors = plans.map((plan) => this.describePlan(plan));
    const previewItems = plans
      .map((plan) => ({
        orderId: plan.item.orderId,
        orderImportedAtRaw: plan.item.orderImportedAtRaw,
        itemKey: plan.item.itemKey,
        skuCode: plan.item.skuCode,
        action: plan.action === "update" && plan.changedFields.length === 0 ? "unchanged" : plan.action,
        existingId: plan.existing?.id.toString() ?? null,
        changedFields: plan.changedFields,
        reason: plan.reason,
      }))
      .sort((left, right) => {
        const timeDifference = this.sortableOrderTime(right.orderImportedAtRaw)
          - this.sortableOrderTime(left.orderImportedAtRaw);
        if (timeDifference) return timeDifference;
        return right.orderId.localeCompare(left.orderId, undefined, { numeric: true, sensitivity: "base" });
      });
    await this.prisma.rakutenRmsSyncPreview.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    await this.prisma.rakutenRmsSyncPreview.create({
      data: {
        token,
        connectionId: connection.id,
        expiresAt,
        previewData: this.toJson({
          mappedItems: fetched.mappedItems,
          planDescriptors,
          searchedOrderCount: fetched.searchedOrderCount,
          reconciledOrderCount: fetched.reconciledOrderCount,
          requestedOrderCount: fetched.requestedOrderCount,
          truncated: fetched.truncated,
        }),
      },
    });
    return {
      previewToken: token,
      expiresAt: expiresAt.toISOString(),
      appliedLimits: { initialLookbackDays, maxOrders: maxOrders ?? null },
      ...fetched,
      mappedItems: undefined,
      summary,
      canConfirm: conflictCount === 0,
      items: previewItems,
    };
  }

  async ignorePreviewConflicts(
    idRaw: string,
    payload: IgnoreRakutenRmsConflictsDto,
    createdBy: bigint,
  ): Promise<{ ignoredCount: number; orderCount: number }> {
    const connection = await this.loadConnection(idRaw, true);
    const preview = await this.prisma.rakutenRmsSyncPreview.findUnique({
      where: { token: payload.previewToken },
    });
    if (!preview || preview.connectionId !== connection.id) {
      throw new BadRequestException("同步预览不存在或不属于当前店铺");
    }
    if (preview.usedAt) throw new ConflictException("该同步预览已经使用，请重新预览");
    if (preview.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException("同步预览已过期，请重新预览");
    }
    const previewData = preview.previewData as unknown as {
      mappedItems: MappedRakutenItem[];
      planDescriptors: SyncPlanDescriptor[];
    };
    if (
      !Array.isArray(previewData.mappedItems) ||
      !Array.isArray(previewData.planDescriptors) ||
      previewData.mappedItems.length !== previewData.planDescriptors.length
    ) {
      throw new BadRequestException("同步预览数据不完整，请重新预览");
    }
    const requestedKeys = new Set(payload.itemKeys);
    const selected: MappedRakutenItem[] = [];
    for (let index = 0; index < previewData.mappedItems.length; index += 1) {
      const item = previewData.mappedItems[index];
      if (!requestedKeys.has(item.itemKey)) continue;
      const expected = previewData.planDescriptors[index];
      if (!expected || expected.itemKey !== item.itemKey || expected.action !== "conflict") {
        throw new BadRequestException(`明细 ${item.itemKey} 不是可忽略的冲突，请重新预览`);
      }
      selected.push(item);
    }
    if (selected.length !== requestedKeys.size) {
      throw new BadRequestException("部分冲突明细不在当前预览中，请重新预览");
    }

    await this.prisma.$transaction(async (tx) => {
      for (const item of selected) {
        const currentPlan = await this.planOrderItem(tx, connection, item);
        if (currentPlan.action !== "conflict") {
          throw new ConflictException(`订单 ${item.orderId} / ${item.skuCode ?? "-"} 的冲突状态已变化，请重新预览`);
        }
        const existingIgnore = await tx.rakutenOrderSyncExclusion.findFirst({
          where: {
            rmsConnectionId: connection.id,
            shopName: null,
            orderId: item.orderId,
            rmsItemKey: item.itemKey,
            reason: "conflict_ignore",
          },
          select: { id: true },
        });
        if (!existingIgnore) {
          await tx.rakutenOrderSyncExclusion.create({
            data: {
              rmsConnectionId: connection.id,
              orderId: item.orderId,
              rmsItemKey: item.itemKey,
              reason: "conflict_ignore",
              createdBy,
            },
          });
        }
      }
    });
    return {
      ignoredCount: selected.length,
      orderCount: new Set(selected.map((item) => item.orderId)).size,
    };
  }

  async syncAllConnections(): Promise<{ results: unknown[] }> {
    const rows = await this.prisma.rakutenRmsConnection.findMany({
      where: { status: 1, syncOrders: true },
      include: { shop: true },
      orderBy: { id: "asc" },
    });
    const results: unknown[] = [];
    for (const row of rows) {
      try {
        const fetched = await this.fetchSyncItems(row, 7);
        results.push(await this.runSync(row, fetched));
      } catch (error) {
        results.push({
          connectionId: row.id.toString(),
          shopName: row.shop.name,
          error: this.errorMessage(error),
        });
      }
    }
    return { results };
  }

  async listSyncRuns(connectionIdRaw?: string, limitRaw?: string): Promise<unknown[]> {
    const connectionId = connectionIdRaw ? parseId(connectionIdRaw, "connectionId") : undefined;
    const limit = Math.min(Math.max(Number(limitRaw ?? 50) || 50, 1), 200);
    const rows = await this.prisma.rakutenRmsSyncRun.findMany({
      where: connectionId ? { connectionId } : {},
      include: {
        connection: { include: { shop: { select: { id: true, name: true } } } },
      },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
    return rows.map((row) => {
      const snapshot = row.changeSnapshot as unknown as {
        changes?: unknown[];
      } | null;
      const changeCount = Array.isArray(snapshot?.changes) ? snapshot.changes.length : 0;
      return {
        id: row.id.toString(),
        connectionId: row.connectionId.toString(),
        status: row.status,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        fetchedCount: row.fetchedCount,
        createdCount: row.createdCount,
        updatedCount: row.updatedCount,
        skippedCount: row.skippedCount,
        manualActionCount: row.manualActionCount,
        errorMessage: row.errorMessage,
        changeCount,
        rollbackAvailable: changeCount > 0 && !row.rolledBackAt,
        rolledBackAt: row.rolledBackAt?.toISOString() ?? null,
        connection: {
          id: row.connection.id.toString(),
          shop: {
            id: row.connection.shop.id.toString(),
            name: row.connection.shop.name,
          },
        },
      };
    });
  }

  async rollbackSyncRun(idRaw: string): Promise<unknown> {
    const id = parseId(idRaw, "id");
    const run = await this.prisma.rakutenRmsSyncRun.findUnique({
      where: { id },
    });
    if (!run) throw new NotFoundException("乐天同步批次不存在");
    if (run.rolledBackAt) throw new ConflictException("该同步批次已经回滚");
    if (run.status !== RakutenRmsSyncStatus.success && run.status !== RakutenRmsSyncStatus.partial) {
      throw new BadRequestException("只有已完成的同步批次可以回滚");
    }
    const newerRun = await this.prisma.rakutenRmsSyncRun.findFirst({
      where: {
        connectionId: run.connectionId,
        startedAt: { gt: run.startedAt },
        status: {
          in: [RakutenRmsSyncStatus.success, RakutenRmsSyncStatus.partial],
        },
        rolledBackAt: null,
      },
      select: { id: true },
    });
    if (newerRun) {
      throw new ConflictException("该批次之后还有未回滚的同步，请从最新批次开始回滚");
    }
    const snapshot = run.changeSnapshot as unknown as {
      connectionBefore?: {
        lastOrdersSyncedAt?: string | null;
        lastSuccessfulSyncAt?: string | null;
        lastSyncError?: string | null;
      };
      changes?: SyncChangeSnapshot[];
    } | null;
    const changes = Array.isArray(snapshot?.changes) ? snapshot.changes : [];
    if (!changes.length) throw new BadRequestException("该同步批次没有可回滚的订单变更");
    const rolledBackAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const change of [...changes].reverse()) {
        const recordId = parseId(change.recordId, "recordId");
        const current = await tx.rakutenOrderRecord.findUnique({
          where: { id: recordId },
        });
        if (!current) throw new ConflictException(`订单记录 ${change.recordId} 已不存在，无法安全回滚`);
        if (current.updatedAt.toISOString() !== change.afterUpdatedAt) {
          throw new ConflictException(`订单记录 ${change.recordId} 在同步后又被修改，已拒绝回滚`);
        }
        const freezeReason = await this.resolveFreezeReason(tx, current);
        if (freezeReason) {
          throw new ConflictException(`订单记录 ${change.recordId}${freezeReason}，已拒绝回滚`);
        }
        if (change.action === "created") {
          await tx.rakutenOrderRecord.delete({ where: { id: recordId } });
        } else if (change.before) {
          await tx.rakutenOrderRecord.update({
            where: { id: recordId },
            data: this.restoreOrderSnapshot(change.before),
          });
        }
      }
      await tx.rakutenRmsConnection.update({
        where: { id: run.connectionId },
        data: {
          lastOrdersSyncedAt: this.parseSnapshotDate(snapshot?.connectionBefore?.lastOrdersSyncedAt),
          lastSuccessfulSyncAt: this.parseSnapshotDate(snapshot?.connectionBefore?.lastSuccessfulSyncAt),
          lastSyncError: snapshot?.connectionBefore?.lastSyncError ?? null,
        },
      });
      await tx.rakutenRmsSyncRun.update({
        where: { id },
        data: { rolledBackAt },
      });
    });
    return {
      syncRunId: id.toString(),
      rolledBackAt: rolledBackAt.toISOString(),
      restoredCount: changes.length,
    };
  }

  @Cron(RAKUTEN_SYNC_CRON, {
    name: "rakuten-rms-api-sync",
    timeZone: RAKUTEN_SYNC_TIMEZONE,
  })
  async runScheduledSync(): Promise<void> {
    if (!RAKUTEN_SCHEDULED_SYNC_ENABLED) return;
    try {
      const result = await this.syncAllConnections();
      this.logger.log(`Rakuten scheduled sync completed: connections=${result.results.length}`);
    } catch (error) {
      this.logger.error(`Rakuten scheduled sync failed: ${this.errorMessage(error)}`);
    }
  }

  private async runSync(
    connection: RakutenRmsConnection & { shop: { id: bigint; name: string } },
    input: {
      mappedItems: MappedRakutenItem[];
      searchedOrderCount: number;
      reconciledOrderCount: number;
      requestedOrderCount: number;
      previewToken?: string;
      expectedPlans?: SyncPlanDescriptor[];
      truncated?: boolean;
    },
  ): Promise<unknown> {
    const connectionKey = connection.id.toString();
    if (this.runningConnectionIds.has(connectionKey)) {
      throw new ConflictException("该乐天店铺正在同步，请稍后再试");
    }
    this.assertLicenseActive(connection);
    this.runningConnectionIds.add(connectionKey);
    let run: Awaited<ReturnType<typeof this.prisma.rakutenRmsSyncRun.create>> | null = null;
    const counters: SyncCounters = {
      fetched: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      manualActions: 0,
    };
    let conflictCount = 0;
    const now = new Date();
    try {
      const activeRun = await this.prisma.rakutenRmsSyncRun.create({
        data: { connectionId: connection.id },
      });
      run = activeRun;
      const finishedAt = new Date();
      const changes = await this.prisma.$transaction(async (tx) => {
        const snapshots: SyncChangeSnapshot[] = [];
        if (input.previewToken) {
          const consumed = await tx.rakutenRmsSyncPreview.updateMany({
            where: {
              token: input.previewToken,
              usedAt: null,
              expiresAt: { gt: new Date() },
            },
            data: { usedAt: finishedAt },
          });
          if (consumed.count !== 1) {
            throw new ConflictException("同步预览已经使用或过期，请重新预览");
          }
        }
        for (let index = 0; index < input.mappedItems.length; index += 1) {
          const item = input.mappedItems[index];
          counters.fetched += 1;
          const plan = await this.planOrderItem(tx, connection, item);
          const expected = input.expectedPlans?.[index];
          if (expected && !this.planMatchesDescriptor(plan, expected)) {
            throw new ConflictException(`订单 ${item.orderId} / ${item.skuCode ?? "-"} 在预览后发生变化，请重新预览`);
          }
          if (
            plan.action === "conflict" ||
            plan.action === "frozen" ||
            plan.action === "manual_action" ||
            plan.action === "excluded" ||
            plan.action === "ignored"
          ) {
            counters.skipped += 1;
            if (plan.action === "conflict") conflictCount += 1;
            if (plan.action === "manual_action") {
              await this.recordXiyaManualAction(tx, plan, now);
              counters.manualActions += 1;
            } else if (plan.action === "frozen" && plan.existing?.xiyaExportedAt) {
              await tx.rakutenOrderRecord.update({
                where: { id: plan.existing.id },
                data: { rmsLastSyncedAt: now },
              });
            }
            continue;
          }
          const snapshot = await this.applyOrderPlan(tx, connection, plan, now);
          snapshots.push(snapshot);
          if (plan.action === "create") counters.created += 1;
          else if (plan.action === "update" && plan.changedFields.length === 0) counters.unchanged += 1;
          else counters.updated += 1;
        }
        const hasConflicts = conflictCount > 0;
        const incompleteByLimit = Boolean(input.truncated);
        const isPartial = hasConflicts || incompleteByLimit;
        await tx.rakutenRmsSyncRun.update({
          where: { id: activeRun.id },
          data: {
            status: isPartial ? RakutenRmsSyncStatus.partial : RakutenRmsSyncStatus.success,
            finishedAt,
            fetchedCount: counters.fetched,
            createdCount: counters.created,
            updatedCount: counters.updated,
            skippedCount: counters.skipped,
            manualActionCount: counters.manualActions,
            changeSnapshot: this.toJson({
              connectionBefore: {
                lastOrdersSyncedAt: connection.lastOrdersSyncedAt?.toISOString() ?? null,
                lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt?.toISOString() ?? null,
                lastSyncError: connection.lastSyncError,
              },
              changes: snapshots,
            }),
          },
        });
        await tx.rakutenRmsConnection.update({
          where: { id: connection.id },
          data: {
            ...(!hasConflicts && !input.truncated ? { lastOrdersSyncedAt: now } : {}),
            ...(!hasConflicts ? { lastSuccessfulSyncAt: finishedAt } : {}),
            lastSyncError: hasConflicts
              ? `${conflictCount} 条订单存在严格匹配冲突，请人工处理`
              : incompleteByLimit
                ? "本次预览设置了订单数量限制，同步水位未推进"
                : null,
          },
        });
        return snapshots;
      });
      return {
        syncRunId: activeRun.id.toString(),
        connectionId: connectionKey,
        shopName: connection.shop.name,
        searchedOrderCount: input.searchedOrderCount,
        reconciledOrderCount: input.reconciledOrderCount,
        requestedOrderCount: input.requestedOrderCount,
        rollbackAvailable: changes.length > 0,
        ...counters,
        startedAt: activeRun.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      };
    } catch (error) {
      const message = this.errorMessage(error).slice(0, 10000);
      if (run) {
        await this.prisma.$transaction([
          this.prisma.rakutenRmsSyncRun.update({
            where: { id: run.id },
            data: {
              status: RakutenRmsSyncStatus.failed,
              finishedAt: new Date(),
              fetchedCount: counters.fetched,
              createdCount: counters.created,
              updatedCount: counters.updated,
              skippedCount: counters.skipped,
              manualActionCount: counters.manualActions,
              errorMessage: message,
            },
          }),
          this.prisma.rakutenRmsConnection.update({
            where: { id: connection.id },
            data: { lastSyncError: message },
          }),
        ]);
      }
      throw error;
    } finally {
      this.runningConnectionIds.delete(connectionKey);
    }
  }

  private async fetchSyncItems(
    connection: RakutenRmsConnection & { shop: { id: bigint; name: string } },
    initialLookbackDays: number,
    maxOrders?: number,
  ): Promise<{
    mappedItems: MappedRakutenItem[];
    searchedOrderCount: number;
    reconciledOrderCount: number;
    requestedOrderCount: number;
    truncated: boolean;
  }> {
    this.assertLicenseActive(connection);
    const credentials = this.decryptCredentials(connection);
    const now = new Date();
    const start = connection.lastOrdersSyncedAt
      ? new Date(connection.lastOrdersSyncedAt.getTime() - ORDER_SYNC_OVERLAP_MS)
      : new Date(now.getTime() - initialLookbackDays * 24 * 60 * 60 * 1000);
    const searchedOrderNumbers = await this.client.searchOrders(credentials.serviceSecret, credentials.licenseKey, {
      start,
      end: now,
      orderProgressList: IMPORTABLE_ORDER_PROGRESS,
    });
    const allOrderNumbers = Array.from(new Set(searchedOrderNumbers));
    const orderNumbers = maxOrders ? allOrderNumbers.slice(0, maxOrders) : allOrderNumbers;
    const orders = await this.client.getOrders(credentials.serviceSecret, credentials.licenseKey, orderNumbers);
    const pendingShipmentOrders = orders.filter(
      (order) =>
        this.pickText(order, "orderProgress", "OrderProgress") === String(PENDING_SHIPMENT_ORDER_PROGRESS),
    );
    return {
      mappedItems: await this.mapOrders(pendingShipmentOrders),
      searchedOrderCount: searchedOrderNumbers.length,
      reconciledOrderCount: 0,
      requestedOrderCount: orderNumbers.length,
      truncated: orderNumbers.length < allOrderNumbers.length,
    };
  }

  private async mapOrders(orders: RakutenJsonObject[]): Promise<MappedRakutenItem[]> {
    const baseItems = orders.flatMap((order) => this.mapOrder(order));
    const comboSkus = Array.from(
      new Set(baseItems.map((item) => item.skuCode ?? "").filter((sku) => /^zh-/i.test(sku))),
    );
    if (!comboSkus.length) return baseItems;
    const combos = await this.prisma.rakutenComboProduct.findMany({
      where: { comboName: { in: comboSkus } },
      include: {
        items: {
          orderBy: { position: "asc" },
          include: {
            product: { select: { productId: true, productName: true } },
          },
        },
      },
    });
    const comboMap = new Map(combos.map((combo) => [combo.comboName, combo] as const));
    const missing = comboSkus.filter((sku) => !comboMap.has(sku));
    if (missing.length) throw new BadRequestException(`以下乐天组合SKU未配置组合产品：${missing.join("、")}`);
    return baseItems.flatMap((item) => {
      const comboSku = item.skuCode ?? "";
      if (!/^zh-/i.test(comboSku)) return [item];
      const combo = comboMap.get(comboSku);
      return (combo?.items ?? []).map((component) => ({
        ...item,
        itemKey: this.compactItemKey(`${item.itemKey}|component:${component.productId}`),
        skuCode: component.productId,
        isComboOrder: true,
        comboOrderSku: comboSku,
        setComponentSkuCode: comboSku,
        productName: component.product?.productName || item.productName,
      }));
    });
  }

  private mapOrder(order: RakutenJsonObject): MappedRakutenItem[] {
    const orderId = this.pickText(order, "orderNumber", "OrderNumber");
    if (!orderId) return [];
    const packages = this.pickObjectList(order, "PackageModelList", "packageModelList");
    const normalizedPackages = packages.length ? packages : [order];
    const result: MappedRakutenItem[] = [];
    normalizedPackages.forEach((pkg, packageIndex) => {
      const sender =
        this.pickObject(pkg, "SenderModel", "senderModel") ??
        this.pickObject(order, "SenderModel", "senderModel") ??
        {};
      const delivery =
        this.pickObject(order, "DeliveryModel", "deliveryModel") ??
        this.pickObject(pkg, "DeliveryModel", "deliveryModel") ??
        {};
      const items = this.pickObjectList(pkg, "ItemModelList", "itemModelList");
      items.forEach((item, itemIndex) => {
        const itemDetailId = this.pickText(item, "itemDetailId", "ItemDetailId");
        const skuModel = this.pickObjectList(item, "SkuModelList", "skuModelList")[0] ?? {};
        const skuCode =
          this.pickText(skuModel, "variantId") ||
          this.pickText(skuModel, "merchantDefinedSkuId") ||
          this.pickText(item, "manageNumber", "skuManagementNumber", "itemNumber", "itemUrl");
        const quantity = Math.max(1, this.pickInt(item, "units", "quantity", "orderQuantity") ?? 1);
        const shippingName = this.combine([
          this.pickText(sender, "familyName", "lastName"),
          this.pickText(sender, "firstName"),
        ]);
        const shippingPostalCode = this.combine(
          [this.pickText(sender, "zipCode1", "postalCode1"), this.pickText(sender, "zipCode2", "postalCode2")],
          "-",
        );
        const shippingPhone = this.combine(
          [
            this.pickText(sender, "phoneNumber1", "phone1"),
            this.pickText(sender, "phoneNumber2", "phone2"),
            this.pickText(sender, "phoneNumber3", "phone3"),
          ],
          "-",
        );
        const orderStatusText = this.pickText(order, "orderProgress", "OrderProgress");
        const orderImportedAtRaw = this.pickText(order, "orderDatetime", "OrderDatetime");
        const productName = this.pickText(item, "itemName", "productName");
        const productNameExtra =
          this.pickText(skuModel, "skuInfo") || this.pickText(item, "selectedChoice", "skuInfo", "variantInfo");
        const shippingPrefecture = this.pickText(sender, "prefecture", "state");
        const shippingCity = this.pickText(sender, "city");
        const shippingAddress = this.pickText(sender, "subAddress", "address", "addressLine1");
        const deliveryMethod = this.pickText(delivery, "deliveryName", "deliveryMethod");
        const deliveryClass = this.pickText(delivery, "deliveryClass");
        const deliveryDateRaw = this.pickText(order, "deliveryDate") || this.pickText(delivery, "deliveryDate");
        const deliveryTimeSlot =
          this.pickText(order, "shippingTerm") || this.pickText(delivery, "deliveryTime", "deliveryTimeSlot");
        const orderRemark = this.pickText(order, "remarks", "memo", "orderRemarks");
        const rawPayload = this.toJson({
          注文番号: orderId,
          注文日時: orderImportedAtRaw,
          注文確定日時: this.pickText(order, "orderFixDatetime", "shopOrderCfmDatetime"),
          SKU管理番号: skuCode,
          商品名: productName,
          SKU情報: productNameExtra,
          個数: String(quantity),
          配送方法: deliveryMethod,
          配送区分: deliveryClass,
          送付先郵便番号1: this.pickText(sender, "zipCode1", "postalCode1"),
          送付先郵便番号2: this.pickText(sender, "zipCode2", "postalCode2"),
          送付先住所都道府県: shippingPrefecture,
          送付先住所郡市区: shippingCity,
          送付先住所それ以降の住所: shippingAddress,
          送付先姓: this.pickText(sender, "familyName", "lastName"),
          送付先名: this.pickText(sender, "firstName"),
          送付先電話番号1: this.pickText(sender, "phoneNumber1", "phone1"),
          送付先電話番号2: this.pickText(sender, "phoneNumber2", "phone2"),
          送付先電話番号3: this.pickText(sender, "phoneNumber3", "phone3"),
          お届け時間帯: deliveryTimeSlot,
          お届け日指定: deliveryDateRaw,
          コメント: orderRemark,
          rmsOrder: order,
          rmsPackage: pkg,
          rmsItem: item,
        });
        result.push({
          orderId,
          itemKey: this.compactItemKey(
            `${orderId}|${itemDetailId || `${packageIndex}:${itemIndex}:${skuCode || "unknown"}`}`,
          ),
          skuCode: skuCode || null,
          isComboOrder: false,
          comboOrderSku: null,
          setComponentSkuCode: null,
          orderQuantity: quantity,
          productName: productName || null,
          productNameExtra: productNameExtra || null,
          deliveryClass: deliveryClass || null,
          orderStatusText: orderStatusText || null,
          orderImportedAtRaw: orderImportedAtRaw || null,
          orderRemark: orderRemark || null,
          shippingName: shippingName || null,
          shippingPostalCode: shippingPostalCode || null,
          shippingPrefecture: shippingPrefecture || null,
          shippingCity: shippingCity || null,
          shippingAddress: shippingAddress || null,
          shippingPhone: shippingPhone || null,
          deliveryMethod: deliveryMethod || null,
          deliveryDateRaw: deliveryDateRaw || null,
          deliveryTimeSlot: deliveryTimeSlot || null,
          rawPayload,
        });
      });
    });
    return result;
  }

  private async planOrderItem(
    db: Prisma.TransactionClient | PrismaService,
    connection: RakutenRmsConnection & { shop: { id: bigint; name: string } },
    item: MappedRakutenItem,
  ): Promise<SyncPlan> {
    const exclusionReason = await this.orderItemExclusionReason(db, connection, item);
    if (exclusionReason) {
      return {
        action: exclusionReason === "conflict_ignore" ? "ignored" : "excluded",
        item,
        existing: null,
        reason:
          exclusionReason === "conflict_ignore"
            ? "已经由操作人员确认忽略此冲突明细"
            : "已经由操作人员删除，禁止 RMS API 重新拉取",
        changedFields: [],
      };
    }
    const exact = await db.rakutenOrderRecord.findUnique({
      where: {
        rmsConnectionId_rmsItemKey: {
          rmsConnectionId: connection.id,
          rmsItemKey: item.itemKey,
        },
      },
    });
    let existing = exact;
    if (!existing) {
      const candidates = await db.rakutenOrderRecord.findMany({
        where: { orderId: item.orderId },
        orderBy: { id: "asc" },
      });
      const normalizedItemSku = this.normalizeSku(item.skuCode);
      const skuMatches = candidates.filter(
        (row) =>
          Boolean(normalizedItemSku) &&
          [row.skuCode, row.comboOrderSku, row.setComponentSkuCode]
            .map((value) => this.normalizeSku(value))
            .includes(normalizedItemSku),
      );
      if (skuMatches.length === 1 && !skuMatches[0].rmsConnectionId) {
        existing = skuMatches[0];
      } else if (candidates.length > 0) {
        return {
          action: "conflict",
          item,
          existing: null,
          reason:
            skuMatches.length > 1
              ? "同一订单号和SKU匹配到多条CSV记录"
              : skuMatches.length === 1
                ? "匹配记录已绑定其他 RMS 连接"
                : "同一订单号已存在，但SKU不一致",
          changedFields: [],
        };
      }
    }
    if (existing) {
      const freezeReason = await this.resolveFreezeReason(db, existing);
      if (freezeReason) {
        if (existing.xiyaExportedAt) {
          const frozenData = await this.buildOrderWriteData(db, connection, item, existing, new Date());
          const changedFields = this.changedBusinessOrderFields(existing, frozenData);
          if (changedFields.length) {
            const manualActionType = this.isCancellationStatus(item.orderStatusText) ? "cancel" : "update";
            return {
              action: "manual_action",
              item,
              existing,
              reason:
                manualActionType === "cancel"
                  ? "Xiya 已接收后乐天订单取消，请日本操作人员人工通知中国"
                  : "Xiya 已接收后乐天订单发生变更，请日本操作人员人工通知中国",
              changedFields,
              manualActionType,
              observedHash: this.hashObservedManualAction(item, changedFields),
            };
          }
        }
        return {
          action: "frozen",
          item,
          existing,
          reason: freezeReason,
          changedFields: [],
        };
      }
    }
    const data = await this.buildOrderWriteData(db, connection, item, existing, new Date());
    const action = existing ? (existing.rmsConnectionId ? "update" : "claim") : "create";
    return {
      action,
      item,
      existing,
      reason: null,
      changedFields: existing
        ? action === "update"
          ? this.changedBusinessOrderFields(existing, data)
          : this.changedOrderFields(existing, data)
        : Object.keys(data),
    };
  }

  private async orderItemExclusionReason(
    db: Prisma.TransactionClient | PrismaService,
    connection: RakutenRmsConnection & { shop: { id: bigint; name: string } },
    item: MappedRakutenItem,
  ): Promise<string | null> {
    const exclusionStore = (db as PrismaService).rakutenOrderSyncExclusion;
    if (!exclusionStore) return null;
    const normalizedSku = this.normalizeSku(item.skuCode);
    const itemScopes: Prisma.RakutenOrderSyncExclusionWhereInput[] = [
      { rmsItemKey: item.itemKey },
      { rmsItemKey: null, skuCode: null },
    ];
    if (normalizedSku) itemScopes.push({ rmsItemKey: null, skuCode: normalizedSku });
    const exclusions = await exclusionStore.findMany({
      where: {
        orderId: item.orderId,
        AND: [
          {
            OR: [
              { shopName: connection.shop.name },
              { shopName: null, rmsConnectionId: connection.id },
              { shopName: null, rmsConnectionId: null },
            ],
          },
          { OR: itemScopes },
        ],
      },
      select: { reason: true },
    });
    if (!exclusions.length) return null;
    return exclusions.some((row) => row.reason !== "conflict_ignore") ? "user_delete" : "conflict_ignore";
  }

  private async applyOrderPlan(
    db: Prisma.TransactionClient,
    connection: RakutenRmsConnection & { shop: { id: bigint; name: string } },
    plan: SyncPlan,
    syncedAt: Date,
  ): Promise<SyncChangeSnapshot> {
    const data = await this.buildOrderWriteData(db, connection, plan.item, plan.existing, syncedAt);
    if (plan.existing) {
      const before = this.snapshotOrderRecord(plan.existing);
      const updated = await db.rakutenOrderRecord.update({
        where: { id: plan.existing.id },
        data,
      });
      return {
        action: "updated",
        recordId: updated.id.toString(),
        before,
        afterUpdatedAt: updated.updatedAt.toISOString(),
      };
    }
    const created = await db.rakutenOrderRecord.create({
      data: {
        ...data,
        rowHash: createHash("sha1").update(`${connection.id.toString()}|${plan.item.itemKey}`).digest("hex"),
        sendStatus: OrderSendStatus.unsent,
      },
    });
    return {
      action: "created",
      recordId: created.id.toString(),
      before: null,
      afterUpdatedAt: created.updatedAt.toISOString(),
    };
  }

  private async buildOrderWriteData(
    db: Prisma.TransactionClient | PrismaService,
    connection: RakutenRmsConnection & { shop: { id: bigint; name: string } },
    item: MappedRakutenItem,
    existing: RakutenOrderRecord | null,
    syncedAt: Date,
  ): Promise<RakutenOrderWriteData> {
    const dispatchMode = existing?.dispatchMode || (await this.resolveDispatchMode(db, item.skuCode));
    return {
      rmsConnectionId: connection.id,
      rmsItemKey: item.itemKey,
      sourceKind: "rms_api",
      orderId: item.orderId,
      itemDetailStatus: item.deliveryClass,
      skuCode: item.skuCode,
      isComboOrder: item.isComboOrder,
      comboOrderSku: item.comboOrderSku,
      setComponentSkuCode: item.setComponentSkuCode,
      orderQuantity: item.orderQuantity,
      productName: item.productName,
      mallName: "Rakuten",
      shopName: connection.shop.name,
      mallOrderNo: item.orderId,
      orderStatusText: item.orderStatusText,
      orderImportedAtRaw: item.orderImportedAtRaw,
      orderImportedDate: parseRakutenOrderDate(item.orderImportedAtRaw),
      orderRemark: item.orderRemark,
      shippingName: item.shippingName,
      shippingPostalCode: item.shippingPostalCode,
      shippingPrefecture: item.shippingPrefecture,
      shippingCity: item.shippingCity,
      shippingAddress: item.shippingAddress,
      shippingPhone: item.shippingPhone,
      dispatchMode,
      deliveryMethod: item.deliveryMethod,
      deliveryDateRaw: item.deliveryDateRaw,
      deliveryTimeSlot: item.deliveryTimeSlot,
      productNameExtra: item.productNameExtra,
      sourceFileName: "Rakuten RMS API",
      sourceFilePath: `rms-api:${connection.id.toString()}`,
      rawPayload: item.rawPayload,
      csvImportedAt: syncedAt,
      rmsLastSyncedAt: syncedAt,
    };
  }

  private async resolveFreezeReason(
    db: Prisma.TransactionClient | PrismaService,
    row: RakutenOrderRecord,
  ): Promise<string | null> {
    if (String(row.shipmentNo ?? "").trim()) return "已有发货单号";
    if (row.xiyaExportedAt) return "已经导出到 Xiya";
    if (row.rmsManualOverrideAt) return "已经由操作人员人工接管";
    if (row.rawPayload && typeof row.rawPayload === "object" && !Array.isArray(row.rawPayload)) {
      if (String((row.rawPayload as Prisma.JsonObject)[MANUAL_OVERRIDE_KEY] ?? "").trim()) {
        return "存在人工修改字段";
      }
    }
    const pickingItem = await db.overseasPickingBatchItem.findFirst({
      where: { source: "rakuten", sourceRecordId: row.id },
      select: { id: true },
    });
    return pickingItem ? "已经进入拣货批次" : null;
  }

  private async resolveDispatchMode(
    db: Prisma.TransactionClient | PrismaService,
    skuCode: string | null,
  ): Promise<string> {
    const productId = String(skuCode ?? "").trim();
    if (!productId) return "china_no_stock";
    const product = await db.masterProduct.findUnique({
      where: { productId },
      select: { stockQty: true },
    });
    return Number(product?.stockQty ?? 0) > 0 ? "overseas" : "china_no_stock";
  }

  private describePlan(plan: SyncPlan): SyncPlanDescriptor {
    return {
      itemKey: plan.item.itemKey,
      action: plan.action,
      existingId: plan.existing?.id.toString() ?? null,
      existingUpdatedAt: plan.existing?.updatedAt.toISOString() ?? null,
    };
  }

  private planMatchesDescriptor(plan: SyncPlan, expected: SyncPlanDescriptor): boolean {
    const actual = this.describePlan(plan);
    return (
      actual.itemKey === expected.itemKey &&
      actual.action === expected.action &&
      actual.existingId === expected.existingId &&
      actual.existingUpdatedAt === expected.existingUpdatedAt
    );
  }

  private changedOrderFields(existing: RakutenOrderRecord, data: RakutenOrderWriteData): string[] {
    return Object.entries(data)
      .filter(
        ([key, value]) =>
          this.comparableValue(existing[key as keyof RakutenOrderRecord]) !== this.comparableValue(value),
      )
      .map(([key]) => key);
  }

  private changedBusinessOrderFields(existing: RakutenOrderRecord, data: RakutenOrderWriteData): string[] {
    const syncMetadataFields = new Set([
      "rmsConnectionId",
      "rmsItemKey",
      "sourceKind",
      "sourceFileName",
      "sourceFilePath",
      "rawPayload",
      "csvImportedAt",
      "rmsLastSyncedAt",
    ]);
    return this.changedOrderFields(existing, data).filter((key) => !syncMetadataFields.has(key));
  }

  private isCancellationStatus(status: string | null): boolean {
    const normalized = String(status ?? "")
      .trim()
      .toLowerCase();
    return (
      normalized === "800" ||
      normalized === "900" ||
      normalized.includes("キャンセル") ||
      normalized.includes("cancel") ||
      normalized.includes("取消")
    );
  }

  private hashObservedManualAction(item: MappedRakutenItem, changedFields: string[]): string {
    return createHash("sha1")
      .update(
        JSON.stringify({
          orderId: item.orderId,
          itemKey: item.itemKey,
          changedFields,
          rawPayload: item.rawPayload,
        }),
      )
      .digest("hex");
  }

  private async recordXiyaManualAction(db: Prisma.TransactionClient, plan: SyncPlan, detectedAt: Date): Promise<void> {
    if (!plan.existing || !plan.manualActionType || !plan.observedHash) return;
    if (plan.existing.rmsManualActionObservedHash === plan.observedHash) {
      await db.rakutenOrderRecord.update({
        where: { id: plan.existing.id },
        data: { rmsLastSyncedAt: detectedAt },
      });
      return;
    }
    await db.rakutenOrderRecord.update({
      where: { id: plan.existing.id },
      data: {
        rmsManualActionType: plan.manualActionType,
        rmsManualActionChangedFields: this.toJson(plan.changedFields),
        rmsManualActionObservedPayload: plan.item.rawPayload,
        rmsManualActionObservedHash: plan.observedHash,
        rmsManualActionDetectedAt: detectedAt,
        rmsManualActionResolvedAt: null,
        rmsManualActionResolvedBy: null,
        rmsLastSyncedAt: detectedAt,
      },
    });
  }

  private comparableValue(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "bigint") return value.toString();
    if (value && typeof value === "object") return JSON.stringify(value);
    return String(value ?? "");
  }

  private sortableOrderTime(value: unknown): number {
    const source = String(value ?? "").trim();
    if (!source) return Number.NEGATIVE_INFINITY;
    const timestamp = new Date(source).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
    return parseRakutenOrderDate(source)?.getTime() ?? Number.NEGATIVE_INFINITY;
  }

  private snapshotOrderRecord(row: RakutenOrderRecord): Record<string, unknown> {
    return this.toJson({
      rmsConnectionId: row.rmsConnectionId?.toString() ?? null,
      rmsItemKey: row.rmsItemKey,
      sourceKind: row.sourceKind,
      rmsLastSyncedAt: row.rmsLastSyncedAt?.toISOString() ?? null,
      orderId: row.orderId,
      itemDetailStatus: row.itemDetailStatus,
      skuCode: row.skuCode,
      isComboOrder: row.isComboOrder,
      comboOrderSku: row.comboOrderSku,
      setComponentSkuCode: row.setComponentSkuCode,
      orderQuantity: row.orderQuantity,
      productName: row.productName,
      mallName: row.mallName,
      shopName: row.shopName,
      mallOrderNo: row.mallOrderNo,
      orderStatusText: row.orderStatusText,
      orderImportedAtRaw: row.orderImportedAtRaw,
      orderImportedDate: row.orderImportedDate?.toISOString() ?? null,
      orderRemark: row.orderRemark,
      shippingName: row.shippingName,
      shippingPostalCode: row.shippingPostalCode,
      shippingPrefecture: row.shippingPrefecture,
      shippingCity: row.shippingCity,
      shippingAddress: row.shippingAddress,
      shippingPhone: row.shippingPhone,
      dispatchMode: row.dispatchMode,
      deliveryMethod: row.deliveryMethod,
      deliveryDateRaw: row.deliveryDateRaw,
      deliveryTimeSlot: row.deliveryTimeSlot,
      productNameExtra: row.productNameExtra,
      sourceFileName: row.sourceFileName,
      sourceFilePath: row.sourceFilePath,
      rawPayload: row.rawPayload,
      csvImportedAt: row.csvImportedAt.toISOString(),
    }) as unknown as Record<string, unknown>;
  }

  private restoreOrderSnapshot(snapshot: Record<string, unknown>): Prisma.RakutenOrderRecordUncheckedUpdateInput {
    return {
      rmsConnectionId: snapshot.rmsConnectionId ? BigInt(String(snapshot.rmsConnectionId)) : null,
      rmsItemKey: this.snapshotNullableText(snapshot.rmsItemKey),
      sourceKind: String(snapshot.sourceKind ?? "csv"),
      rmsLastSyncedAt: this.parseSnapshotDate(snapshot.rmsLastSyncedAt),
      orderId: this.snapshotNullableText(snapshot.orderId),
      itemDetailStatus: this.snapshotNullableText(snapshot.itemDetailStatus),
      skuCode: this.snapshotNullableText(snapshot.skuCode),
      isComboOrder: Boolean(snapshot.isComboOrder),
      comboOrderSku: this.snapshotNullableText(snapshot.comboOrderSku),
      setComponentSkuCode: this.snapshotNullableText(snapshot.setComponentSkuCode),
      orderQuantity: snapshot.orderQuantity === null ? null : Number(snapshot.orderQuantity),
      productName: this.snapshotNullableText(snapshot.productName),
      mallName: this.snapshotNullableText(snapshot.mallName),
      shopName: this.snapshotNullableText(snapshot.shopName),
      mallOrderNo: this.snapshotNullableText(snapshot.mallOrderNo),
      orderStatusText: this.snapshotNullableText(snapshot.orderStatusText),
      orderImportedAtRaw: this.snapshotNullableText(snapshot.orderImportedAtRaw),
      orderImportedDate:
        this.parseSnapshotDate(snapshot.orderImportedDate)
        ?? parseRakutenOrderDate(snapshot.orderImportedAtRaw),
      orderRemark: this.snapshotNullableText(snapshot.orderRemark),
      shippingName: this.snapshotNullableText(snapshot.shippingName),
      shippingPostalCode: this.snapshotNullableText(snapshot.shippingPostalCode),
      shippingPrefecture: this.snapshotNullableText(snapshot.shippingPrefecture),
      shippingCity: this.snapshotNullableText(snapshot.shippingCity),
      shippingAddress: this.snapshotNullableText(snapshot.shippingAddress),
      shippingPhone: this.snapshotNullableText(snapshot.shippingPhone),
      dispatchMode: this.snapshotNullableText(snapshot.dispatchMode),
      deliveryMethod: this.snapshotNullableText(snapshot.deliveryMethod),
      deliveryDateRaw: this.snapshotNullableText(snapshot.deliveryDateRaw),
      deliveryTimeSlot: this.snapshotNullableText(snapshot.deliveryTimeSlot),
      productNameExtra: this.snapshotNullableText(snapshot.productNameExtra),
      sourceFileName: this.snapshotNullableText(snapshot.sourceFileName),
      sourceFilePath: this.snapshotNullableText(snapshot.sourceFilePath),
      rawPayload: snapshot.rawPayload === null ? Prisma.DbNull : (snapshot.rawPayload as Prisma.InputJsonValue),
      csvImportedAt: this.parseSnapshotDate(snapshot.csvImportedAt) ?? new Date(),
    };
  }

  private snapshotNullableText(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
  }

  private parseSnapshotDate(value: unknown): Date | null {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException("同步快照中的日期无效");
    return parsed;
  }

  private async loadConnection(
    idRaw: string,
    requireActive: boolean,
  ): Promise<RakutenRmsConnection & { shop: { id: bigint; name: string } }> {
    const id = parseId(idRaw, "id");
    const connection = await this.prisma.rakutenRmsConnection.findUnique({
      where: { id },
      include: { shop: { select: { id: true, name: true } } },
    });
    if (!connection) throw new NotFoundException("乐天 RMS API 连接不存在");
    if (requireActive && (connection.status !== 1 || !connection.syncOrders)) {
      throw new BadRequestException("乐天 RMS API 连接已停用");
    }
    if (requireActive) this.assertLicenseActive(connection);
    return connection;
  }

  private assertLicenseActive(connection: RakutenRmsConnection): void {
    if (connection.licenseExpiresAt && connection.licenseExpiresAt.getTime() <= Date.now()) {
      throw new BadRequestException("乐天 RMS API licenseKey 已过期，请先更新");
    }
  }

  private decryptCredentials(connection: RakutenRmsConnection): {
    serviceSecret: string;
    licenseKey: string;
  } {
    return {
      serviceSecret: this.crypto.decrypt(
        connection.encryptedServiceSecret,
        connection.serviceSecretIv,
        connection.serviceSecretAuthTag,
      ),
      licenseKey: this.crypto.decrypt(
        connection.encryptedLicenseKey,
        connection.licenseKeyIv,
        connection.licenseKeyAuthTag,
      ),
    };
  }

  private serializeConnection(row: RakutenRmsConnection & { shop: { id: bigint; name: string } }): unknown {
    const renewalDue = Boolean(
      row.licenseExpiresAt && row.licenseExpiresAt.getTime() <= Date.now() + 14 * 24 * 60 * 60 * 1000,
    );
    return {
      id: row.id.toString(),
      shopId: row.shopId.toString(),
      shop: { id: row.shop.id.toString(), name: row.shop.name },
      status: row.status,
      syncOrders: row.syncOrders,
      licenseExpiresAt: row.licenseExpiresAt?.toISOString() ?? null,
      renewalDue,
      lastOrdersSyncedAt: row.lastOrdersSyncedAt?.toISOString() ?? null,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
      lastSyncError: row.lastSyncError,
      scheduledSyncEnabled: RAKUTEN_SCHEDULED_SYNC_ENABLED,
      scheduledSyncCron: RAKUTEN_SYNC_CRON,
      scheduledSyncTimezone: RAKUTEN_SYNC_TIMEZONE,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private formatTokyoDateKey(value: Date, separator: "-" | "/"): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(value);
    const row = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${row.year}${separator}${row.month}${separator}${row.day}`;
  }

  private pickObject(source: RakutenJsonObject, ...keys: string[]): RakutenJsonObject | null {
    for (const key of keys) {
      const value = source[key];
      if (value && typeof value === "object" && !Array.isArray(value)) return value as RakutenJsonObject;
    }
    return null;
  }

  private pickObjectList(source: RakutenJsonObject, ...keys: string[]): RakutenJsonObject[] {
    for (const key of keys) {
      const value = source[key];
      if (Array.isArray(value)) {
        return value.filter((item): item is RakutenJsonObject =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
        );
      }
    }
    return [];
  }

  private pickText(source: RakutenJsonObject, ...keys: string[]): string {
    for (const key of keys) {
      const value = source[key];
      if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
    }
    return "";
  }

  private pickInt(source: RakutenJsonObject, ...keys: string[]): number | null {
    const text = this.pickText(source, ...keys);
    if (!text) return null;
    const value = Number(text);
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }

  private combine(parts: string[], separator = ""): string {
    return parts
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join(separator);
  }

  private normalizeSku(value: string | null | undefined): string {
    return String(value ?? "")
      .trim()
      .toLowerCase();
  }

  private compactItemKey(value: string): string {
    if (value.length <= 191) return value;
    const digest = createHash("sha1").update(value).digest("hex");
    return `${value.slice(0, 149)}|${digest}`;
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private parseOptionalDate(value: string | undefined): Date | null {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException("licenseExpiresAt 不是有效日期");
    return parsed;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
