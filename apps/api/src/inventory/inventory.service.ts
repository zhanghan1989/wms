import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { AuditAction, BatchInboundOrderStatus, OrderStatus, Prisma, ProductEditRequestStatus } from '@prisma/client';
import { dirname, join, resolve } from 'path';
import { promisify } from 'util';
import * as XLSX from 'xlsx';
import { AuditService } from '../audit/audit.service';
import { buildEquivalentBoxCodes, normalizeBoxCode } from '../common/box-code';
import { APP_TIMEZONE, generateOrderNo, getZonedDateParts, parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateAdjustOrderDto,
  CreateAdjustOrderItemDto,
} from './dto/create-adjust-order.dto';
import { ConfirmFbaReplenishmentDto } from './dto/confirm-fba-replenishment.dto';
import { CreateFbaReplenishmentDto } from './dto/create-fba-replenishment.dto';
import { ManualAdjustDto } from './dto/manual-adjust.dto';
import { MoveProductBetweenBoxesDto } from './dto/move-product-between-boxes.dto';
import { OutboundFbaReplenishmentDto } from './dto/outbound-fba-replenishment.dto';
import {
  classifyFbaSalesRows,
  parseFbaSalesBusinessReport,
  parseFbaSalesPeriod,
} from './fba-sales-report';
import {
  getAmazonInventorySnapshotMetadata,
  parseAmazonReplenishmentCsv,
  validateAmazonReplenishmentReports,
} from './amazon-replenishment-report';
import { classifyNoSalesInventoryAge } from './inventory-dashboard';

interface AdjustOrderResult {
  orderId: string;
  status: OrderStatus;
  idempotent: boolean;
  changedRows: number;
}

interface BulkInventoryUpdateRow {
  boxCode: string;
  productId: string;
  sku: string;
  qty: number;
}

interface BoxProductInventoryPair {
  boxId: bigint;
  productId: string;
}

type MasterProductBoxInventoryQtyRecord = {
  qty: number | null;
};

type MasterProductBoxInventoryPairRow = {
  boxId: bigint;
  productId: string;
  qty: number | null;
};

type MasterProductBoxInventoryFindManyClient = {
  masterProductBoxInventory: {
    findMany(args: Prisma.MasterProductBoxInventoryFindManyArgs): Promise<MasterProductBoxInventoryPairRow[]>;
  };
};

type PrintAgentExeFile = {
  fileName: string;
  content: Buffer;
};

const execFileAsync = promisify(execFile);
const PRINT_AGENT_EXE_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

type MasterProductBoxInventoryFindUniqueClient = {
  masterProductBoxInventory: {
    findUnique(
      args: Prisma.MasterProductBoxInventoryFindUniqueArgs,
    ): Promise<MasterProductBoxInventoryQtyRecord | null>;
  };
};

type MasterProductBoxInventoryUpsertClient = {
  masterProductBoxInventory: {
    upsert(args: Prisma.MasterProductBoxInventoryUpsertArgs): Promise<unknown>;
  };
};

type MasterProductBoxInventoryUpdateClient = {
  masterProductBoxInventory: {
    update(args: Prisma.MasterProductBoxInventoryUpdateArgs): Promise<unknown>;
  };
};

interface MasterProductInventoryAdjustAuditArgs {
  auditService: AuditService;
  tx: Prisma.TransactionClient;
  entityId: bigint;
  beforeData: Record<string, unknown> | null | undefined;
  afterData: Record<string, unknown> | null | undefined;
  operatorId: bigint;
  requestId?: string;
  remark?: string;
}

interface FixedInventoryAdjustAuditArgs {
  auditService: AuditService;
  tx: Prisma.TransactionClient;
  entityId: bigint;
  beforeData: Record<string, unknown> | null | undefined;
  afterData: Record<string, unknown> | null | undefined;
  operatorId: bigint;
  requestId?: string;
  remark?: string;
}

interface FixedInventoryAdjustCreatedAuditArgs {
  auditService: AuditService;
  tx: Prisma.TransactionClient;
  entityId: bigint;
  afterData: Record<string, unknown> | null | undefined;
  operatorId: bigint;
  requestId?: string;
  remark?: string;
}

interface BoxInventoryAuditArgs {
  auditService: AuditService;
  tx: Prisma.TransactionClient;
  entityId: bigint;
  eventType: (typeof AuditEventType)[keyof typeof AuditEventType];
  beforeData: Record<string, unknown> | null | undefined;
  afterData: Record<string, unknown> | null | undefined;
  operatorId: bigint;
  requestId?: string;
  remark?: string;
}

const FBA_REPLENISH_MARK = 'FBA补货';
const SKU_EDIT_PENDING_BLOCK_MESSAGE = '存在待审核的产品编辑申请，请管理员确认后再执行相关操作。';
const INVENTORY_BULK_UPDATE_TEMPLATE_FILE = '批量更新库存.xlsx';
const BULK_UPDATE_DEFAULT_SHELF_CODE = '00';
// Historical default shelf codes may still exist in old data and must keep resolving here.
const BULK_UPDATE_COMPAT_SHELF_CODES = ['S-00', 'Z-0'];
const BULK_UPDATE_DEFAULT_SHELF_NAME = '默认货架';
const BULK_UPDATE_MAX_BOX_CODE_LENGTH = 128;
const BULK_UPDATE_MAX_PRODUCT_ID_LENGTH = 128;
const BULK_INVENTORY_IMPORT_TRANSACTION_TIMEOUT_MS = 120000;
const BULK_INVENTORY_IMPORT_TRANSACTION_MAX_WAIT_MS = 10000;
const MASTER_PRODUCT_BOX_SHELF_SELECT = {
  id: true,
  shelfCode: true,
  name: true,
} as const;
const MASTER_PRODUCT_BOX_BASIC_PRODUCT_SELECT = {
  productId: true,
  productName: true,
} as const;
const MASTER_PRODUCT_BOX_PRODUCT_WITH_STOCK_SELECT = {
  id: true,
  productId: true,
  productName: true,
  stockQty: true,
} as const;
const URGENT_STOCK_COVERAGE_DAYS = 30;
const HIGH_TOTAL_COVERAGE_DAYS = 60;
const MEDIUM_TOTAL_COVERAGE_DAYS = 90;
const PRODUCTION_TARGET_DAYS = 90;
const ESTIMATED_PRODUCTION_ARRIVAL_DAYS = 45;
const ANOMALY_MIN_DELTA_QTY = 10;
const DASHBOARD_SNAPSHOT_RETENTION_LIMIT = 10;

function getJsonObjectString(value: Prisma.JsonValue | null | undefined, key: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  const candidate = (value as Record<string, Prisma.JsonValue>)[key];
  return typeof candidate === 'string' ? candidate.trim() : '';
}

function raiseProductionPriority(priority: string): string {
  if (priority === '紧急') return '紧急';
  if (priority === '高') return '紧急';
  if (priority === '中') return '高';
  return '中';
}

function normalizeImportHeaderValue(header: string): string {
  return String(header || '')
    .replace(/[\s_\-()\[\]（）【】]/g, '')
    .toLowerCase();
}

function validateBulkInventoryImportRows(
  rows: Array<{ boxCode: string; productId: string; qty: number }>,
): void {
  const errors: string[] = [];

  rows.forEach((row, index) => {
    const rowNo = index + 2;

    if (row.boxCode.length > BULK_UPDATE_MAX_BOX_CODE_LENGTH) {
      errors.push(`第${rowNo}行箱号超长，最多 ${BULK_UPDATE_MAX_BOX_CODE_LENGTH} 个字符`);
    }

    if (row.productId.length > BULK_UPDATE_MAX_PRODUCT_ID_LENGTH) {
      errors.push(`第${rowNo}行产品ID超长，最多 ${BULK_UPDATE_MAX_PRODUCT_ID_LENGTH} 个字符`);
    }

    if (!Number.isInteger(row.qty) || row.qty < 0) {
      errors.push(`第${rowNo}行数量必须是大于等于 0 的整数`);
    }
  });

  if (errors.length > 0) {
    throw new BadRequestException(errors.join(' | '));
  }
}

function buildBulkInventoryImportDatabaseError(
  error: Prisma.PrismaClientKnownRequestError,
): BadRequestException {
  const targetText = getPrismaInventoryImportTargetText(error);

  if (error.code === 'P2021' || error.code === 'P2022') {
    if (
      targetText.includes('master_product_box_inventory') ||
      targetText.includes('master_products') ||
      targetText.includes('stock_qty')
    ) {
      return new BadRequestException(
        '数据库结构未更新到主商品库存模型，请先执行 prisma migrate deploy，同步 master_products、master_product_box_inventory 和 stock_qty 相关迁移',
      );
    }

    return new BadRequestException('数据库结构未更新，请先执行 prisma migrate deploy');
  }

  if (error.code === 'P2000') {
    return new BadRequestException('Excel 中存在超长字段，请检查箱号、产品ID、备注等字段长度');
  }

  if (error.code === 'P2002') {
    return new BadRequestException('数据库中已存在重复唯一值，请检查箱号和产品ID组合是否异常');
  }

  if (error.code === 'P2003') {
    return new BadRequestException('存在无效关联数据，请检查产品ID是否存在、箱号是否可用');
  }

  if (error.code === 'P2028') {
    return new BadRequestException(
      '批量更新库存执行超时。当前导入行数较多，请重试；如果仍失败，需要继续优化批量更新事务',
    );
  }

  const diagnostic = formatInventoryImportDiagnostic(error.code, targetText);
  return new BadRequestException(`批量更新库存失败（${diagnostic}）`);
}

function getPrismaInventoryImportTargetText(
  error: Prisma.PrismaClientKnownRequestError,
): string {
  const parts: string[] = [];
  const target = error.meta?.target;
  const table = error.meta?.table;
  const column = error.meta?.column;

  if (Array.isArray(target)) {
    parts.push(...target.map((item) => String(item)));
  } else if (target !== undefined && target !== null) {
    parts.push(String(target));
  }

  if (table !== undefined && table !== null) {
    parts.push(String(table));
  }

  if (column !== undefined && column !== null) {
    parts.push(String(column));
  }

  parts.push(String(error.message ?? ''));
  return parts.join(',').toLowerCase();
}

function formatInventoryImportDiagnostic(
  code: string,
  rawText: string,
): string {
  const compact = String(rawText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);

  if (!compact) {
    return code;
  }

  return `${code}: ${compact}`;
}

function extractInventoryImportRuntimeErrorMessage(error: unknown): string {
  const ctorName =
    error && typeof error === 'object' && 'constructor' in error
      ? String((error as { constructor?: { name?: string } }).constructor?.name || 'Error')
      : 'Error';
  const message =
    error instanceof Error
      ? String(error.message || '').replace(/\s+/g, ' ').trim()
      : String(error ?? '').replace(/\s+/g, ' ').trim();

  if (!message) {
    return ctorName;
  }

  return `${ctorName}: ${message}`.slice(0, 280);
}

@Injectable()
export class InventoryService {
  private printAgentExeBuildPromise: Promise<PrintAgentExeFile> | null = null;

  constructor(
    readonly prisma: PrismaService,
    readonly auditService: AuditService,
  ) {}

  async searchSkus(keyword?: string, page = 1, pageSize = 10): Promise<unknown[]> {
    return searchSkusByProduct.call(this, keyword, page, pageSize);
  }

  async productBoxes(skuId: number): Promise<unknown[]> {
    return productBoxesByProduct.call(this, skuId);
  }

  async masterProductBoxes(productIdRaw: string): Promise<unknown[]> {
    return getMasterProductBoxRowsByProductId.call(this, productIdRaw);
  }

  async boxSkus(boxId: number): Promise<unknown[]> {
    return this.prisma.masterProductBoxInventory.findMany({
      where: {
        boxId: BigInt(boxId),
        qty: { gt: 0 },
      },
      include: buildMasterProductBoxInventoryInclude(MASTER_PRODUCT_BOX_BASIC_PRODUCT_SELECT),
      orderBy: [{ productId: 'asc' }],
    });
  }

  async buildPrintAgentWindowsExe(): Promise<PrintAgentExeFile> {
    const repoRoot = await this.resolvePrintAgentRepoRoot();
    const prebuilt = await this.tryReadPrintAgentWindowsExe(
      join(repoRoot, 'apps', 'print-agent', 'prebuilt', 'wms-print-agent.exe'),
    );
    if (prebuilt) {
      return prebuilt;
    }

    if (!this.printAgentExeBuildPromise) {
      this.printAgentExeBuildPromise = this.generatePrintAgentWindowsExe(repoRoot).finally(() => {
        this.printAgentExeBuildPromise = null;
      });
    }
    return this.printAgentExeBuildPromise;
  }

  private async generatePrintAgentWindowsExe(repoRoot: string): Promise<PrintAgentExeFile> {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    try {
      await execFileAsync(npmCommand, ['run', 'package:print-agent:exe'], {
        cwd: repoRoot,
        timeout: PRINT_AGENT_EXE_BUILD_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      const details = this.formatPrintAgentExeBuildError(error);
      throw new InternalServerErrorException(`生成打印 exe 失败：${details}`);
    }

    const exePath = join(repoRoot, 'dist', 'print-agent-windows', 'wms-print-agent.exe');
    const generated = await this.tryReadPrintAgentWindowsExe(exePath);
    if (generated) {
      return generated;
    }

    throw new InternalServerErrorException('生成打印 exe 后未找到文件：dist/print-agent-windows/wms-print-agent.exe');
  }

  private async tryReadPrintAgentWindowsExe(exePath: string): Promise<PrintAgentExeFile | null> {
    try {
      return {
        fileName: 'wms-print-agent.exe',
        content: await readFile(exePath),
      };
    } catch {
      return null;
    }
  }

  private async resolvePrintAgentRepoRoot(): Promise<string> {
    const candidates = [
      process.cwd(),
      resolve(process.cwd(), '..'),
      resolve(process.cwd(), '..', '..'),
      resolve(__dirname, '..', '..', '..'),
      resolve(__dirname, '..', '..', '..', '..'),
    ];

    for (const candidate of candidates) {
      try {
        const packageJson = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>;
        };
        if (packageJson.scripts?.['package:print-agent:exe']) {
          return candidate;
        }
      } catch {
        // try next candidate
      }
    }

    return dirname(resolve(process.cwd(), 'package.json'));
  }

  private formatPrintAgentExeBuildError(error: unknown): string {
    const buildError = error as {
      code?: string | number;
      signal?: string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    const parts = [
      buildError.code ? `code=${buildError.code}` : '',
      buildError.signal ? `signal=${buildError.signal}` : '',
      buildError.killed ? 'killed=true' : '',
      error instanceof Error ? error.message : '',
      String(buildError.stderr ?? '').trim(),
      String(buildError.stdout ?? '').trim(),
    ]
      .filter(Boolean)
      .join('\n');

    const message = parts || 'unknown error';
    return message.slice(-1200);
  }

  async createAdjustOrder(
    payload: CreateAdjustOrderDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const normalizedItems = payload.items.map((item) => this.normalizeAdjustItem(item));
    return this.prisma.$transaction(async (tx) => {
      await this.ensureReferences(tx, normalizedItems);

      const order = await tx.inventoryAdjustOrder.create({
        data: {
          adjustNo: generateOrderNo('ADJ'),
          status: OrderStatus.draft,
          remark: payload.remark ?? null,
          createdBy: operatorId,
        },
      });

      await tx.inventoryAdjustOrderItem.createMany({
        data: normalizedItems.map((item) => ({
          orderId: order.id,
          boxId: item.boxId,
          skuId: item.skuId,
          qtyDelta: item.qtyDelta,
          reason: item.reason ?? null,
        })),
      });

      await createInventoryAdjustOrderCreatedAudit({
        auditService: this.auditService,
        tx,
        entityId: order.id,
        afterData: {
          adjustNo: order.adjustNo,
          status: order.status,
          itemCount: normalizedItems.length,
        },
        operatorId,
        requestId,
      });

      return tx.inventoryAdjustOrder.findUnique({
        where: { id: order.id },
        include: {
          creator: {
            select: {
              id: true,
              username: true,
            },
          },
          items: {
            include: {
              box: { select: { id: true, boxCode: true } },
              sku: { select: { id: true, sku: true } },
            },
            orderBy: { id: 'asc' },
          },
        },
      });
    });
  }

  async confirmAdjustOrder(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<AdjustOrderResult> {
    const orderId = parseId(idParam, 'adjustOrderId');
    return this.prisma.$transaction(async (tx) =>
      this.applyAdjustOrder(tx, orderId, operatorId, requestId, true),
    );
  }

  async manualAdjust(
    payload: ManualAdjustDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<AdjustOrderResult & { adjustNo: string }> {
    return manualAdjustByProduct.call(this, payload, operatorId, requestId);
  }

  

  async moveProductBetweenBoxes(
    payload: MoveProductBetweenBoxesDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ qty: number; oldBoxCode: string; newBoxCode: string; productId: string }> {
    const productId = String(payload.productId || '').trim();
    const fromBoxCode = String(payload.fromBoxCode || '').trim();
    const toBoxCode = String(payload.toBoxCode || '').trim();

    if (!productId) {
      throw new BadRequestException('productId不能为空');
    }
    if (!fromBoxCode || !toBoxCode) {
      throw new BadRequestException('原箱号和目标箱号不能为空');
    }
    if (fromBoxCode.toUpperCase() === toBoxCode.toUpperCase()) {
      throw new BadRequestException('目标箱号不能与原箱号相同');
    }

    return this.prisma.$transaction(async (tx) => {
      const [product, sourceBox, targetBox] = await Promise.all([
        tx.masterProduct.findUnique({
          where: { productId },
          select: {
            id: true,
            productId: true,
            productName: true,
            stockQty: true,
          },
        }),
        tx.box.findUnique({
          where: { boxCode: fromBoxCode },
          select: { id: true, boxCode: true },
        }),
        tx.box.findUnique({
          where: { boxCode: toBoxCode },
          select: { id: true, boxCode: true },
        }),
      ]);

      if (!product) throw new NotFoundException('主商品不存在');
      if (!sourceBox) throw new NotFoundException('原箱号不存在');
      if (!targetBox) throw new NotFoundException('目标箱号不存在');

      await this.ensureBoxesNotUnderActiveFba(tx, [sourceBox.id, targetBox.id], '移箱');

      const qty = await findMasterProductBoxInventoryQty(tx, sourceBox.id, product.productId);
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new ConflictException('原箱号中没有可移动的主商品库存');
      }

      const targetQty = await findMasterProductBoxInventoryQty(tx, targetBox.id, product.productId);

      await tx.masterProductBoxInventory.delete({
        where: buildMasterProductBoxInventoryWhereUnique(sourceBox.id, product.productId),
      });

      await upsertMasterProductBoxInventoryQty(
        tx,
        targetBox.id,
        product.productId,
        targetQty + qty,
      );

      const totalQty = await this.recalculateMasterProductStockQty(tx, product.productId);

      await createMasterProductInventoryAdjustAudit({
        auditService: this.auditService,
        tx,
        entityId: product.id,
        beforeData: {
          scope: 'move_between_boxes',
          productId: product.productId,
          productName: product.productName,
          stockQty: Number(product.stockQty ?? 0),
          fromBoxCode: sourceBox.boxCode,
          toBoxCode: targetBox.boxCode,
        },
        afterData: {
          scope: 'move_between_boxes',
          productId: product.productId,
          productName: product.productName,
          stockQty: totalQty,
          fromBoxCode: sourceBox.boxCode,
          toBoxCode: targetBox.boxCode,
          qty,
        },
        operatorId,
        requestId,
        remark: 'move-product-between-boxes',
      });

      return {
        qty,
        oldBoxCode: sourceBox.boxCode,
        newBoxCode: targetBox.boxCode,
        productId: product.productId,
      };
    });
  }

  async createFbaReplenishment(
    payload: CreateFbaReplenishmentDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    return createFbaReplenishmentByProduct.call(this, payload, operatorId, requestId);
  }

  async confirmFbaReplenishment(
    idParam: string,
    payload: ConfirmFbaReplenishmentDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    return confirmFbaReplenishmentByProduct.call(this, idParam, payload, operatorId, requestId);
  }

  async outboundFbaReplenishments(
    payload: OutboundFbaReplenishmentDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ updatedCount: number; expressNo: string }> {
    return outboundFbaReplenishmentsByProduct.call(this, payload, operatorId, requestId);
  }

  async deleteFbaReplenishment(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ id: string; requestNo: string; status: string; idempotent: boolean }> {
    const id = parseId(idParam, 'fbaReplenishmentId');

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.fbaReplenishment.findUnique({
        where: { id },
        select: {
          id: true,
          requestNo: true,
          status: true,
          requestedQty: true,
          actualQty: true,
          expressNo: true,
        },
      });
      if (!row) {
        throw new NotFoundException('FBA 补货申请不存在');
      }

      if (String(row.status) === 'deleted') {
        return {
          id: row.id.toString(),
          requestNo: row.requestNo,
          status: String(row.status),
          idempotent: true,
        };
      }

      const deletedAt = new Date();
      const updated = await tx.fbaReplenishment.update({
        where: { id: row.id },
        data: {
          status: 'deleted',
          deletedBy: operatorId,
          deletedAt,
        },
        select: {
          id: true,
          requestNo: true,
          status: true,
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'fba_replenishment',
        entityId: row.id,
        action: AuditAction.delete,
        eventType: AuditEventType.INVENTORY_ADJUST_VOIDED,
        beforeData: {
          status: row.status,
          requestedQty: row.requestedQty,
          actualQty: row.actualQty,
          expressNo: row.expressNo,
        },
        afterData: {
          status: updated.status,
          deletedAt,
        },
        operatorId,
        requestId,
      });

      return {
        id: updated.id.toString(),
        requestNo: updated.requestNo,
        status: updated.status,
        idempotent: false,
      };
    });
  }

  async reopenFbaReplenishment(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ id: string; requestNo: string; status: string; idempotent: boolean }> {
    const id = parseId(idParam, 'fbaReplenishmentId');

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.fbaReplenishment.findUnique({
        where: { id },
        select: {
          id: true,
          requestNo: true,
          status: true,
          requestedQty: true,
          actualQty: true,
          expressNo: true,
          confirmedBy: true,
          confirmedAt: true,
        },
      });

      if (!row) {
        throw new NotFoundException('FBA 补货申请不存在');
      }
      if (String(row.status) === 'deleted') {
        throw new UnprocessableEntityException(
          '已删除的FBA补货申请单不能变更',
        );
      }
      if (String(row.status) === 'outbound') {
        throw new UnprocessableEntityException(
          '已出库的FBA补货申请单不能变更',
        );
      }
      if (String(row.status) === 'pending_confirm') {
        return {
          id: row.id.toString(),
          requestNo: row.requestNo,
          status: String(row.status),
          idempotent: true,
        };
      }
      if (String(row.status) !== 'pending_outbound') {
        throw new ConflictException(
          `申请单 ${row.requestNo} 当前状态不支持变更`,
        );
      }

      const updated = await tx.fbaReplenishment.update({
        where: { id: row.id },
        data: {
          status: 'pending_confirm',
          confirmedBy: null,
          confirmedAt: null,
        },
        select: {
          id: true,
          requestNo: true,
          status: true,
        },
      });

      await createFbaReplenishmentInventoryAdjustAudit({
        auditService: this.auditService,
        tx,
        entityId: row.id,
        beforeData: {
          status: row.status,
          requestedQty: row.requestedQty,
          actualQty: row.actualQty,
          expressNo: row.expressNo,
          confirmedBy: row.confirmedBy?.toString() ?? null,
          confirmedAt: row.confirmedAt,
        },
        afterData: {
          status: updated.status,
          requestedQty: row.requestedQty,
          actualQty: row.actualQty,
          expressNo: row.expressNo,
          confirmedBy: null,
          confirmedAt: null,
        },
        operatorId,
        requestId,
      });

      return {
        id: updated.id.toString(),
        requestNo: updated.requestNo,
        status: updated.status,
        idempotent: false,
      };
    });
  }

  async listFbaReplenishments(): Promise<unknown[]> {
    const rows = await this.prisma.fbaReplenishment.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
        sku: {
          select: {
            id: true,
            sku: true,
            fnsku: true,
            productId: true,
            masterProduct: {
              select: {
                productName: true,
              },
            },
          },
        },
        box: {
          select: {
            id: true,
            boxCode: true,
            shelf: { select: { id: true, shelfCode: true } },
          },
        },
      },
    });

    return rows.map((row) => {
      return {
        id: row.id.toString(),
        requestNo: row.requestNo,
        status: row.status,
        createdAt: row.createdAt,
        creator: row.creator
          ? {
              id: row.creator.id.toString(),
              username: row.creator.username,
            }
          : null,
        sku: row.sku
          ? {
              id: row.sku.id.toString(),
              sku: row.sku.sku,
              fnsku: row.sku.fnsku,
              productId: row.sku.productId,
              productName: row.sku.masterProduct?.productName ?? null,
            }
          : null,
        box: row.box
          ? {
              id: row.box.id.toString(),
              boxCode: row.box.boxCode,
              shelfCode: row.box.shelf?.shelfCode ?? null,
            }
          : null,
        requestedQty: row.requestedQty,
        actualQty: row.actualQty,
        expressNo: row.expressNo,
      };
    });
  }

  async getFbaPendingSummary(): Promise<{
    pendingConfirmCount: number;
    pendingBySku: Record<string, number>;
    pendingByBoxSku: Record<string, number>;
  }> {
    const pendingConfirmCount = await this.prisma.fbaReplenishment.count({
      where: {
        status: { in: ['pending_confirm', 'pending_outbound'] },
      },
    });

    const pendingRows = await this.prisma.fbaReplenishment.findMany({
      where: {
        status: { in: ['pending_confirm', 'pending_outbound'] },
      },
      select: {
        skuId: true,
        boxId: true,
        status: true,
        requestedQty: true,
        actualQty: true,
      },
    });

    const pendingBySku: Record<string, number> = {};
    const pendingByBoxSku: Record<string, number> = {};

    pendingRows.forEach((row) => {
      const qty = Number(
        row.status === 'pending_outbound'
          ? (row.actualQty ?? row.requestedQty)
          : row.requestedQty,
      );
      if (qty <= 0) return;

      const skuKey = row.skuId.toString();
      pendingBySku[skuKey] = (pendingBySku[skuKey] ?? 0) + qty;

      const boxSkuKey = `${row.boxId.toString()}-${skuKey}`;
      pendingByBoxSku[boxSkuKey] = (pendingByBoxSku[boxSkuKey] ?? 0) + qty;
    });

    return {
      pendingConfirmCount,
      pendingBySku,
      pendingByBoxSku,
    };
  }

  async getSkuInventoryTotals(): Promise<Record<string, number>> {
    return getSkuInventoryTotalsByProduct.call(this);
  }

  async getAmazonReplenishmentSupportData(): Promise<unknown> {
    const [skus, masterProducts, pendingRows] = await Promise.all([
      this.prisma.sku.findMany({
        where: { status: 1, productId: { not: null } },
        select: {
          id: true,
          sku: true,
          fnsku: true,
          asin: true,
          productId: true,
          masterProduct: { select: { productName: true } },
        },
      }),
      this.prisma.masterProduct.findMany({
        where: { status: 1 },
        select: { productId: true, productName: true, stockQty: true },
      }),
      this.prisma.fbaReplenishment.findMany({
        where: { status: { in: ['pending_confirm', 'pending_outbound'] } },
        select: { skuId: true, status: true, requestedQty: true, actualQty: true },
      }),
    ]);
    const pendingBySku: Record<string, number> = {};
    pendingRows.forEach((row) => {
      const qty = Number(
        row.status === 'pending_outbound' ? (row.actualQty ?? row.requestedQty) : row.requestedQty,
      );
      if (qty <= 0) return;
      const skuId = row.skuId.toString();
      pendingBySku[skuId] = (pendingBySku[skuId] ?? 0) + qty;
    });
    return {
      skus: skus.map((row) => ({
        id: row.id.toString(),
        sku: row.sku,
        fnsku: row.fnsku,
        asin: row.asin,
        productId: row.productId,
        productName: row.masterProduct?.productName ?? null,
      })),
      masterProducts,
      pendingConfirmCount: pendingRows.length,
      pendingBySku,
    };
  }

  async importFbaSalesReport(
    buffer: Buffer,
    originalName: string | undefined,
    periodStartRaw: string | undefined,
    periodEndRaw: string | undefined,
    operatorId: bigint,
  ): Promise<unknown> {
    let reportPeriod: ReturnType<typeof parseFbaSalesPeriod>;
    try {
      reportPeriod = parseFbaSalesPeriod(periodStartRaw, periodEndRaw);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : '销售报告日期无效');
    }
    let reportRows: ReturnType<typeof parseFbaSalesBusinessReport>;
    try {
      reportRows = parseFbaSalesBusinessReport(buffer);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'FBA销售CSV解析失败');
    }

    const systemSkus = await this.prisma.sku.findMany({
      where: { status: 1, productId: { not: null } },
      select: { sku: true, fbmSku: true, rbSku: true, productId: true },
    });
    const classifiedRows = classifyFbaSalesRows(reportRows, systemSkus);
    const fbaRows = classifiedRows.filter((row) => row.channel === 'fba');
    const fbmRows = classifiedRows.filter((row) => row.channel === 'fbm');
    const unmatchedRows = classifiedRows.filter((row) => row.channel === 'unmatched');
    const ambiguousRows = classifiedRows.filter((row) => row.channel === 'ambiguous');
    const fbaOrderedQty = fbaRows.reduce((sum, row) => sum + row.orderedQty, 0);
    const fileName = String(originalName || 'amazon-business-report.csv').trim().slice(0, 255);

    const snapshot = await this.prisma.$transaction(async (tx) => {
      const created = await tx.fbaSalesSnapshot.create({
        data: {
          fileName,
          periodDays: reportPeriod.periodDays,
          periodStart: reportPeriod.periodStart,
          periodEnd: reportPeriod.periodEnd,
          totalRows: classifiedRows.length,
          fbaRows: fbaRows.length,
          fbmRows: fbmRows.length,
          unmatchedRows: unmatchedRows.length,
          ambiguousRows: ambiguousRows.length,
          fbaOrderedQty,
          importedBy: operatorId,
          items: {
            create: classifiedRows.map((row) => ({
              sellerSku: row.sellerSku,
              asin: row.asin || null,
              productName: row.productName || null,
              productId: row.productId,
              channel: row.channel,
              matchedBy: row.matchedBy,
              orderedQty: row.orderedQty,
              orderItemQty: row.orderItemQty,
              salesAmount: row.salesAmount,
            })),
          },
        },
        select: { id: true, createdAt: true },
      });
      const expired = await tx.fbaSalesSnapshot.findMany({
        orderBy: { id: 'desc' },
        skip: DASHBOARD_SNAPSHOT_RETENTION_LIMIT,
        select: { id: true },
      });
      if (expired.length) {
        await tx.fbaSalesSnapshot.deleteMany({ where: { id: { in: expired.map((row) => row.id) } } });
      }
      return created;
    });

    return {
      snapshotId: snapshot.id.toString(),
      fileName,
      periodDays: reportPeriod.periodDays,
      periodStart: reportPeriod.periodStart.toISOString().slice(0, 10),
      periodEnd: reportPeriod.periodEnd.toISOString().slice(0, 10),
      totalRows: classifiedRows.length,
      fbaRows: fbaRows.length,
      fbmRows: fbmRows.length,
      unmatchedRows: unmatchedRows.length,
      ambiguousRows: ambiguousRows.length,
      fbaOrderedQty,
      importedAt: snapshot.createdAt.toISOString(),
    };
  }

  async importAmazonReplenishmentReports(
    businessBuffer: Buffer,
    businessOriginalName: string | undefined,
    inventoryBuffer: Buffer,
    inventoryOriginalName: string | undefined,
    operatorId: bigint,
  ): Promise<unknown> {
    try {
      const businessRows = parseAmazonReplenishmentCsv(businessBuffer);
      const inventoryRows = parseAmazonReplenishmentCsv(inventoryBuffer);
      validateAmazonReplenishmentReports(businessRows, inventoryRows);
      const metadata = getAmazonInventorySnapshotMetadata(inventoryRows);
      const snapshot = await this.prisma.$transaction(async (tx) => {
        const created = await tx.amazonReplenishmentSnapshot.create({
          data: {
            businessFileName: String(businessOriginalName || 'amazon-sales-by-child-asin.csv').trim().slice(0, 255),
            inventoryFileName: String(inventoryOriginalName || 'amazon-fba-inventory.csv').trim().slice(0, 255),
            businessRowCount: businessRows.length,
            inventoryRowCount: inventoryRows.length,
            businessRows: businessRows as Prisma.InputJsonValue,
            inventoryRows: inventoryRows as Prisma.InputJsonValue,
            store: metadata.store,
            snapshotDate: metadata.snapshotDate,
            importedBy: operatorId,
          },
        });
        const expired = await tx.amazonReplenishmentSnapshot.findMany({
          orderBy: { id: 'desc' },
          skip: DASHBOARD_SNAPSHOT_RETENTION_LIMIT,
          select: { id: true },
        });
        if (expired.length) {
          await tx.amazonReplenishmentSnapshot.deleteMany({
            where: { id: { in: expired.map((row) => row.id) } },
          });
        }
        return created;
      });
      return this.serializeAmazonReplenishmentSnapshot(snapshot, false);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : '亚马逊补货报表解析失败');
    }
  }

  async getLatestAmazonReplenishmentReports(): Promise<unknown> {
    const latestSnapshot = await this.prisma.amazonReplenishmentSnapshot.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    if (!latestSnapshot) return null;

    const snapshot = await this.prisma.amazonReplenishmentSnapshot.findUnique({
      where: { id: latestSnapshot.id },
    });
    return snapshot ? this.serializeAmazonReplenishmentSnapshot(snapshot) : null;
  }

  private serializeAmazonReplenishmentSnapshot(snapshot: {
    id: bigint;
    businessFileName: string;
    inventoryFileName: string;
    businessRowCount: number;
    inventoryRowCount: number;
    businessRows: Prisma.JsonValue;
    inventoryRows: Prisma.JsonValue;
    store: string | null;
    snapshotDate: string | null;
    createdAt: Date;
  }, includeRows = true): Record<string, unknown> {
    const result: Record<string, unknown> = {
      id: snapshot.id.toString(),
      businessFileName: snapshot.businessFileName,
      inventoryFileName: snapshot.inventoryFileName,
      businessRowCount: snapshot.businessRowCount,
      inventoryRowCount: snapshot.inventoryRowCount,
      store: snapshot.store,
      snapshotDate: snapshot.snapshotDate,
      importedAt: snapshot.createdAt.toISOString(),
    };
    if (includeRows) {
      result.businessRows = snapshot.businessRows;
      result.inventoryRows = snapshot.inventoryRows;
    }
    return result;
  }

  async getOverviewDashboard(options: { includeFba?: boolean; fbaSnapshotId?: string } = {}): Promise<unknown> {
    return getOverviewDashboardByProduct.call(this, options);
  }

  async buildProductionRecommendationsExcel(
    options: { includeFba?: boolean; fbaSnapshotId?: string } = {},
  ): Promise<{ fileName: string; content: Buffer }> {
    if (!options.includeFba || !String(options.fbaSnapshotId || '').trim()) {
      throw new BadRequestException('请先上传最近90天FBA销售报告，再下载工厂备货建议');
    }
    const dashboard = (await getOverviewDashboardByProduct.call(this, options)) as {
      production?: {
        recommendations?: Array<{
          productId?: string | null;
          productName?: string | null;
          totalStock?: number | null;
          availableStock?: number | null;
          lockedStock?: number | null;
          inTransitStock?: number | null;
          arrangedProductionQty?: number | null;
          securedStock?: number | null;
          outbound30d?: number | null;
          systemOrderQty90d?: number | null;
          fbaOrderedQty90d?: number | null;
          totalOrderQty90d?: number | null;
          avgDailyOutbound90d?: number | null;
          stockCoverageDays?: number | null;
          securedCoverageDays?: number | null;
          targetDemandQty?: number | null;
          suggestedProductionQty?: number | null;
          shortageDays?: number | null;
          estimatedArrivalDays?: number | null;
          demandSpike?: boolean | null;
          fluctuationQty?: number | null;
          priority?: string | null;
        }>;
      };
    };
    const recommendations = Array.isArray(dashboard.production?.recommendations)
      ? dashboard.production.recommendations
      : [];
    const data = recommendations.map((row) => ({
      '产品ID': row.productId ?? '',
      '产品名称': row.productName ?? '',
      '总库存': Number(row.totalStock ?? 0),
      '可用库存': Number(row.availableStock ?? 0),
      '锁定库存': Number(row.lockedStock ?? 0),
      '在途库存': Number(row.inTransitStock ?? 0),
      '已安排生产': Number(row.arrangedProductionQty ?? 0),
      '总保障库存': Number(row.securedStock ?? 0),
      '30天系统订单量': Number(row.outbound30d ?? 0),
      '90天系统订单量': Number(row.systemOrderQty90d ?? 0),
      '90天FBA订单量': Number(row.fbaOrderedQty90d ?? 0),
      '90天全渠道订单量': Number(row.totalOrderQty90d ?? 0),
      '90天日均消耗': Number(row.avgDailyOutbound90d ?? 0),
      '在库覆盖天数': Number(row.stockCoverageDays ?? 0),
      '总覆盖天数': Number(row.securedCoverageDays ?? 0),
      '目标需求': Number(row.targetDemandQty ?? 0),
      '建议生产量': Number(row.suggestedProductionQty ?? 0),
      '预计缺口天数': Number(row.shortageDays ?? 0),
      '预计到货天数': Number(row.estimatedArrivalDays ?? 0),
      '异常波动': row.demandSpike ? '是' : '否',
      '波动数量': Number(row.fluctuationQty ?? 0),
      '优先级': row.priority ?? '',
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '工厂备货建议');
    const content = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    return {
      fileName: `工厂备货建议-${this.formatShortDateForFilename(new Date())}.xlsx`,
      content,
    };
  }

  async getBulkUpdateTemplate(): Promise<{ fileName: string; content: Buffer }> {
    const cwd = process.cwd();
    const candidates = [
      join(cwd, 'docs', INVENTORY_BULK_UPDATE_TEMPLATE_FILE),
      join(cwd, '..', '..', 'docs', INVENTORY_BULK_UPDATE_TEMPLATE_FILE),
    ];

    for (const templatePath of candidates) {
      try {
        const content = await readFile(templatePath);
        return {
          fileName: INVENTORY_BULK_UPDATE_TEMPLATE_FILE,
          content,
        };
      } catch {
        // try next candidate
      }
    }

    throw new NotFoundException(`模板文件不存在：${INVENTORY_BULK_UPDATE_TEMPLATE_FILE}`);
  }

  async importBulkUpdateExcel(
    fileBuffer: Buffer,
    originalName: string | undefined,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{
    totalRows: number;
    changedProductCount: number;
    changedSkuCount: number;
    changedItemCount: number;
    changedRows: number;
    fileName: string | null;
    adjustNo: string | null;
  }> {
    return importBulkUpdateExcelByProduct.call(this, fileBuffer, originalName, operatorId, requestId);
  }

  async buildFbaReplenishmentsExcel(): Promise<{ fileName: string; content: Buffer }> {
    const rows = await this.prisma.fbaReplenishment.findMany({
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      include: {
        sku: {
          select: {
            sku: true,
            rbSku: true,
            asin: true,
            fnsku: true,
            fbmSku: true,
            shop: true,
            remark: true,
            productId: true,
            masterProduct: {
              select: {
                productName: true,
              },
            },
          },
        },
        box: {
          select: {
            boxCode: true,
            shelf: {
              select: {
                shelfCode: true,
              },
            },
          },
        },
        creator: {
          select: {
            username: true,
          },
        },
        confirmer: {
          select: {
            username: true,
          },
        },
        outbounder: {
          select: {
            username: true,
          },
        },
      },
    });

    const data = rows.map((row) => ({
      '申请单号': row.requestNo ?? '',
      '状态': this.getFbaStatusLabel(row.status),
      'SKU': row.sku?.sku ?? '',
      'rbSKU': row.sku?.rbSku ?? '',
      'ASIN': row.sku?.asin ?? '',
      'FNSKU': row.sku?.fnsku ?? '',
      'FBMSKU': row.sku?.fbmSku ?? '',
      '店铺': row.sku?.shop ?? '',
      '产品ID': row.sku?.productId ?? '',
      '产品名称': row.sku?.masterProduct?.productName ?? '',
      '产品备注': row.sku?.remark ?? '',
      '箱号': row.box?.boxCode ?? '',
      '货架号': row.box?.shelf?.shelfCode ?? '',
      '申请数量': Number(row.requestedQty ?? 0),
      '实际数量': Number(row.actualQty ?? row.requestedQty ?? 0),
      '快递单号': row.expressNo ?? '',
      '申请时间': this.formatDateTimeForExport(row.createdAt),
      '确认时间': this.formatDateTimeForExport(row.confirmedAt),
      '出库时间': this.formatDateTimeForExport(row.outboundAt),
      '申请人': row.creator?.username ?? '',
      '确认人': row.confirmer?.username ?? '',
      '出库人': row.outbounder?.username ?? '',
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'FBA补货申请');
    const content = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    return {
      fileName: `fba_replenishments_${this.formatDateForFilename(new Date())}.xlsx`,
      content,
    };
  }

  parseBulkInventoryUpdateRows(fileBuffer: Buffer): BulkInventoryUpdateRow[] {
    return parseBulkInventoryUpdateRowsByProduct.call(this, fileBuffer);
  }

  private normalizeImportHeader(header: string): string {
    return normalizeImportHeaderValue(header);
  }

  pickImportField(row: Record<string, string>, aliases: string[]): string | null {
    for (const alias of aliases) {
      const normalizedAlias = this.normalizeImportHeader(alias);
      const value = String(row[normalizedAlias] ?? '').trim();
      if (value) {
        return value;
      }
    }
    return null;
  }

  private formatFbaRequestNo(date: Date): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `FBA-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
  }

  async generateFbaRequestNo(tx: Prisma.TransactionClient): Promise<string> {
    let candidate = new Date();
    for (let i = 0; i < 5; i += 1) {
      const requestNo = this.formatFbaRequestNo(candidate);
      const exists = await tx.fbaReplenishment.findUnique({
        where: { requestNo },
        select: { id: true },
      });
      if (!exists) {
        return requestNo;
      }
      candidate = new Date(candidate.getTime() + 1000);
    }
    throw new ConflictException('申请单号重复，请稍后重试。');
  }

  getFbaStatusLabel(status: string): string {
    if (status === 'pending_confirm') return '待确认';
    if (status === 'pending_outbound') return '待出库';
    if (status === 'outbound') return '已出库';
    if (status === 'deleted') return '已删除';
    return status;
  }

  getActiveFbaReservedQty(row: {
    status: string;
    requestedQty: number | null;
    actualQty: number | null;
  }): number {
    return Number(
      row.status === 'pending_outbound' ? row.actualQty ?? row.requestedQty : row.requestedQty,
    );
  }

  private async ensureBoxesNotUnderActiveFba(
    tx: Prisma.TransactionClient,
    boxIds: bigint[],
    operationName: string,
  ): Promise<void> {
    const uniqueBoxIds = Array.from(new Set(boxIds.map((id) => id.toString()))).map((id) => BigInt(id));
    if (!uniqueBoxIds.length) return;

    const activeRows = await tx.fbaReplenishment.findMany({
      where: {
        boxId: { in: uniqueBoxIds },
        status: { in: ['pending_confirm', 'pending_outbound'] },
      },
      select: {
        requestNo: true,
        status: true,
        box: { select: { boxCode: true } },
        sku: { select: { sku: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 1,
    });
    const activeRow = activeRows[0];
    if (!activeRow) return;

    throw new ConflictException(
      `箱号 ${activeRow.box?.boxCode || '-'} 已存在 FBA 补货申请 ${activeRow.requestNo}（SKU ${activeRow.sku?.sku || '-'}，状态 ${this.getFbaStatusLabel(activeRow.status)}），不能执行${operationName}`,
    );
  }

  private formatDateForFilename(date: Date): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
  }

  private formatShortDateForFilename(date: Date): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year.slice(-2)}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
  }

  private formatDateTimeForExport(date: Date | null | undefined): string {
    if (!date) return '';
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  async ensureSkusNotUnderPendingEdit(
    tx: Prisma.TransactionClient,
    skuIds: bigint[],
  ): Promise<void> {
    if (!Array.isArray(skuIds) || skuIds.length === 0) {
      return;
    }
    const uniqueSkuIds = Array.from(new Set(skuIds.map((id) => id.toString()))).map((id) => BigInt(id));
    const pending = await tx.productEditRequest.findFirst({
      where: {
        skuId: { in: uniqueSkuIds },
        status: ProductEditRequestStatus.pending,
      },
      select: { id: true },
    });
    if (pending) {
      throw new ConflictException(SKU_EDIT_PENDING_BLOCK_MESSAGE);
    }
  }

  private normalizeAdjustItem(item: CreateAdjustOrderItemDto): {
    boxId: bigint;
    skuId: bigint;
    qtyDelta: number;
    reason?: string;
  } {
    if (item.qtyDelta === 0) {
      throw new BadRequestException('调整数量不能为 0');
    }
    return {
      boxId: BigInt(item.boxId),
      skuId: BigInt(item.skuId),
      qtyDelta: item.qtyDelta,
      reason: item.reason,
    };
  }

  private async ensureReferences(
    tx: Prisma.TransactionClient,
    items: Array<{ boxId: bigint; skuId: bigint }>,
  ): Promise<void> {
    const uniqueBoxIds = Array.from(new Set(items.map((item) => item.boxId.toString()))).map((id) => BigInt(id));
    const uniqueSkuIds = Array.from(new Set(items.map((item) => item.skuId.toString()))).map((id) => BigInt(id));

    const [boxes, skus] = await Promise.all([
      tx.box.findMany({
        where: { id: { in: uniqueBoxIds } },
        select: { id: true },
      }),
      tx.sku.findMany({
        where: {
          id: { in: uniqueSkuIds },
          status: 1,
        },
        select: { id: true, productId: true },
      }),
    ]);

    if (boxes.length !== uniqueBoxIds.length) {
      throw new NotFoundException('调整单明细中存在不存在的箱号');
    }
    if (skus.length !== uniqueSkuIds.length) {
      throw new NotFoundException('调整单明细中存在不存在的 SKU');
    }
    if (skus.some((sku) => !String(sku.productId || '').trim())) {
      throw new BadRequestException('调整单中的 SKU 未绑定产品 ID，无法写入主商品库存');
    }
  }

  private async applyAdjustOrder(
    tx: Prisma.TransactionClient,
    orderId: bigint,
    operatorId: bigint,
    requestId: string | undefined,
    lockOrder: boolean,
  ): Promise<AdjustOrderResult> {
    if (lockOrder) {
      const locked = await tx.$queryRaw<Array<{ id: bigint; status: OrderStatus }>>(
        Prisma.sql`SELECT id, status FROM inventory_adjust_orders WHERE id = ${orderId} FOR UPDATE`,
      );
      if (locked.length === 0) {
        throw new NotFoundException('调整单不存在');
      }
      if (locked[0].status === OrderStatus.confirmed) {
        return {
          orderId: orderId.toString(),
          status: OrderStatus.confirmed,
          idempotent: true,
          changedRows: 0,
        };
      }
      if (locked[0].status === OrderStatus.void) {
        throw new UnprocessableEntityException('已作废的调整单不能确认');
      }
    }

    const order = await tx.inventoryAdjustOrder.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('调整单不存在');
    if (order.items.length === 0) {
      throw new UnprocessableEntityException('调整单没有明细，无法确认');
    }

    const skuRows = await tx.sku.findMany({
      where: {
        status: 1,
        id: {
          in: Array.from(new Set(order.items.map((item) => item.skuId.toString()))).map((id) =>
            BigInt(id),
          ),
        },
      },
      select: {
        id: true,
        productId: true,
        sku: true,
        masterProduct: {
          select: {
            id: true,
            productId: true,
            productName: true,
            stockQty: true,
          },
        },
      },
    });
    const skuById = new Map(skuRows.map((row) => [row.id.toString(), row]));
    const inventoryPairs = order.items.map((item) => {
      const sku = skuById.get(item.skuId.toString());
      const productId = String(sku?.productId || '').trim();
      if (!sku || !productId || !sku.masterProduct) {
        throw new BadRequestException(
          `SKU ${item.skuId.toString()} 未绑定主商品，无法确认调整单`,
        );
      }
      return {
        boxId: item.boxId,
        productId,
      };
    });

    const currentInventoryRows = await findMasterProductBoxInventoryByPairs(tx, inventoryPairs, {
      select: {
        boxId: true,
        productId: true,
        qty: true,
      },
    });
    const currentQtyMap = new Map<string, number>();
    currentInventoryRows.forEach((row) => {
      const key = getBoxProductInventoryKey(row.boxId, row.productId);
      currentQtyMap.set(key, Number(row.qty ?? 0));
    });

    const productAuditBeforeById = new Map<
      string,
      { entityId: bigint; productId: string; productName: string | null; stockQty: number }
    >();

    for (const item of order.items) {
      const sku = skuById.get(item.skuId.toString())!;
      const productId = String(sku.productId || '').trim();
      const key = getBoxProductInventoryKey(item.boxId, productId);
      const beforeQty = currentQtyMap.get(key) ?? 0;
      const afterQty = beforeQty + item.qtyDelta;
      if (afterQty < 0) {
        throw new ConflictException(
          `库存不足，箱号ID ${item.boxId.toString()}、产品ID ${productId}`,
        );
      }

      await upsertMasterProductBoxInventoryQty(tx, item.boxId, productId, afterQty);
      currentQtyMap.set(key, afterQty);

      if (!productAuditBeforeById.has(productId)) {
        productAuditBeforeById.set(productId, {
          entityId: sku.masterProduct!.id,
          productId,
          productName: sku.masterProduct!.productName,
          stockQty: Number(sku.masterProduct!.stockQty ?? 0),
        });
      }

      await tx.stockMovement.create({
        data: {
          movementType: 'adjust',
          refType: 'inventory_adjust_order',
          refId: order.id,
          boxId: item.boxId,
          productId,
          skuId: item.skuId,
          qtyDelta: item.qtyDelta,
          operatorId,
        },
      });

      await createBoxInventoryAudit({
        auditService: this.auditService,
        tx,
        entityId: item.boxId,
        eventType:
          item.qtyDelta > 0
            ? AuditEventType.BOX_STOCK_INCREASED
            : AuditEventType.BOX_STOCK_OUTBOUND,
        beforeData: {
          scope: 'master_product',
          boxId: item.boxId,
          productId,
          skuId: item.skuId,
          qty: beforeQty,
        },
        afterData: {
          scope: 'master_product',
          boxId: item.boxId,
          productId,
          skuId: item.skuId,
          qty: afterQty,
        },
        operatorId,
        requestId,
        remark: `adjust order ${order.adjustNo}`,
      });
    }

    for (const productAuditBefore of productAuditBeforeById.values()) {
      const totalQty = await this.recalculateMasterProductStockQty(tx, productAuditBefore.productId);
      await createMasterProductInventoryAdjustAudit({
        auditService: this.auditService,
        tx,
        entityId: productAuditBefore.entityId,
        beforeData: {
          productId: productAuditBefore.productId,
          productName: productAuditBefore.productName,
          stockQty: productAuditBefore.stockQty,
        },
        afterData: {
          productId: productAuditBefore.productId,
          productName: productAuditBefore.productName,
          stockQty: totalQty,
          by: 'adjust_order',
          adjustNo: order.adjustNo,
        },
        operatorId,
        requestId,
        remark: `adjust order ${order.adjustNo}`,
      });
    }

    await tx.inventoryAdjustOrder.update({
      where: { id: orderId },
      data: { status: OrderStatus.confirmed },
    });

    await createInventoryAdjustOrderConfirmedAudit({
      auditService: this.auditService,
      tx,
      entityId: order.id,
      beforeData: { status: order.status },
      afterData: { status: OrderStatus.confirmed },
      operatorId,
      requestId,
    });

    return {
      orderId: order.id.toString(),
      status: OrderStatus.confirmed,
      idempotent: false,
      changedRows: order.items.length,
    };
  }

  async resolveSkuForManual(
    tx: Prisma.TransactionClient,
    payload: ManualAdjustDto,
  ): Promise<{ id: bigint; sku: string }> {
    if (payload.skuId) {
      const sku = await tx.sku.findFirst({
        where: {
          id: BigInt(payload.skuId),
          status: 1,
        },
        select: { id: true, sku: true },
      });
      if (!sku) throw new NotFoundException('SKU 不存在');
      return sku;
    }

    const keyword = payload.keyword?.trim();
    if (!keyword) {
      throw new BadRequestException('skuId 或关键字不能为空');
    }

    const matched = await tx.sku.findMany({
      where: {
        status: 1,
        OR: [
          { sku: { contains: keyword } },
          { rbSku: { contains: keyword } },
          { asin: { contains: keyword } },
          { fnsku: { contains: keyword } },
        ],
      },
      select: { id: true, sku: true },
      take: 20,
    });
    if (matched.length === 0) {
      throw new NotFoundException('未找到匹配的 SKU');
    }
    if (matched.length > 1) {
      throw new UnprocessableEntityException('匹配到多个 SKU，请明确传入 skuId');
    }
    return matched[0];
  }

  async resolveBoxForManual(
    tx: Prisma.TransactionClient,
    payload: ManualAdjustDto,
  ): Promise<{ id: bigint; boxCode: string }> {
    if (payload.boxId) {
      const box = await tx.box.findUnique({
        where: { id: BigInt(payload.boxId) },
        select: { id: true, boxCode: true },
      });
      if (!box) throw new NotFoundException('箱号不存在');
      return box;
    }
    const boxCode = normalizeBoxCode(payload.boxCode);
    if (!boxCode) {
      throw new BadRequestException('boxId 或箱号不能为空');
    }
    const box = await this.findBoxByEquivalentCode(tx, boxCode);
    if (!box) throw new NotFoundException('箱号不存在');
    return box;
  }

  async resolveOrCreateBulkUpdateDefaultShelf(
    tx: Prisma.TransactionClient,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ id: bigint }> {
    const existed = await tx.shelf.findFirst({
      where: {
        shelfCode: {
          in: [BULK_UPDATE_DEFAULT_SHELF_CODE, ...BULK_UPDATE_COMPAT_SHELF_CODES],
        },
      },
      select: {
        id: true,
        shelfCode: true,
        name: true,
        status: true,
      },
    });

    if (!existed) {
      const created = await tx.shelf.create({
        data: {
          shelfCode: BULK_UPDATE_DEFAULT_SHELF_CODE,
          name: BULK_UPDATE_DEFAULT_SHELF_NAME,
          status: 1,
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'shelf',
        entityId: created.id,
        action: AuditAction.create,
        eventType: AuditEventType.SHELF_CREATED,
        beforeData: null,
        afterData: created as unknown as Record<string, unknown>,
        operatorId,
        requestId,
        remark: 'auto created from bulk inventory update',
      });

      return { id: created.id };
    }

    if (Number(existed.status) === 1) {
      return { id: existed.id };
    }

    const updated = await tx.shelf.update({
      where: { id: existed.id },
      data: { status: 1 },
      select: {
        id: true,
        shelfCode: true,
        name: true,
        status: true,
      },
    });

    await this.auditService.create({
      db: tx,
      entityType: 'shelf',
      entityId: updated.id,
      action: AuditAction.update,
      eventType: AuditEventType.SHELF_FIELD_UPDATED,
      beforeData: existed as unknown as Record<string, unknown>,
      afterData: updated as unknown as Record<string, unknown>,
      operatorId,
      requestId,
      remark: 'enabled for bulk inventory update',
    });

    return { id: updated.id };
  }

  async resolveOrCreateBulkUpdateBox(
    tx: Prisma.TransactionClient,
    boxCode: string,
    defaultShelfId: bigint,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ id: bigint; boxCode: string; status: number; shelfStatus: number }> {
    const normalizedBoxCode = normalizeBoxCode(boxCode);
    if (!normalizedBoxCode) {
      throw new UnprocessableEntityException('箱号格式无效');
    }

    const found = await this.findBoxByEquivalentCode(tx, normalizedBoxCode);

    if (found) {
      return {
        id: found.id,
        boxCode: found.boxCode,
        status: Number(found.status ?? 0),
        shelfStatus: Number(found.shelf?.status ?? 0),
      };
    }

    try {
        const created = await tx.box.create({
          data: {
          boxCode: normalizedBoxCode,
          shelfId: defaultShelfId,
          status: 1,
        },
        select: {
          id: true,
          boxCode: true,
          status: true,
          shelf: {
            select: {
              status: true,
            },
          },
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'box',
        entityId: created.id,
        action: AuditAction.create,
        eventType: AuditEventType.BOX_CREATED,
        beforeData: null,
        afterData: {
          id: created.id,
          boxCode: created.boxCode,
          shelfId: defaultShelfId,
          status: created.status,
        },
        operatorId,
        requestId,
        remark: 'auto created from bulk inventory update',
      });

      return {
        id: created.id,
        boxCode: created.boxCode,
        status: Number(created.status ?? 0),
        shelfStatus: Number(created.shelf?.status ?? 0),
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.findBoxByEquivalentCode(tx, normalizedBoxCode);

        if (existing) {
          return {
            id: existing.id,
            boxCode: existing.boxCode,
            status: Number(existing.status ?? 0),
            shelfStatus: Number(existing.shelf?.status ?? 0),
          };
        }
      }
      throw error;
    }
  }

  async findBoxByEquivalentCode(
    tx: Prisma.TransactionClient,
    rawBoxCode: string | null | undefined,
  ): Promise<{
    id: bigint;
    boxCode: string;
    status: number;
    shelf: { status: number; shelfCode?: string } | null;
  } | null> {
    const boxCode = normalizeBoxCode(rawBoxCode);
    if (!boxCode) return null;

    const box = await tx.box.findFirst({
      where: {
        boxCode: {
          in: buildEquivalentBoxCodes(boxCode),
        },
      },
      select: {
        id: true,
        boxCode: true,
        status: true,
        shelf: {
          select: {
            status: true,
            shelfCode: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    });

    if (!box) return null;

    return {
      id: box.id,
      boxCode: box.boxCode,
      status: Number(box.status ?? 0),
      shelf: box.shelf
        ? {
            status: Number(box.shelf.status ?? 0),
            shelfCode: box.shelf.shelfCode,
          }
        : null,
    };
  }

  async recalculateMasterProductStockQty(
    tx: Prisma.TransactionClient,
    productId: string,
  ): Promise<number> {
    const aggregate = await tx.masterProductBoxInventory.aggregate({
      where: {
        productId,
      },
      _sum: {
        qty: true,
      },
    });

    const totalQty = Number(aggregate._sum.qty ?? 0);
    await tx.masterProduct.update({
      where: { productId },
      data: { stockQty: totalQty },
    });
    if (totalQty > 0) {
      await tx.masterProduct.updateMany({
        where: { productId, firstStockedAt: null },
        data: { firstStockedAt: new Date() },
      });
    }
    return totalQty;
  }

  async recalculateMasterProductStockQtyMap(
    tx: Prisma.TransactionClient,
    productIds: string[],
  ): Promise<Map<string, number>> {
    const uniqueProductIds = Array.from(new Set(productIds.filter(Boolean)));
    if (uniqueProductIds.length === 0) {
      return new Map();
    }

    const aggregates = await tx.masterProductBoxInventory.groupBy({
      by: ['productId'],
      where: {
        productId: {
          in: uniqueProductIds,
        },
      },
      _sum: {
        qty: true,
      },
    });

    const stockQtyByProductId = new Map<string, number>(
      uniqueProductIds.map((productId) => [productId, 0]),
    );

    aggregates.forEach((row) => {
      stockQtyByProductId.set(row.productId, Number(row._sum.qty ?? 0));
    });

    for (const [productId, totalQty] of stockQtyByProductId) {
      await tx.masterProduct.update({
        where: { productId },
        data: { stockQty: totalQty },
      });
    }
    const stockedProductIds = [...stockQtyByProductId.entries()]
      .filter(([, totalQty]) => totalQty > 0)
      .map(([productId]) => productId);
    if (stockedProductIds.length) {
      await tx.masterProduct.updateMany({
        where: { productId: { in: stockedProductIds }, firstStockedAt: null },
        data: { firstStockedAt: new Date() },
      });
    }

    return stockQtyByProductId;
  }
}

async function importBulkUpdateExcelByProduct(
  this: InventoryService,
  fileBuffer: Buffer,
  originalName: string | undefined,
  operatorId: bigint,
  requestId?: string,
): Promise<{
  totalRows: number;
  changedProductCount: number;
  changedSkuCount: number;
  changedItemCount: number;
  changedRows: number;
  fileName: string | null;
  adjustNo: string | null;
}> {
  const rows = this.parseBulkInventoryUpdateRows(fileBuffer)
    .map((row) => ({
      boxCode: String(row.boxCode || '').trim(),
      productId: String(row.productId || row.sku || '').trim(),
      qty: Number(row.qty ?? 0),
    }));
  validateBulkInventoryImportRows(rows);
  const productIds = Array.from(new Set(rows.map((row) => row.productId).filter(Boolean)));
  const boxCodes = Array.from(new Set(rows.map((row) => row.boxCode)));
  const equivalentBoxCodes = Array.from(
    new Set(boxCodes.flatMap((boxCode) => buildEquivalentBoxCodes(boxCode))),
  );

  try {
    return await this.prisma.$transaction(async (tx) => {
      const [products, boxes] = await Promise.all([
        tx.masterProduct.findMany({
          where: {
            productId: { in: productIds },
          },
          select: {
            id: true,
            productId: true,
            productName: true,
            stockQty: true,
          },
        }),
        tx.box.findMany({
          where: {
            boxCode: { in: equivalentBoxCodes },
          },
          select: {
            id: true,
            boxCode: true,
            status: true,
            shelf: {
              select: {
                status: true,
              },
            },
          },
        }),
      ]);

      const productById = new Map(products.map((item) => [item.productId, item]));
      const missingProductIds = productIds.filter((productId) => !productById.has(productId));
      if (missingProductIds.length > 0) {
        const preview = missingProductIds.slice(0, 20).join('、');
        const suffix = missingProductIds.length > 20 ? ' 等' : '';
        throw new UnprocessableEntityException(`以下产品ID不存在：${preview}${suffix}`);
      }

      const boxByCode = new Map<
        string,
        {
          id: bigint;
          boxCode: string;
          status: number;
          shelf: { status: number } | null;
        }
      >(boxes.map((item) => [normalizeBoxCode(item.boxCode) || item.boxCode, item]));

      const missingBoxCodes = boxCodes.filter((boxCode) => !boxByCode.has(boxCode));
      if (missingBoxCodes.length > 0) {
        const defaultShelf = await this.resolveOrCreateBulkUpdateDefaultShelf(tx, operatorId, requestId);

        for (const boxCode of missingBoxCodes) {
          const resolvedBox = await this.resolveOrCreateBulkUpdateBox(
            tx,
            boxCode,
            defaultShelf.id,
            operatorId,
            requestId,
          );

          const mappedBox = {
            id: resolvedBox.id,
            boxCode: resolvedBox.boxCode,
            status: resolvedBox.status,
            shelf: { status: resolvedBox.shelfStatus },
          };
          boxByCode.set(boxCode, mappedBox);
          boxByCode.set(resolvedBox.boxCode, mappedBox);
        }
      }

      const disabledBoxCodes = Array.from(boxByCode.values())
        .filter((item) => Number(item.status) !== 1 || Number(item.shelf?.status ?? 0) !== 1)
        .map((item) => item.boxCode);
      if (disabledBoxCodes.length > 0) {
        const preview = disabledBoxCodes.slice(0, 20).join('、');
        const suffix = disabledBoxCodes.length > 20 ? ' 等' : '';
        throw new UnprocessableEntityException(`以下箱号未启用，请先启用后再更新库存：${preview}${suffix}`);
      }

      const targets = rows.map((row) => {
        const product = productById.get(row.productId);
        const box = boxByCode.get(row.boxCode);
        if (!product || !box) {
          throw new UnprocessableEntityException('批量更新库存数据无效');
        }
        return {
          productEntityId: product.id,
          productId: product.productId,
          productName: product.productName,
          beforeStockQty: Number(product.stockQty ?? 0),
          boxId: box.id,
          boxCode: box.boxCode,
          qty: row.qty,
        };
      });

      const inventoryRows = await findMasterProductBoxInventoryByPairs(tx, targets, {
        select: {
          boxId: true,
          productId: true,
          qty: true,
        },
      });

      const inventoryQtyByBoxProduct = new Map<string, number>();
      inventoryRows.forEach((row) => {
        inventoryQtyByBoxProduct.set(
          getBoxProductInventoryKey(row.boxId, row.productId),
          Number(row.qty ?? 0),
        );
      });

      const adjustItems: Array<{
        boxId: bigint;
        boxCode: string;
        productEntityId: bigint;
        productId: string;
        productName: string | null;
        beforeStockQty: number;
        beforeQty: number;
        afterQty: number;
        qtyDelta: number;
      }> = [];

      targets.forEach((target) => {
        const key = getBoxProductInventoryKey(target.boxId, target.productId);
        const currentQty = inventoryQtyByBoxProduct.get(key) ?? 0;
        const delta = target.qty - currentQty;
        if (delta === 0) return;
        adjustItems.push({
          boxId: target.boxId,
          boxCode: target.boxCode,
          productEntityId: target.productEntityId,
          productId: target.productId,
          productName: target.productName ?? null,
          beforeStockQty: target.beforeStockQty,
          beforeQty: currentQty,
          afterQty: target.qty,
          qtyDelta: delta,
        });
      });

      const changedProductCount = new Set(adjustItems.map((item) => item.productId)).size;

      if (adjustItems.length === 0) {
        return {
          totalRows: rows.length,
          changedProductCount: 0,
          changedSkuCount: 0,
          changedItemCount: 0,
          changedRows: 0,
          fileName: originalName ?? null,
          adjustNo: null,
        };
      }

      for (const item of adjustItems) {
        if (item.afterQty <= 0) {
          await tx.masterProductBoxInventory.deleteMany({
            where: {
              boxId: item.boxId,
              productId: item.productId,
            },
          });
        } else {
          await upsertMasterProductBoxInventoryQty(
            tx,
            item.boxId,
            item.productId,
            item.afterQty,
          );
        }
      }

      const stockQtyByProductId = await this.recalculateMasterProductStockQtyMap(
        tx,
        adjustItems.map((item) => item.productId),
      );

      const auditPayloads: Parameters<AuditService['createMany']>[0] = [];
      for (const item of adjustItems) {
        const afterStockQty = stockQtyByProductId.get(item.productId) ?? 0;

        auditPayloads.push({
          db: tx,
          entityType: 'box',
          entityId: item.boxId,
          action: AuditAction.update,
          eventType:
            item.qtyDelta > 0
              ? AuditEventType.BOX_STOCK_INCREASED
              : AuditEventType.BOX_STOCK_OUTBOUND,
          beforeData: {
            scope: 'master_product',
            productId: item.productId,
            productName: item.productName,
            qty: item.beforeQty,
          },
          afterData: {
            scope: 'master_product',
            productId: item.productId,
            productName: item.productName,
            qty: item.afterQty,
            qtyDelta: item.qtyDelta,
          },
          operatorId,
          requestId,
          remark: originalName ? `bulk-inventory-update:${originalName}` : 'bulk-inventory-update',
        });

        auditPayloads.push({
          db: tx,
          entityType: 'master_product',
          entityId: item.productEntityId,
          action: AuditAction.update,
          eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED,
          beforeData: {
            productId: item.productId,
            productName: item.productName,
            stockQty: item.beforeStockQty,
          },
          afterData: {
            productId: item.productId,
            productName: item.productName,
            stockQty: afterStockQty,
            boxCode: item.boxCode,
            qtyDelta: item.qtyDelta,
          },
          operatorId,
          requestId,
          remark: originalName ? `bulk-inventory-update:${originalName}` : 'bulk-inventory-update',
        });
      }

      await this.auditService.createMany(auditPayloads);

      return {
        totalRows: rows.length,
        changedProductCount,
        changedSkuCount: changedProductCount,
        changedItemCount: adjustItems.length,
        changedRows: adjustItems.length,
        fileName: originalName ?? null,
        adjustNo: null,
      };
    }, {
      maxWait: BULK_INVENTORY_IMPORT_TRANSACTION_MAX_WAIT_MS,
      timeout: BULK_INVENTORY_IMPORT_TRANSACTION_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw buildBulkInventoryImportDatabaseError(error);
    }

    if (
      error instanceof Prisma.PrismaClientUnknownRequestError ||
      error instanceof Prisma.PrismaClientValidationError
    ) {
      throw new BadRequestException(
        `批量更新库存失败（${extractInventoryImportRuntimeErrorMessage(error)}）`,
      );
    }

    if (!(error instanceof HttpException)) {
      throw new BadRequestException(
        `批量更新库存失败（${extractInventoryImportRuntimeErrorMessage(error)}）`,
      );
    }

    throw error;
  }
};

function parseBulkInventoryUpdateRowsByProduct(
  this: InventoryService,
  fileBuffer: Buffer,
): BulkInventoryUpdateRow[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  } catch {
    throw new BadRequestException('无法解析 Excel 文件');
  }

  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) {
    throw new BadRequestException('Excel 中未找到可读取的工作表');
  }

  const sheet = workbook.Sheets[firstSheet];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  if (rows.length === 0) {
    throw new BadRequestException('Excel 中没有数据');
  }

  const errors: string[] = [];
  const result: BulkInventoryUpdateRow[] = [];
  const seenKeys = new Set<string>();

  rows.forEach((rawRow, idx) => {
    const rowNo = idx + 2;
    const normalized: Record<string, string> = {};
    Object.entries(rawRow).forEach(([key, value]) => {
      normalized[normalizeImportHeaderValue(key)] = String(value ?? '').trim();
    });

    const boxCode = normalizeBoxCode(
      this.pickImportField(normalized, ['箱号', 'box', 'boxCode', '箱号id', 'box id']),
    );
    if (!boxCode) {
      errors.push(`第${rowNo}行箱号不能为空`);
      return;
    }

    const productId = this.pickImportField(normalized, ['产品ID', 'productId', 'product id', 'sku']);
    if (!productId) {
      errors.push(`第${rowNo}行产品ID不能为空`);
      return;
    }

    const uniqueKey = `${boxCode}__${productId}`;
    if (seenKeys.has(uniqueKey)) {
      errors.push(`第${rowNo}行箱号 ${boxCode} + 产品ID ${productId} 重复，请只保留一行`);
      return;
    }

    const qtyText = this.pickImportField(normalized, ['数量', 'qty', '库存数', '库存数量', '实际数量']);
    if (qtyText === null) {
      errors.push(`第${rowNo}行数量不能为空`);
      return;
    }

    const qty = Number(String(qtyText || '').replaceAll(',', '').trim());
    if (!Number.isInteger(qty) || qty < 0) {
      errors.push(`第${rowNo}行数量必须是大于等于 0 的整数`);
      return;
    }

    seenKeys.add(uniqueKey);
    result.push({ boxCode, productId, sku: productId, qty });
  });

  if (errors.length > 0) {
    throw new UnprocessableEntityException(errors.join(' | '));
  }

  return result;
}

async function getOverviewDashboardByProduct(
  this: InventoryService,
  options: { includeFba?: boolean; fbaSnapshotId?: string } = {},
): Promise<unknown> {
  const service = this;
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const from7d = new Date(now.getTime() - 7 * dayMs);
  const from14d = new Date(now.getTime() - 14 * dayMs);
  const from30d = new Date(now.getTime() - 30 * dayMs);
  const from90d = new Date(now.getTime() - 90 * dayMs);
  const includeFba = options.includeFba === true;
  const fbaSnapshotIdText = String(options.fbaSnapshotId || '').trim();
  if (includeFba && !fbaSnapshotIdText) {
    throw new BadRequestException('请先上传最近90天FBA销售报告，再计算全渠道需求');
  }
  if (fbaSnapshotIdText && !/^\d+$/.test(fbaSnapshotIdText)) {
    throw new BadRequestException('FBA销量快照编号无效，请重新上传90天CSV');
  }
  const fbaSnapshotId = /^\d+$/.test(fbaSnapshotIdText) ? BigInt(fbaSnapshotIdText) : null;

  const rakutenShipmentOrderFilter: Prisma.RakutenOrderRecordWhereInput = {
    AND: [{ shipmentNo: { not: null } }, { shipmentNo: { not: '' } }],
    shipmentNoRegisteredAt: { gte: from90d },
  };
  const amazonShipmentOrderFilter: Prisma.AmazonOrderRecordWhereInput = {
    AND: [{ shipmentNo: { not: null } }, { shipmentNo: { not: '' } }],
    shipmentNoRegisteredAt: { gte: from90d },
  };
  const manualShipmentOrderFilter: Prisma.ManualOrderRecordWhereInput = {
    AND: [{ shipmentNo: { not: null } }, { shipmentNo: { not: '' } }],
    shipmentNoRegisteredAt: { gte: from90d },
  };

  const [
    activeUserCount,
    shelfCount,
    boxCount,
    pendingInboundOrderCount,
    masterProductCount,
    activeProducts,
    activeSkus,
    pendingRows,
    inTransitRows,
    arrangedProductionRows,
    latestFbaSalesSnapshot,
    systemRakutenRows,
    systemAmazonRows,
    systemManualRows,
  ] = await Promise.all([
    service.prisma.user.count({
      where: {
        status: 1,
      },
    }),
    service.prisma.shelf.count(),
    service.prisma.box.count(),
    service.prisma.batchInboundOrder.count({
      where: {
        status: {
          in: [BatchInboundOrderStatus.waiting_upload, BatchInboundOrderStatus.waiting_inbound],
        },
      },
    }),
    service.prisma.masterProduct.count(),
    service.prisma.masterProduct.findMany({
      where: { status: 1 },
      select: {
        productId: true,
        productName: true,
        stockQty: true,
        firstStockedAt: true,
      },
    }),
    service.prisma.sku.findMany({
      where: {
        status: 1,
        productId: {
          not: null,
        },
      },
      select: {
        id: true,
        sku: true,
        rbSku: true,
        fbmSku: true,
        productId: true,
      },
    }),
    service.prisma.fbaReplenishment.findMany({
      where: {
        status: { in: ['pending_confirm', 'pending_outbound'] },
      },
      select: {
        status: true,
        requestedQty: true,
        actualQty: true,
        sku: {
          select: {
            productId: true,
          },
        },
      },
    }),
    service.prisma.batchInboundItem.groupBy({
      by: ['productId'],
      where: {
        status: 'pending',
        order: {
          status: BatchInboundOrderStatus.waiting_inbound,
        },
      },
      _sum: { qty: true },
    }),
    service.prisma.batchInboundItem.groupBy({
      by: ['productId'],
      where: {
        status: 'pending',
        order: {
          status: BatchInboundOrderStatus.waiting_upload,
        },
      },
      _sum: { qty: true },
    }),
    includeFba && fbaSnapshotId
      ? service.prisma.fbaSalesSnapshot.findUnique({
          where: { id: fbaSnapshotId },
          include: {
            items: {
              where: { channel: 'fba', productId: { not: null } },
              select: { productId: true, orderedQty: true },
            },
          },
        })
      : Promise.resolve(null),
    service.prisma.rakutenOrderRecord.findMany({
      where: rakutenShipmentOrderFilter,
      orderBy: { shipmentNoRegisteredAt: 'desc' },
      select: {
        id: true,
        orderId: true,
        skuCode: true,
        setComponentSkuCode: true,
        orderQuantity: true,
        shipmentNoRegisteredAt: true,
      },
    }),
    service.prisma.amazonOrderRecord.findMany({
      where: amazonShipmentOrderFilter,
      orderBy: { shipmentNoRegisteredAt: 'desc' },
      select: {
        id: true,
        orderId: true,
        sku: true,
        rawPayload: true,
        quantityPurchased: true,
        shipmentNoRegisteredAt: true,
      },
    }),
    (service.prisma as any).manualOrderRecord.findMany({
      where: manualShipmentOrderFilter,
      orderBy: { shipmentNoRegisteredAt: 'desc' },
      select: {
        id: true,
        orderId: true,
        sku: true,
        rawPayload: true,
        quantityPurchased: true,
        shipmentNoRegisteredAt: true,
      },
    }),
  ]);

  if (includeFba && !latestFbaSalesSnapshot) {
    throw new BadRequestException('指定的FBA销量快照不存在，请重新上传90天CSV');
  }

  const productById = new Map<
    string,
    { productId: string; productName: string | null; stockQty: number; firstStockedAt: Date | null }
  >();
  const activeProductIdSet = new Set<string>();
  activeProducts.forEach((item) => {
    const productId = String(item.productId || '').trim();
    if (!productId) return;
    const product = {
      productId,
      productName: item.productName ?? null,
      stockQty: Number(item.stockQty ?? 0),
      firstStockedAt: item.firstStockedAt ?? null,
    };
    productById.set(productId, product);
    activeProductIdSet.add(productId);
  });

  const skuCodeToProductIds = new Map<string, Set<string>>();
  activeSkus.forEach((item) => {
    const productId = String(item.productId || '').trim();
    if (!productId) return;
    [item.sku, item.rbSku, item.fbmSku].forEach((candidate) => {
      const skuCode = String(candidate || '').trim();
      if (!skuCode) return;
      if (!skuCodeToProductIds.has(skuCode)) skuCodeToProductIds.set(skuCode, new Set());
      skuCodeToProductIds.get(skuCode)!.add(productId);
    });
  });
  const resolveUniqueProductIdBySkuCode = (skuCodeRaw: unknown): string | null => {
    const skuCode = String(skuCodeRaw ?? '').trim();
    const productIds = skuCode ? skuCodeToProductIds.get(skuCode) : undefined;
    return productIds?.size === 1 ? [...productIds][0] : null;
  };

  const lockedByProduct = new Map<string, number>();
  pendingRows.forEach((row) => {
    const productId = String(row.sku?.productId || '').trim();
    if (!productId) return;
    const qty = Number(
      row.status === 'pending_outbound' ? row.actualQty ?? row.requestedQty : row.requestedQty,
    );
    if (qty <= 0) return;
    lockedByProduct.set(productId, (lockedByProduct.get(productId) ?? 0) + qty);
  });

  const inTransitByProduct = new Map<string, number>();
  inTransitRows.forEach((row) => {
    const rawCode = String(row.productId || '').trim();
    const productId = activeProductIdSet.has(rawCode) ? rawCode : resolveUniqueProductIdBySkuCode(rawCode);
    if (!productId) return;
    const qty = Number(row._sum?.qty ?? 0);
    if (qty <= 0) return;
    inTransitByProduct.set(productId, (inTransitByProduct.get(productId) ?? 0) + qty);
  });

  const arrangedProductionByProduct = new Map<string, number>();
  arrangedProductionRows.forEach((row) => {
    const rawCode = String(row.productId || '').trim();
    const productId = activeProductIdSet.has(rawCode) ? rawCode : resolveUniqueProductIdBySkuCode(rawCode);
    if (!productId) return;
    const qty = Number(row._sum?.qty ?? 0);
    if (qty <= 0) return;
    arrangedProductionByProduct.set(productId, (arrangedProductionByProduct.get(productId) ?? 0) + qty);
  });

  const outbound30ByProduct = new Map<string, number>();
  const outbound14ByProduct = new Map<string, number>();
  const outbound7ByProduct = new Map<string, number>();
  const outbound90ByProduct = new Map<string, number>();

  const resolveAmazonLikeDemandProductId = (row: { sku: string | null; rawPayload: Prisma.JsonValue | null }): string | null => {
    const productIdOverride = getJsonObjectString(row.rawPayload, '产品ID');
    if (productIdOverride && activeProductIdSet.has(productIdOverride)) {
      return productIdOverride;
    }
    const skuCode = String(row.sku ?? '').trim();
    return resolveUniqueProductIdBySkuCode(skuCode);
  };
  const addDemandQty = (map: Map<string, number>, productId: string, qty: number): boolean => {
    if (!productId || qty <= 0 || !activeProductIdSet.has(productId)) return false;
    map.set(productId, (map.get(productId) ?? 0) + qty);
    return true;
  };
  const addSystemOrderDemandQty = (
    productId: string | null,
    qtyRaw: number | null,
    registeredAt: Date | null,
  ): boolean => {
    const productIdText = String(productId ?? '').trim();
    const qty = Number(qtyRaw ?? 0);
    if (
      !productIdText ||
      !activeProductIdSet.has(productIdText) ||
      !registeredAt ||
      !Number.isFinite(qty) ||
      qty <= 0
    ) {
      return false;
    }
    if (registeredAt >= from90d) addDemandQty(outbound90ByProduct, productIdText, qty);
    if (registeredAt >= from30d) addDemandQty(outbound30ByProduct, productIdText, qty);
    if (registeredAt >= from14d) addDemandQty(outbound14ByProduct, productIdText, qty);
    if (registeredAt >= from7d) addDemandQty(outbound7ByProduct, productIdText, qty);
    return true;
  };

  const unmatchedSystemOrders90d = {
    rowCount: 0,
    quantity: 0,
    rakutenRowCount: 0,
    amazonRowCount: 0,
    manualRowCount: 0,
    details: [] as Array<{
      channel: 'rakuten' | 'amazon' | 'manual';
      orderId: string | null;
      skuCode: string | null;
      quantity: number;
      registeredAt: string;
      reason: string;
    }>,
  };
  const describeDemandMatchFailure = (skuCodeRaw: unknown, productIdOverride?: string | null): string => {
    const skuCode = String(skuCodeRaw ?? '').trim();
    const override = String(productIdOverride ?? '').trim();
    const overrideInvalid = Boolean(override && !activeProductIdSet.has(override));
    if (!skuCode) {
      return overrideInvalid ? '订单产品ID无效，且SKU为空' : '订单SKU为空';
    }
    const productIds = skuCodeToProductIds.get(skuCode);
    if (!productIds?.size) {
      return overrideInvalid ? '订单产品ID无效，且SKU未维护产品关联' : 'SKU未维护产品关联';
    }
    if (productIds.size > 1) return 'SKU对应多个产品，无法唯一匹配';
    const productId = [...productIds][0];
    if (!activeProductIdSet.has(productId)) return 'SKU关联的产品已停用';
    return '无法匹配产品';
  };
  const recordUnmatchedSystemOrder = (
    item: {
      channel: 'rakuten' | 'amazon' | 'manual';
      orderId: string | null;
      skuCode: string | null;
      qtyRaw: number | null;
      registeredAt: Date | null;
      reason: string;
    },
  ) => {
    const qty = Number(item.qtyRaw ?? 0);
    if (!item.registeredAt || item.registeredAt < from90d || !Number.isFinite(qty) || qty <= 0) return;
    unmatchedSystemOrders90d.rowCount += 1;
    unmatchedSystemOrders90d.quantity += qty;
    unmatchedSystemOrders90d[`${item.channel}RowCount`] += 1;
    unmatchedSystemOrders90d.details.push({
      channel: item.channel,
      orderId: item.orderId,
      skuCode: item.skuCode,
      quantity: qty,
      registeredAt: item.registeredAt.toISOString(),
      reason: item.reason,
    });
  };

  systemRakutenRows.forEach((row) => {
    const rawCode = String(row.setComponentSkuCode ?? '').trim() || String(row.skuCode ?? '').trim();
    const productId = activeProductIdSet.has(rawCode) ? rawCode : resolveUniqueProductIdBySkuCode(rawCode);
    if (!addSystemOrderDemandQty(productId, row.orderQuantity, row.shipmentNoRegisteredAt)) {
      recordUnmatchedSystemOrder({
        channel: 'rakuten',
        orderId: row.orderId,
        skuCode: rawCode || null,
        qtyRaw: row.orderQuantity,
        registeredAt: row.shipmentNoRegisteredAt,
        reason: describeDemandMatchFailure(rawCode),
      });
    }
  });
  systemAmazonRows.forEach((row) => {
    const productId = resolveAmazonLikeDemandProductId(row);
    if (!addSystemOrderDemandQty(productId, row.quantityPurchased, row.shipmentNoRegisteredAt)) {
      const productIdOverride = getJsonObjectString(row.rawPayload, '产品ID');
      recordUnmatchedSystemOrder({
        channel: 'amazon',
        orderId: row.orderId,
        skuCode: String(row.sku ?? '').trim() || null,
        qtyRaw: row.quantityPurchased,
        registeredAt: row.shipmentNoRegisteredAt,
        reason: describeDemandMatchFailure(row.sku, productIdOverride),
      });
    }
  });
  (systemManualRows as Array<{ id: bigint; orderId: string | null; sku: string | null; rawPayload: Prisma.JsonValue | null; quantityPurchased: number | null; shipmentNoRegisteredAt: Date | null }>).forEach((row) => {
    const productId = resolveAmazonLikeDemandProductId(row);
    if (!addSystemOrderDemandQty(productId, row.quantityPurchased, row.shipmentNoRegisteredAt)) {
      const productIdOverride = getJsonObjectString(row.rawPayload, '产品ID');
      recordUnmatchedSystemOrder({
        channel: 'manual',
        orderId: row.orderId,
        skuCode: String(row.sku ?? '').trim() || null,
        qtyRaw: row.quantityPurchased,
        registeredAt: row.shipmentNoRegisteredAt,
        reason: describeDemandMatchFailure(row.sku, productIdOverride),
      });
    }
  });
  unmatchedSystemOrders90d.details.sort(
    (a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime(),
  );
  unmatchedSystemOrders90d.details.splice(200);

  const systemOrder90ByProduct = new Map(outbound90ByProduct);
  const fbaSales90ByProduct = new Map<string, number>();
  (latestFbaSalesSnapshot?.items ?? []).forEach((row) => {
    const productId = String(row.productId ?? '').trim();
    const qty = Number(row.orderedQty ?? 0);
    if (!productId || !Number.isFinite(qty) || qty <= 0) return;
    addDemandQty(fbaSales90ByProduct, productId, qty);
    addDemandQty(outbound90ByProduct, productId, qty);
  });

  let totalStock = 0;
  let availableStock = 0;
  let lockedStock = 0;
  let inTransitStock = 0;
  let arrangedProductionStock = 0;

  const recommendations: Array<{
    productId: string;
    productName: string | null;
    totalStock: number;
    availableStock: number;
    lockedStock: number;
    inTransitStock: number;
    arrangedProductionQty: number;
    securedStock: number;
    outbound30d: number;
    systemOrderQty90d: number;
    fbaOrderedQty90d: number;
    totalOrderQty90d: number;
    avgDailyOutbound90d: number;
    stockCoverageDays: number;
    securedCoverageDays: number;
    targetDemandQty: number;
    suggestedProductionQty: number;
    shortageDays: number;
    estimatedArrivalDays: number;
    demandSpike: boolean;
    fluctuationQty: number;
    priority: string;
  }> = [];
  const noSales90dSkus: Array<{
    productId: string;
    productName: string | null;
    totalStock: number;
    availableStock: number;
    inTransitStock: number;
    firstStockedAt: string | null;
    observedDays: number | null;
  }> = [];

  activeProducts.forEach((rawProduct) => {
    const productId = String(rawProduct.productId || '').trim();
    if (!productId) return;

    const stock = Number(rawProduct.stockQty ?? 0);
    const locked = lockedByProduct.get(productId) ?? 0;
    const available = stock - locked;
    const inTransit = inTransitByProduct.get(productId) ?? 0;
    const arrangedProductionQty = arrangedProductionByProduct.get(productId) ?? 0;
    const securedStock = Math.max(0, available) + inTransit + arrangedProductionQty;
    const outbound30 = outbound30ByProduct.get(productId) ?? 0;
    const outbound90 = outbound90ByProduct.get(productId) ?? 0;
    const systemOrderQty90d = systemOrder90ByProduct.get(productId) ?? 0;
    const fbaOrderedQty90d = fbaSales90ByProduct.get(productId) ?? 0;
    const avgDailyOutbound90d = outbound90 / 90;
    const stockCoverageDays =
      avgDailyOutbound90d > 0 ? Math.max(0, available) / avgDailyOutbound90d : Number.POSITIVE_INFINITY;
    const securedCoverageDays =
      avgDailyOutbound90d > 0 ? securedStock / avgDailyOutbound90d : Number.POSITIVE_INFINITY;

    totalStock += stock;
    availableStock += available;
    lockedStock += locked;
    inTransitStock += inTransit;
    arrangedProductionStock += arrangedProductionQty;

    if (!latestFbaSalesSnapshot) return;

    if (stock > 0 && !(outbound90ByProduct.get(productId) ?? 0)) {
      const stockAge = classifyNoSalesInventoryAge(rawProduct.firstStockedAt, now);
      if (stockAge.status === 'obsolete') {
        noSales90dSkus.push({
          productId,
          productName: rawProduct.productName ?? null,
          totalStock: stock,
          availableStock: available,
          inTransitStock: inTransit,
          firstStockedAt: rawProduct.firstStockedAt!.toISOString(),
          observedDays: stockAge.observedDays!,
        });
      } else if (stockAge.status === 'unknown') {
        noSales90dSkus.push({
          productId,
          productName: rawProduct.productName ?? null,
          totalStock: stock,
          availableStock: available,
          inTransitStock: inTransit,
          firstStockedAt: null,
          observedDays: null,
        });
      }
    }

    const targetDemandQty = Math.ceil(avgDailyOutbound90d * PRODUCTION_TARGET_DAYS);
    const suggestedProductionQty = Math.max(0, targetDemandQty - securedStock);
    const shortageDays = Math.max(0, PRODUCTION_TARGET_DAYS - securedCoverageDays);
    const qty14d = outbound14ByProduct.get(productId) ?? outbound7ByProduct.get(productId) ?? 0;
    const recent7d = outbound7ByProduct.get(productId) ?? 0;
    const prev7d = Math.max(0, qty14d - recent7d);
    const fluctuationQty = recent7d - prev7d;
    const demandSpike = fluctuationQty >= ANOMALY_MIN_DELTA_QTY;
    if (suggestedProductionQty <= 0 && securedCoverageDays >= PRODUCTION_TARGET_DAYS && !demandSpike) {
      return;
    }

    let priority = '正常';
    if (stockCoverageDays < URGENT_STOCK_COVERAGE_DAYS || available <= 0) {
      priority = '紧急';
    } else if (securedCoverageDays < HIGH_TOTAL_COVERAGE_DAYS) {
      priority = '高';
    } else if (securedCoverageDays < MEDIUM_TOTAL_COVERAGE_DAYS) {
      priority = '中';
    }
    if (demandSpike) {
      priority = raiseProductionPriority(priority);
    }

    recommendations.push({
      productId,
      productName: rawProduct.productName ?? null,
      totalStock: stock,
      availableStock: available,
      lockedStock: locked,
      inTransitStock: inTransit,
      arrangedProductionQty,
      securedStock,
      outbound30d: outbound30,
      systemOrderQty90d,
      fbaOrderedQty90d,
      totalOrderQty90d: outbound90,
      avgDailyOutbound90d,
      stockCoverageDays,
      securedCoverageDays,
      targetDemandQty,
      suggestedProductionQty,
      shortageDays,
      estimatedArrivalDays: ESTIMATED_PRODUCTION_ARRIVAL_DAYS,
      demandSpike,
      fluctuationQty,
      priority,
    });
  });

  const priorityWeight: Record<string, number> = { 紧急: 4, 高: 3, 中: 2, 正常: 1 };
  recommendations.sort((a, b) => {
    const p = (priorityWeight[b.priority] ?? 0) - (priorityWeight[a.priority] ?? 0);
    if (p !== 0) return p;
    const s = b.suggestedProductionQty - a.suggestedProductionQty;
    if (s !== 0) return s;
    return b.avgDailyOutbound90d - a.avgDailyOutbound90d;
  });

  const sortByStockDesc = <T extends { totalStock: number; availableStock: number; productId: string }>(
    rows: T[],
  ) => {
    rows.sort((a, b) => {
      if (b.totalStock !== a.totalStock) return b.totalStock - a.totalStock;
      if (b.availableStock !== a.availableStock) return b.availableStock - a.availableStock;
      return String(a.productId || '').localeCompare(String(b.productId || ''), 'en', { numeric: true });
    });
  };
  sortByStockDesc(noSales90dSkus);

  const topSkus = Array.from(outbound90ByProduct.entries())
    .map(([productId, totalOrderQty90d]) => {
      const product = productById.get(productId);
      const systemOrderQty90d = systemOrder90ByProduct.get(productId) ?? 0;
      const fbaOrderedQty90d = fbaSales90ByProduct.get(productId) ?? 0;
      const totalStock = Number(product?.stockQty ?? 0);
      const avgDailyOutbound = totalOrderQty90d / 90;
      return {
        productId,
        productName: product?.productName ?? null,
        totalStock,
        systemOrderQty90d,
        fbaOrderedQty90d,
        totalOrderQty90d,
        avgDailyOutbound,
        stockCoverageDays: avgDailyOutbound > 0 ? totalStock / avgDailyOutbound : null,
      };
    })
    .sort((a, b) => b.totalOrderQty90d - a.totalOrderQty90d)
    .slice(0, 10);

  const anomalySkus = Array.from(outbound7ByProduct.entries())
    .map(([productId, qty7d]) => {
      const qty14d = outbound14ByProduct.get(productId) ?? qty7d;
      const prev7d = Math.max(0, qty14d - qty7d);
      const ratio = prev7d > 0 ? qty7d / prev7d : null;
      const delta = qty7d - prev7d;
      return { productId, qty7d, prev7d, ratio, delta };
    })
    .filter((item) => Math.abs(item.delta) >= ANOMALY_MIN_DELTA_QTY)
    .map((item) => {
      const product = productById.get(item.productId);
      return {
        productId: item.productId,
        productName: product?.productName ?? null,
        totalStock: Number(product?.stockQty ?? 0),
        qty7d: item.qty7d,
        prev7d: item.prev7d,
        ratio: item.ratio,
        delta: item.delta,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 10);

  const outboundQty30d = Array.from(outbound30ByProduct.values()).reduce((sum, qty) => sum + qty, 0);
  const outboundQty14d = Array.from(outbound14ByProduct.values()).reduce((sum, qty) => sum + qty, 0);
  const outboundQty7d = Array.from(outbound7ByProduct.values()).reduce((sum, qty) => sum + qty, 0);
  const outboundQty90d = Array.from(outbound90ByProduct.values()).reduce((sum, qty) => sum + qty, 0);
  const systemOrderQty90d = Array.from(systemOrder90ByProduct.values()).reduce((sum, qty) => sum + qty, 0);
  const fbaOrderedQty90d = Array.from(fbaSales90ByProduct.values()).reduce((sum, qty) => sum + qty, 0);
  const avgDailyOutbound30d = outboundQty30d / 30;
  const avgDailyOutbound90d = outboundQty90d / 90;
  const securedStock = Math.max(0, availableStock) + inTransitStock + arrangedProductionStock;

  const urgentCount = recommendations.filter((item) => item.priority === '紧急').length;
  const highCount = recommendations.filter((item) => item.priority === '高').length;
  const mediumCount = recommendations.filter((item) => item.priority === '中').length;
  const toOrderStats = (
    rows: Array<{ id: bigint; orderId: string | null; qty: number | null }>,
  ): { orderCount: number; itemRowCount: number; quantity: number } => {
    const orderKeys = new Set<string>();
    let quantity = 0;
    rows.forEach((row) => {
      const orderId = String(row.orderId ?? '').trim();
      orderKeys.add(orderId || `row:${row.id.toString()}`);
      const qty = Number(row.qty ?? 0);
      if (Number.isFinite(qty) && qty > 0) {
        quantity += qty;
      }
    });
    return {
      orderCount: orderKeys.size,
      itemRowCount: rows.length,
      quantity,
    };
  };
  const rakutenOrderStats30d = toOrderStats(
    systemRakutenRows.filter((row) => row.shipmentNoRegisteredAt && row.shipmentNoRegisteredAt >= from30d).map((row) => ({
      id: row.id,
      orderId: row.orderId,
      qty: row.orderQuantity,
    })),
  );
  const amazonOrderStats30d = toOrderStats(
    systemAmazonRows.filter((row) => row.shipmentNoRegisteredAt && row.shipmentNoRegisteredAt >= from30d).map((row) => ({
      id: row.id,
      orderId: row.orderId,
      qty: row.quantityPurchased,
    })),
  );
  const manualOrderStats30d = toOrderStats(
    (systemManualRows as Array<{ id: bigint; orderId: string | null; quantityPurchased: number | null; shipmentNoRegisteredAt: Date | null }>).filter((row) => row.shipmentNoRegisteredAt && row.shipmentNoRegisteredAt >= from30d).map(
      (row) => ({
        id: row.id,
        orderId: row.orderId,
        qty: row.quantityPurchased,
      }),
    ),
  );

  return {
    generatedAt: now.toISOString(),
    summary: {
      activeUserCount,
      masterProductCount,
      shelfCount,
      boxCount,
      pendingInboundOrderCount,
    },
    health: {
      activeProductCount: activeProducts.length,
      totalStock,
      availableStock,
      lockedStock,
      inTransitStock,
      arrangedProductionStock,
      securedStock,
    },
    demand: {
      outboundQty7d,
      outboundQty14d,
      outboundQty30d,
      outboundQty90d,
      systemOrderQty90d,
      fbaOrderedQty90d,
      unmatchedSystemOrderRowCount90d: unmatchedSystemOrders90d.rowCount,
      unmatchedSystemOrderQty90d: unmatchedSystemOrders90d.quantity,
      unmatchedSystemOrders90d,
      avgDailyOutbound: avgDailyOutbound90d,
      avgDailyOutbound30d,
      avgDailyOutbound90d,
      topSkus,
      anomalySkus,
    },
    orders30d: {
      totalOrderCount:
        rakutenOrderStats30d.orderCount + amazonOrderStats30d.orderCount + manualOrderStats30d.orderCount,
      totalItemRowCount:
        rakutenOrderStats30d.itemRowCount + amazonOrderStats30d.itemRowCount + manualOrderStats30d.itemRowCount,
      totalQuantity: rakutenOrderStats30d.quantity + amazonOrderStats30d.quantity + manualOrderStats30d.quantity,
      rakutenOrderCount: rakutenOrderStats30d.orderCount,
      amazonOrderCount: amazonOrderStats30d.orderCount,
      manualOrderCount: manualOrderStats30d.orderCount,
    },
    production: {
      includesFba: Boolean(latestFbaSalesSnapshot),
      requiresFbaUpload: !latestFbaSalesSnapshot,
      targetDays: PRODUCTION_TARGET_DAYS,
      estimatedArrivalDays: ESTIMATED_PRODUCTION_ARRIVAL_DAYS,
      recommendationCount: recommendations.length,
      urgentCount,
      highCount,
      mediumCount,
      fbaSalesSnapshot: latestFbaSalesSnapshot
        ? {
            id: latestFbaSalesSnapshot.id.toString(),
            fileName: latestFbaSalesSnapshot.fileName,
            periodDays: latestFbaSalesSnapshot.periodDays,
            periodStart: latestFbaSalesSnapshot.periodStart?.toISOString().slice(0, 10) ?? null,
            periodEnd: latestFbaSalesSnapshot.periodEnd?.toISOString().slice(0, 10) ?? null,
            totalRows: latestFbaSalesSnapshot.totalRows,
            fbaRows: latestFbaSalesSnapshot.fbaRows,
            fbmRows: latestFbaSalesSnapshot.fbmRows,
            unmatchedRows: latestFbaSalesSnapshot.unmatchedRows,
            ambiguousRows: latestFbaSalesSnapshot.ambiguousRows,
            fbaOrderedQty: latestFbaSalesSnapshot.fbaOrderedQty,
            importedAt: latestFbaSalesSnapshot.createdAt.toISOString(),
          }
        : null,
      recommendations,
    },
    obsolete: {
      noSales90dCount: noSales90dSkus.length,
      noSales90dSkus: noSales90dSkus.slice(0, 100),
    },
  };
};

async function searchSkusByProduct(
  this: InventoryService,
  keyword?: string,
  page = 1,
  pageSize = 10,
): Promise<unknown[]> {
  if (!keyword?.trim()) return [];
  const key = keyword.trim();
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const safePageSizeRaw = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 10;
  const safePageSize = Math.min(50, safePageSizeRaw);
  const offset = (safePage - 1) * safePageSize;

  const rows = await this.prisma.sku.findMany({
    where: {
      status: 1,
      OR: [
        { productId: { equals: key } },
        { sku: { equals: key } },
        { asin: { equals: key } },
        { fnsku: { equals: key } },
        { fbmSku: { equals: key } },
        { rbSku: { equals: key } },
        { productId: { contains: key } },
        { sku: { contains: key } },
        { asin: { contains: key } },
        { fnsku: { contains: key } },
        { fbmSku: { contains: key } },
        { rbSku: { contains: key } },
        { shop: { contains: key } },
        { remark: { contains: key } },
        {
          masterProduct: {
            is: {
              OR: [
                { productName: { contains: key } },
                { productType: { contains: key } },
                { bagBrand: { contains: key } },
                { color: { contains: key } },
              ],
            },
          },
        },
      ],
    },
    include: {
      masterProduct: {
        select: {
          productName: true,
          stockQty: true,
        },
      },
    },
    skip: offset,
    take: safePageSize,
    orderBy: { id: 'desc' },
  });

  return rows.map((row) => ({
    ...row,
    productName: row.masterProduct?.productName ?? null,
    stockQty: Number(row.masterProduct?.stockQty ?? 0),
  }));
};

async function productBoxesByProduct(
  this: InventoryService,
  skuId: number,
): Promise<unknown[]> {
  const sku = await this.prisma.sku.findFirst({
    where: {
      id: BigInt(skuId),
      status: 1,
    },
    select: { productId: true },
  });
  const productId = String(sku?.productId || '').trim();
  if (!productId) {
    return [];
  }

  return getMasterProductBoxRowsByProductId.call(this, productId);
};

async function getMasterProductBoxRowsByProductId(
  this: InventoryService,
  productIdRaw: string,
): Promise<unknown[]> {
  const productId = String(productIdRaw || '').trim();
  if (!productId) {
    throw new BadRequestException('productId不能为空');
  }

  return this.prisma.masterProductBoxInventory.findMany({
    where: {
      productId,
      qty: { gt: 0 },
    },
    include: buildMasterProductBoxInventoryInclude(MASTER_PRODUCT_BOX_PRODUCT_WITH_STOCK_SELECT),
    orderBy: {
      boxId: 'asc',
    },
  });
};

function getBoxProductInventoryKey(boxId: bigint, productId: string): string {
  return `${boxId.toString()}-${productId}`;
}

function buildMasterProductBoxInventoryWhereUnique(
  boxId: bigint,
  productId: string,
): Prisma.MasterProductBoxInventoryWhereUniqueInput {
  return {
    boxId_productId: {
      boxId,
      productId,
    },
  };
}

function buildMasterProductBoxInventoryInclude(
  productSelect: Prisma.MasterProductSelect,
): Prisma.MasterProductBoxInventoryInclude {
  return {
    box: {
      include: {
        shelf: {
          select: MASTER_PRODUCT_BOX_SHELF_SELECT,
        },
      },
    },
    product: {
      select: productSelect,
    },
  };
}

async function findMasterProductBoxInventoryQty(
  client: MasterProductBoxInventoryFindUniqueClient,
  boxId: bigint,
  productId: string,
): Promise<number> {
  const inventory = await client.masterProductBoxInventory.findUnique({
    where: buildMasterProductBoxInventoryWhereUnique(boxId, productId),
    select: { qty: true },
  });
  return Number(inventory?.qty ?? 0);
}

async function upsertMasterProductBoxInventoryQty(
  client: MasterProductBoxInventoryUpsertClient,
  boxId: bigint,
  productId: string,
  qty: number,
): Promise<void> {
  await client.masterProductBoxInventory.upsert({
    where: buildMasterProductBoxInventoryWhereUnique(boxId, productId),
    update: {
      qty,
    },
    create: {
      boxId,
      productId,
      qty,
    },
  });
}

async function updateMasterProductBoxInventoryQty(
  client: MasterProductBoxInventoryUpdateClient,
  boxId: bigint,
  productId: string,
  qty: number,
): Promise<void> {
  await client.masterProductBoxInventory.update({
    where: buildMasterProductBoxInventoryWhereUnique(boxId, productId),
    data: {
      qty,
    },
  });
}

async function createMasterProductInventoryAdjustAudit({
  auditService,
  tx,
  entityId,
  beforeData,
  afterData,
  operatorId,
  requestId,
  remark,
}: MasterProductInventoryAdjustAuditArgs): Promise<void> {
  await auditService.create({
    db: tx,
    entityType: 'master_product',
    entityId,
    action: AuditAction.update,
    eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED,
    beforeData,
    afterData,
    operatorId,
    requestId,
    remark,
  });
}

async function createFbaReplenishmentInventoryAdjustAudit({
  auditService,
  tx,
  entityId,
  beforeData,
  afterData,
  operatorId,
  requestId,
  remark,
}: FixedInventoryAdjustAuditArgs): Promise<void> {
  await auditService.create({
    db: tx,
    entityType: 'fba_replenishment',
    entityId,
    action: AuditAction.update,
    eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED,
    beforeData,
    afterData,
    operatorId,
    requestId,
    remark,
  });
}

async function createInventoryAdjustOrderConfirmedAudit({
  auditService,
  tx,
  entityId,
  beforeData,
  afterData,
  operatorId,
  requestId,
  remark,
}: FixedInventoryAdjustAuditArgs): Promise<void> {
  await auditService.create({
    db: tx,
    entityType: 'inventory_adjust_order',
    entityId,
    action: AuditAction.update,
    eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED,
    beforeData,
    afterData,
    operatorId,
    requestId,
    remark,
  });
}

async function createInventoryAdjustOrderCreatedAudit({
  auditService,
  tx,
  entityId,
  afterData,
  operatorId,
  requestId,
  remark,
}: FixedInventoryAdjustCreatedAuditArgs): Promise<void> {
  await auditService.create({
    db: tx,
    entityType: 'inventory_adjust_order',
    entityId,
    action: AuditAction.create,
    eventType: AuditEventType.INVENTORY_ADJUST_CREATED,
    beforeData: null,
    afterData,
    operatorId,
    requestId,
    remark,
  });
}

async function createFbaReplenishmentCreatedAudit({
  auditService,
  tx,
  entityId,
  afterData,
  operatorId,
  requestId,
  remark,
}: FixedInventoryAdjustCreatedAuditArgs): Promise<void> {
  await auditService.create({
    db: tx,
    entityType: 'fba_replenishment',
    entityId,
    action: AuditAction.create,
    eventType: AuditEventType.INVENTORY_ADJUST_CREATED,
    beforeData: null,
    afterData,
    operatorId,
    requestId,
    remark,
  });
}

async function createBoxInventoryAudit({
  auditService,
  tx,
  entityId,
  eventType,
  beforeData,
  afterData,
  operatorId,
  requestId,
  remark,
}: BoxInventoryAuditArgs): Promise<void> {
  await auditService.create({
    db: tx,
    entityType: 'box',
    entityId,
    action: AuditAction.update,
    eventType,
    beforeData,
    afterData,
    operatorId,
    requestId,
    remark,
  });
}

async function findMasterProductBoxInventoryByPairs(
  client: MasterProductBoxInventoryFindManyClient,
  pairs: BoxProductInventoryPair[],
  args: Omit<Prisma.MasterProductBoxInventoryFindManyArgs, 'where'> = {},
): Promise<MasterProductBoxInventoryPairRow[]> {
  if (pairs.length === 0) {
    return [];
  }

  return client.masterProductBoxInventory.findMany({
    ...args,
    where: {
      OR: pairs.map((pair) => ({
        boxId: pair.boxId,
        productId: pair.productId,
      })),
    },
  });
}

async function manualAdjustByProduct(
  this: InventoryService,
  payload: ManualAdjustDto,
  operatorId: bigint,
  requestId?: string,
): Promise<AdjustOrderResult & { adjustNo: string }> {
  return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const sku =
      payload.skuId || payload.keyword
        ? await this.resolveSkuForManual(tx, payload)
        : null;
    const productId =
      String(payload.productId || '').trim() ||
      (sku
        ? String(
            (
              await tx.sku.findFirst({
                where: {
                  id: sku.id,
                  status: 1,
                },
                select: { productId: true },
              })
            )?.productId || '',
          ).trim()
        : '');

    if (!productId) {
      throw new BadRequestException('请输入主商品ID');
    }

    const product = await tx.masterProduct.findUnique({
      where: { productId },
      select: {
        id: true,
        productId: true,
        productName: true,
        stockQty: true,
      },
    });
    if (!product) {
      throw new NotFoundException('主商品ID不存在');
    }

    const box = await this.resolveBoxForManual(tx, payload);
    const qtyDelta = Math.trunc(Number(payload.qtyDelta));
    if (!Number.isInteger(qtyDelta) || qtyDelta === 0) {
      throw new BadRequestException('调整数量不能为 0');
    }

    const beforeQty = await findMasterProductBoxInventoryQty(tx, box.id, productId);
    const afterQty = beforeQty + qtyDelta;
    if (afterQty < 0) {
      throw new ConflictException(`当前箱号内主商品库存不足，调整前库存为 ${beforeQty}`);
    }

    const adjustOrder = await tx.inventoryAdjustOrder.create({
      data: {
        adjustNo: generateOrderNo('ADJ'),
        status: OrderStatus.confirmed,
        remark: payload.reason ?? 'manual-adjust',
        createdBy: operatorId,
      },
    });

    if (sku) {
      await tx.inventoryAdjustOrderItem.create({
        data: {
          orderId: adjustOrder.id,
          boxId: box.id,
          skuId: sku.id,
          qtyDelta,
          reason: payload.reason ?? null,
        },
      });

      await tx.stockMovement.create({
        data: {
          movementType: 'adjust',
          refType: 'inventory_adjust_order',
          refId: adjustOrder.id,
          boxId: box.id,
          productId,
          skuId: sku.id,
          qtyDelta,
          operatorId,
        },
      });
    }

    await upsertMasterProductBoxInventoryQty(tx, box.id, productId, afterQty);

    const totalQty = await this.recalculateMasterProductStockQty(tx, productId);

    await createInventoryAdjustOrderCreatedAudit({
      auditService: this.auditService,
      tx,
      entityId: adjustOrder.id,
      afterData: {
        adjustNo: adjustOrder.adjustNo,
        status: adjustOrder.status,
        productId,
        boxId: box.id.toString(),
        qtyDelta,
      },
      operatorId,
      requestId,
    });

    await createBoxInventoryAudit({
      auditService: this.auditService,
      tx,
      entityId: box.id,
      eventType:
        qtyDelta > 0 ? AuditEventType.BOX_STOCK_INCREASED : AuditEventType.BOX_STOCK_OUTBOUND,
      beforeData: {
        scope: 'master_product',
        productId,
        qty: beforeQty,
      },
      afterData: {
        scope: 'master_product',
        productId,
        qty: afterQty,
        qtyDelta,
      },
      operatorId,
      requestId,
      remark: payload.reason ?? 'manual-adjust',
    });

    await createMasterProductInventoryAdjustAudit({
      auditService: this.auditService,
      tx,
      entityId: product.id,
      beforeData: {
        productId,
        productName: product.productName,
        stockQty: Number(product.stockQty ?? 0),
      },
      afterData: {
        productId,
        productName: product.productName,
        stockQty: totalQty,
        boxCode: box.boxCode,
        qtyDelta,
      },
      operatorId,
      requestId,
      remark: payload.reason ?? 'manual-adjust',
    });

    return {
      orderId: adjustOrder.id.toString(),
      status: OrderStatus.confirmed,
      idempotent: false,
      changedRows: 1,
      adjustNo: adjustOrder.adjustNo,
    };
  });
};

async function createFbaReplenishmentByProduct(
  this: InventoryService,
  payload: CreateFbaReplenishmentDto,
  operatorId: bigint,
  requestId?: string,
): Promise<unknown> {
  const skuId = BigInt(payload.skuId);
  const boxCode = normalizeBoxCode(payload.boxCode);
  const requestedQty = Number(payload.qty);
  const remark = payload.remark?.trim() || FBA_REPLENISH_MARK;

  if (!boxCode) throw new BadRequestException('箱号不能为空');
  if (!Number.isInteger(requestedQty) || requestedQty <= 0) {
    throw new BadRequestException('申请数量必须是大于 0 的整数');
  }

  return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const [sku, box] = await Promise.all([
      tx.sku.findFirst({
        where: {
          id: skuId,
          status: 1,
        },
        select: {
          id: true,
          sku: true,
          fnsku: true,
          shop: true,
          productId: true,
          masterProduct: {
            select: {
              id: true,
              productId: true,
              productName: true,
              stockQty: true,
            },
          },
        },
      }),
      this.findBoxByEquivalentCode(tx, boxCode),
    ]);
    if (!sku) throw new NotFoundException('SKU 不存在');
    if (!box) throw new NotFoundException('箱号不存在');
    const productId = String(sku.productId || '').trim();
    if (!productId || !sku.masterProduct) {
      throw new ConflictException('该 SKU 未关联主商品');
    }
    if (!String(sku.fnsku ?? '').trim()) {
      throw new BadRequestException('该 SKU 未维护 FNSKU，不能申请 FBA 补货');
    }
    if (!String(sku.shop ?? '').trim()) {
      throw new BadRequestException('该 SKU 未维护店铺，不能申请 FBA 补货');
    }

    const currentQty = await findMasterProductBoxInventoryQty(tx, box.id, productId);
    if (currentQty <= 0) {
      throw new ConflictException('当前箱号没有该主商品库存，不能申请 FBA 补货');
    }

    const existingActiveSku = await tx.fbaReplenishment.findFirst({
      where: {
        skuId: sku.id,
        status: {
          in: ['pending_confirm', 'pending_outbound'],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        requestNo: true,
        status: true,
        boxId: true,
        requestedQty: true,
        actualQty: true,
      },
    });
    if (existingActiveSku) {
      if (existingActiveSku.boxId !== box.id) {
        throw new ConflictException('该 SKU 已在其他箱号存在 FBA 补货申请，请先处理现有申请');
      }
      const activeQty = this.getActiveFbaReservedQty(existingActiveSku);
      throw new ConflictException(
        `该 SKU 已有 FBA 申请 ${existingActiveSku.requestNo}，当前状态为 ${this.getFbaStatusLabel(existingActiveSku.status)}，占用数量 ${activeQty}`,
      );
    }

    const activeProductRows = await tx.fbaReplenishment.findMany({
      where: {
        boxId: box.id,
        status: {
          in: ['pending_confirm', 'pending_outbound'],
        },
        sku: {
          productId,
        },
      },
      select: {
        status: true,
        requestedQty: true,
        actualQty: true,
      },
    });
    const reservedQty = activeProductRows.reduce(
      (sum, row) => sum + this.getActiveFbaReservedQty(row),
      0,
    );
    const availableQty = currentQty - reservedQty;
    if (requestedQty > availableQty) {
      throw new ConflictException(`申请数量不能大于可用库存，当前可用库存为 ${availableQty}`);
    }

    const requestNo = await this.generateFbaRequestNo(tx);
    const created = await tx.fbaReplenishment.create({
      data: {
        requestNo,
        status: 'pending_confirm',
        skuId: sku.id,
        boxId: box.id,
        requestedQty,
        actualQty: null,
        remark,
        createdBy: operatorId,
      },
      include: {
        sku: {
          select: { id: true, sku: true, productId: true },
        },
        box: {
          select: {
            id: true,
            boxCode: true,
            shelf: { select: { shelfCode: true } },
          },
        },
        creator: { select: { id: true, username: true } },
      },
    });

    await createFbaReplenishmentCreatedAudit({
      auditService: this.auditService,
      tx,
      entityId: created.id,
      afterData: {
        requestNo: created.requestNo,
        status: created.status,
        skuId: created.skuId.toString(),
        productId,
        boxId: created.boxId.toString(),
        requestedQty: created.requestedQty,
      },
      operatorId,
      requestId,
    });

    return {
      id: created.id.toString(),
      requestNo: created.requestNo,
      status: created.status,
      sku: {
        id: created.sku.id.toString(),
        sku: created.sku.sku,
        productId: created.sku.productId,
        productName: sku.masterProduct.productName,
      },
      box: {
        id: created.box.id.toString(),
        boxCode: created.box.boxCode,
        shelfCode: created.box.shelf?.shelfCode ?? null,
      },
      requestedQty: created.requestedQty,
      actualQty: created.actualQty,
      expressNo: created.expressNo,
      remark: created.remark,
      creator: created.creator
        ? {
            id: created.creator.id.toString(),
            username: created.creator.username,
          }
        : null,
      createdAt: created.createdAt,
    };
  });
};

async function confirmFbaReplenishmentByProduct(
  this: InventoryService,
  idParam: string,
  payload: ConfirmFbaReplenishmentDto,
  operatorId: bigint,
  requestId?: string,
): Promise<unknown> {
  const id = parseId(idParam, 'fbaReplenishmentId');
  const actualQty = Number(payload.actualQty);
  if (!Number.isInteger(actualQty) || actualQty <= 0) {
    throw new BadRequestException('实际数量必须是大于 0 的整数');
  }

  return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const row = await tx.fbaReplenishment.findUnique({
      where: { id },
      include: {
        sku: {
          select: {
            id: true,
            sku: true,
            productId: true,
            masterProduct: {
              select: {
                productName: true,
              },
            },
          },
        },
        box: {
          select: {
            id: true,
            boxCode: true,
            shelf: { select: { shelfCode: true } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('FBA 补货申请不存在');
    if (row.status === 'outbound') {
      throw new UnprocessableEntityException('已出库的 FBA 补货申请不能修改确认数量');
    }
    if (String(row.status) === 'deleted') {
      throw new UnprocessableEntityException('已删除的 FBA 补货申请不能修改确认数量');
    }
    await this.ensureSkusNotUnderPendingEdit(tx, [row.sku.id]);

    const productId = String(row.sku.productId || '').trim();
    if (!productId) {
      throw new ConflictException('当前补货申请对应的 SKU 未关联主商品');
    }

    const [currentQty, reservedRows] = await Promise.all([
      findMasterProductBoxInventoryQty(tx, row.box.id, productId),
      tx.fbaReplenishment.findMany({
        where: {
          id: { not: row.id },
          boxId: row.box.id,
          status: { in: ['pending_confirm', 'pending_outbound'] },
          sku: { productId },
        },
        select: {
          status: true,
          requestedQty: true,
          actualQty: true,
        },
      }),
    ]);
    const reservedQty = reservedRows.reduce(
      (sum, item) => sum + this.getActiveFbaReservedQty(item),
      0,
    );
    const availableQty = Math.max(0, currentQty - reservedQty);
    if (actualQty > availableQty) {
      throw new ConflictException(`实际数量不能大于可用库存，当前可用库存为 ${availableQty}`);
    }

    const updated = await tx.fbaReplenishment.update({
      where: { id: row.id },
      data: {
        status: 'pending_outbound',
        actualQty,
        confirmedBy: operatorId,
        confirmedAt: new Date(),
      },
      include: {
        sku: {
          select: {
            id: true,
            sku: true,
            productId: true,
            masterProduct: {
              select: {
                productName: true,
              },
            },
          },
        },
        box: {
          select: {
            id: true,
            boxCode: true,
            shelf: { select: { shelfCode: true } },
          },
        },
        creator: { select: { id: true, username: true } },
      },
    });

    await createFbaReplenishmentInventoryAdjustAudit({
      auditService: this.auditService,
      tx,
      entityId: updated.id,
      beforeData: {
        status: row.status,
        requestedQty: row.requestedQty,
        actualQty: row.actualQty,
      },
      afterData: {
        status: updated.status,
        requestedQty: updated.requestedQty,
        actualQty: updated.actualQty,
      },
      operatorId,
      requestId,
    });

    return {
      id: updated.id.toString(),
      requestNo: updated.requestNo,
      status: updated.status,
      sku: {
        id: updated.sku.id.toString(),
        sku: updated.sku.sku,
        productId: updated.sku.productId,
        productName: updated.sku.masterProduct?.productName ?? null,
      },
      box: {
        id: updated.box.id.toString(),
        boxCode: updated.box.boxCode,
        shelfCode: updated.box.shelf?.shelfCode ?? null,
      },
      requestedQty: updated.requestedQty,
      actualQty: updated.actualQty,
      expressNo: updated.expressNo,
      remark: updated.remark,
      creator: updated.creator
        ? {
            id: updated.creator.id.toString(),
            username: updated.creator.username,
          }
        : null,
      createdAt: updated.createdAt,
    };
  });
};

async function outboundFbaReplenishmentsByProduct(
  this: InventoryService,
  payload: OutboundFbaReplenishmentDto,
  operatorId: bigint,
  requestId?: string,
): Promise<{ updatedCount: number; expressNo: string }> {
  const ids = Array.from(new Set((payload.ids || []).map((id) => BigInt(id))));
  const expressNo = payload.expressNo.trim();
  if (!ids.length) throw new BadRequestException('至少选择一条补货申请');
  if (!expressNo) throw new BadRequestException('快递单号不能为空');

  return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const rows = await tx.fbaReplenishment.findMany({
      where: { id: { in: ids } },
      include: {
        sku: {
          select: {
            id: true,
            productId: true,
            masterProduct: {
              select: {
                id: true,
                productId: true,
                stockQty: true,
              },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    if (rows.length !== ids.length) {
      throw new NotFoundException('存在未找到的 FBA 补货申请');
    }

    const invalid = rows.find((row) => row.status !== 'pending_outbound');
    if (invalid) {
      throw new ConflictException(`申请单 ${invalid.requestNo} 当前状态不支持出库`);
    }
    await this.ensureSkusNotUnderPendingEdit(
      tx,
      Array.from(new Set(rows.map((row) => row.skuId.toString()))).map((id) => BigInt(id)),
    );

    const requiredMap = new Map<string, { boxId: bigint; productId: string; qty: number }>();
    rows.forEach((row) => {
      const productId = String(row.sku.productId || '').trim();
      if (!productId) {
        throw new ConflictException(`申请单 ${row.requestNo} 对应 SKU 未关联主商品`);
      }
      const qty = Number(row.actualQty ?? row.requestedQty);
      const key = `${row.boxId.toString()}-${productId}`;
      const prev = requiredMap.get(key);
      if (prev) {
        prev.qty += qty;
      } else {
        requiredMap.set(key, {
          boxId: row.boxId,
          productId,
          qty,
        });
      }
    });

    const requiredRows = Array.from(requiredMap.values());
    const inventoryRows = await findMasterProductBoxInventoryByPairs(tx, requiredRows);
    const inventoryMap = new Map(
      inventoryRows.map((row) => [getBoxProductInventoryKey(row.boxId, row.productId), row]),
    );

    for (const reqRow of requiredRows) {
      const key = getBoxProductInventoryKey(reqRow.boxId, reqRow.productId);
      const inventory = inventoryMap.get(key);
      const currentQty = Number(inventory?.qty ?? 0);
      if (currentQty < reqRow.qty) {
        throw new ConflictException(
          `箱号 ${reqRow.boxId.toString()} 的产品 ${reqRow.productId} 库存不足，无法完成出库`,
        );
      }
    }

    for (const reqRow of requiredRows) {
      const key = getBoxProductInventoryKey(reqRow.boxId, reqRow.productId);
      const inventory = inventoryMap.get(key)!;
      await updateMasterProductBoxInventoryQty(
        tx,
        reqRow.boxId,
        reqRow.productId,
        Number(inventory.qty) - reqRow.qty,
      );
    }

    const affectedProductIds = Array.from(new Set(requiredRows.map((row) => row.productId)));
    const productRows = await tx.masterProduct.findMany({
      where: { productId: { in: affectedProductIds } },
      select: {
        id: true,
        productId: true,
        stockQty: true,
      },
    });
    const productById = new Map(productRows.map((row) => [row.productId, row]));
    for (const productId of affectedProductIds) {
      const product = productById.get(productId);
      if (!product) continue;
      const totalQty = await this.recalculateMasterProductStockQty(tx, productId);
      await createMasterProductInventoryAdjustAudit({
        auditService: this.auditService,
        tx,
        entityId: product.id,
        beforeData: {
          productId,
          stockQty: Number(product.stockQty ?? 0),
        },
        afterData: {
          productId,
          stockQty: totalQty,
          by: 'fba_replenishment',
          expressNo,
        },
        operatorId,
        requestId,
        remark: 'fba outbound',
      });
    }

    const outboundAt = new Date();
    for (const row of rows) {
      const qtyDelta = -(Number(row.actualQty ?? row.requestedQty));
      await tx.stockMovement.create({
        data: {
          movementType: 'adjust',
          refType: 'fba_replenishment',
          refId: row.id,
          boxId: row.boxId,
          productId: String(row.sku.productId || '').trim(),
          skuId: row.skuId,
          qtyDelta,
          operatorId,
        },
      });

      await createBoxInventoryAudit({
        auditService: this.auditService,
        tx,
        entityId: row.boxId,
        eventType: AuditEventType.BOX_STOCK_OUTBOUND,
        beforeData: null,
        afterData: {
          productId: row.sku.productId,
          skuId: row.skuId.toString(),
          qtyDelta,
          by: 'fba_replenishment',
          requestNo: row.requestNo,
        },
        operatorId,
        requestId,
        remark: `fba outbound ${row.requestNo}`,
      });

      await createFbaReplenishmentInventoryAdjustAudit({
        auditService: this.auditService,
        tx,
        entityId: row.id,
        beforeData: {
          status: row.status,
          actualQty: row.actualQty,
          expressNo: row.expressNo,
        },
        afterData: {
          status: 'outbound',
          actualQty: row.actualQty,
          expressNo,
        },
        operatorId,
        requestId,
      });
    }

    await tx.fbaReplenishment.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'outbound',
        outboundBy: operatorId,
        outboundAt,
        expressNo,
      },
    });

    return {
      updatedCount: rows.length,
      expressNo,
    };
  });
};

async function getSkuInventoryTotalsByProduct(this: InventoryService): Promise<Record<string, number>> {
  const rows = await this.prisma.sku.findMany({
    where: {
      status: 1,
    },
    select: {
      id: true,
      productId: true,
      masterProduct: {
        select: {
          stockQty: true,
        },
      },
    },
  });

  const totals: Record<string, number> = {};
  rows.forEach((row) => {
    totals[row.id.toString()] = Number(row.masterProduct?.stockQty ?? 0);
  });
  return totals;
};
