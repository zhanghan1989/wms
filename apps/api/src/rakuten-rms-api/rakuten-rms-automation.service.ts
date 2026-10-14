import { originalRakutenOrderId, rakutenOrderIdentityWhere } from '../common/rakuten-order-identity';
import { rakutenDeliveryCompanyCode } from '../common/rakuten-delivery-company';
import { createHash, randomUUID } from 'crypto';
import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import {
  Prisma,
  AuditAction,
  RakutenAutomationRunStatus,
  RakutenAutomationRunTrigger,
  RakutenAutomationStatus,
  RakutenOrderMailEvent,
  RakutenOrderRecord,
  RakutenRmsConnection,
} from '@prisma/client';
import { createTransport } from 'nodemailer';
import { parseId } from '../common/utils';
import { AuditLogPayload, AuditService } from '../audit/audit.service';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { RakutenRmsApiClient } from './rakuten-rms-api.client';
import { RakutenRmsApiCryptoService } from './rakuten-rms-api-crypto.service';
import { RakutenScheduleControlService } from './rakuten-schedule-control.service';
import { buildOrderWorkflow, hasRemovedOrderItems, fulfillmentOf, isChinaRow, validOrderQuantity, IGNORED_MAIL, VERIFIED_SHIPPING, shippingConditionReason, basketIdOf, japanWarehouseReady, mailEventReviewReason, mailOrderBlockReason, mailConditionReason, orderBlockReason, shippingSatisfied, shippingTargetRows, shippingTargetsReady, mailSatisfied, shippingFingerprint, trackingReady } from './rakuten-order-workflow';

export const RAKUTEN_ORDER_PROCESSING_CRON = process.env.RAKUTEN_RMS_AUTOMATION_CRON || '0 */20 * * * *';
const AUTOMATION_TIMEZONE = 'Asia/Tokyo';
const SCHEDULED_AUTOMATION_PAUSED =
  String(process.env.RAKUTEN_RMS_AUTOMATION_SCHEDULED_PAUSED ?? 'true').toLowerCase() !== 'false';
const SMTP_HOST = 'sub.fw.rakuten.ne.jp';
const SMTP_PORT = 587;
const MAX_ATTEMPTS = 10;
const STALE_PROCESSING_MS = 30 * 60 * 1000;
const AUTOMATION_LOCK_HEARTBEAT_MS = 5 * 60 * 1000;
const PENDING_SHIPMENT_ORDER_PROGRESS = 300;
const MANUALLY_IGNORED_SHIPPING_NOTE = '用户人工忽略单号回传';
// 2026-10-01 00:00:00 Asia/Tokyo. Automation applies only to orders first imported after this instant.
const AUTOMATION_ORDER_IMPORT_CUTOFF = new Date('2026-09-30T15:00:00.000Z');

type FulfillmentType = 'japan' | 'china' | 'mixed';
type ManualMailReviewReason = 'manual_update' | 'combo_order' | 'manual_update_and_combo';
type ConnectionWithShop = RakutenRmsConnection & { shop: { id: bigint; name: string } };

interface ShippingBasket {
  basketId: number;
  ShippingModelList: Array<{
    shippingNumber: string;
    deliveryCompany: string;
    shippingDate: string;
    shippingDeleteFlag: number;
  }>;
}

interface ShippingRunCounts {
  sent: number;
  skipped: number;
  failed: number;
}

interface MailRunCounts {
  sent: number;
  failed: number;
  blocked: number;
}

interface AutomationRunResult {
  alreadyRunning: boolean;
  lockedConnections: number;
  shippingReports: number;
  mails: number;
  shipping: ShippingRunCounts;
  mail: MailRunCounts;
  connectionRuns: ConnectionAutomationRunResult[];
}

interface ConnectionAutomationRunResult {
  connectionId: string;
  shopName: string;
  runId: string;
  status: RakutenAutomationRunStatus;
  shipping: ShippingRunCounts;
  mail: MailRunCounts;
  errors: string[];
}

interface AutomationRunListQuery {
  connectionId?: string;
  status?: string;
  page?: string;
  pageSize?: string;
}

interface ShippingReportListQuery {
  connectionId?: string;
  status?: string;
  orderId?: string;
  page?: string;
  pageSize?: string;
}

interface FailureClassification {
  retryable: boolean;
  category: string;
}

interface FailureHandlingResult extends FailureClassification {
  deadLetter: boolean;
}

interface MailListQuery {
  connectionId?: string;
  status?: string;
  event?: string;
  orderId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: string;
  pageSize?: string;
}

interface MailTemplatePayload {
  subjectTemplate?: string;
  bodyTemplate?: string;
  orderId?: string;
}

interface MailTemplateDefinition {
  subjectTemplate: string;
  bodyTemplate: string;
}

interface ManualAutomationSelection {
  kind?: string;
  id?: string;
  templateVersion?: number;
  orderFingerprint?: string;
  manualReviewConfirmed?: boolean;
  bodyOverride?: string;
}

const MAIL_TEMPLATE_VARIABLES = [
  { key: 'buyer_name', label: '购买者姓名' },
  { key: 'order_number', label: '乐天订单号' },
  { key: 'order_summary', label: '订单、收件地址及商品汇总' },
  { key: 'tracking_sections', label: '全部包裹物流信息' },
  { key: 'china_tracking_sections', label: '中国发包裹物流信息' },
  { key: 'japan_items', label: '日本发商品列表' },
  { key: 'china_items', label: '中国发商品列表' },
  { key: 'japan_tracking', label: '日本发快递公司及单号' },
  { key: 'signature', label: '店铺签名' },
] as const;

@Injectable()
export class RakutenRmsAutomationService {
  private readonly ownedLocks = new Map<bigint, { token: string; lost: boolean }>();
  private readonly logger = new Logger(RakutenRmsAutomationService.name);

  private readonly candidateCursors = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: RakutenRmsApiClient,
    private readonly crypto: RakutenRmsApiCryptoService,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly schedules?: RakutenScheduleControlService,
  ) {}

  async enqueueNewOrderMails(
    db: Prisma.TransactionClient,
    connectionId: bigint,
    orderIds: Iterable<string>,
  ): Promise<void> {
    const uniqueOrderIds = Array.from(new Set(Array.from(orderIds).map((value) => value.trim()).filter(Boolean)));
    if (!uniqueOrderIds.length) return;
    const eligibleKeys = await this.loadEligibleAutomationOrderKeys(
      uniqueOrderIds.map((orderId) => ({ connectionId, orderId })),
      db,
    );
    const eligibleOrderIds = uniqueOrderIds.filter((orderId) =>
      eligibleKeys.has(this.automationOrderKey(connectionId, orderId)));
    if (!eligibleOrderIds.length) return;
    await db.rakutenOrderMail.createMany({
      data: eligibleOrderIds.map((orderId) => ({
        connectionId,
        orderId,
        event: RakutenOrderMailEvent.new_order,
      })),
      skipDuplicates: true,
    });
  }

  // Every API import entry calls this after commit, before logistics or shipping.
  // Only the imported orders' new_order tasks are eligible for this immediate phase.
  async sendImportedNewOrderMails(connectionId: bigint, orderIds: string[], trigger: RakutenAutomationRunTrigger): Promise<MailRunCounts & { deferred?: boolean }> {
    if (this.schedules) {
      const result = await this.schedules.execute('mail', () => this.sendImportedNewOrderMailsNow(connectionId, orderIds, trigger),
        (counts) => ({ status: counts.failed || counts.blocked ? 'partial' : 'success', errors: counts.failed || counts.blocked ? [`${counts.failed} 封失败，${counts.blocked} 封等待处理`] : [] }));
      return result ?? { sent: 0, failed: 0, blocked: 0, deferred: true };
    }
    if (SCHEDULED_AUTOMATION_PAUSED) return { sent: 0, failed: 0, blocked: 0, deferred: true };
    return this.sendImportedNewOrderMailsNow(connectionId, orderIds, trigger);
  }

  private async sendImportedNewOrderMailsNow(connectionId: bigint, orderIds: string[], trigger: RakutenAutomationRunTrigger): Promise<MailRunCounts & { deferred?: boolean }> {
    const counts: MailRunCounts = { sent: 0, failed: 0, blocked: 0 };
    if (!orderIds.length) return { ...counts, deferred: true };
    const connection = await this.prisma.rakutenRmsConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.status !== 1 || !connection.mailNotificationsEnabled || connection.mailCircuitOpenedAt) {
      return { ...counts, deferred: true };
    }
    const token = randomUUID();
    if (!await this.acquireConnectionLock(connectionId, token)) return { ...counts, deferred: true };
    const heartbeat = this.startConnectionLockHeartbeat(connectionId, token);
    try {
      const run = await this.prisma.rakutenAutomationRun.create({ data: { connectionId, trigger }, select: { id: true } });
      try {
        const unique = [...new Set(orderIds)];
        for (let offset = 0; offset < unique.length; offset += 100) {
          const current = await this.prisma.rakutenRmsConnection.findUnique({ where: { id: connectionId } });
          if (!current || current.status !== 1 || !current.mailNotificationsEnabled || current.mailCircuitOpenedAt) break;
          const tasks = await this.prisma.rakutenOrderMail.findMany({ where: {
            connectionId, orderId: { in: unique.slice(offset, offset + 100) }, event: RakutenOrderMailEvent.new_order,
            status: { in: [RakutenAutomationStatus.pending, RakutenAutomationStatus.failed] }, attempts: { lt: MAX_ATTEMPTS },
            AND: [{ OR: [{ failureCategory: null }, { failureCategory: { notIn: ['manual_review', 'template_missing', 'order_changed', 'prerequisite_missing'] } }] }],
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
          }, orderBy: { id: 'asc' }, select: { id: true } });
          if (!tasks.length) continue;
          const result = await this.processMails(connectionId, tasks.map((task) => task.id));
          counts.sent += result.sent; counts.failed += result.failed; counts.blocked += result.blocked;
        }
        await this.prisma.rakutenAutomationRun.update({ where: { id: run.id }, data: {
          status: counts.failed || counts.blocked ? RakutenAutomationRunStatus.partial : RakutenAutomationRunStatus.success,
          mailSent: counts.sent, mailFailed: counts.failed, mailBlocked: counts.blocked, finishedAt: new Date(),
        } });
      } catch (error) {
        await this.prisma.rakutenAutomationRun.update({ where: { id: run.id }, data: {
          status: RakutenAutomationRunStatus.failed, errorMessage: this.errorMessage(error), finishedAt: new Date(),
        } });
        throw error;
      }
      return counts;
    } finally {
      clearInterval(heartbeat);
      await this.releaseConnectionLock(connectionId, token);
    }
  }

  async runScheduledAutomation(trigger: RakutenAutomationRunTrigger = RakutenAutomationRunTrigger.scheduled, stage?: 'shipping' | 'mail'): Promise<{
    status: 'completed' | 'paused' | 'failed'; result?: AutomationRunResult; error?: string;
  }> {
    if (!stage && SCHEDULED_AUTOMATION_PAUSED) return { status: 'paused' };
    try {
      return { status: 'completed', result: await this.runAutomation(undefined, trigger, stage) };
    } catch (error) {
      this.logger.error(`Rakuten shipping/mail automation failed: ${this.errorMessage(error)}`);
      return { status: 'failed', error: this.errorMessage(error) };
    }
  }

  async testSmtpConnection(idRaw: string): Promise<unknown> {
    const connectionId = parseId(idRaw, 'connectionId');
    const connection = await this.prisma.rakutenRmsConnection.findUnique({ where: { id: connectionId } });
    if (!connection) throw new NotFoundException('乐天连接不存在');
    const smtp = this.decryptSmtpCredentials(connection);
    const transport = this.createSmtpTransport(smtp);
    try {
      await transport.verify();
      await this.prisma.rakutenRmsConnection.update({
        where: { id: connectionId },
        data: { mailCircuitOpenedAt: null, mailCircuitReason: null },
      });
      return {
        ok: true,
        host: SMTP_HOST,
        port: SMTP_PORT,
        fromAddress: smtp.fromAddress,
        bccAddresses: smtp.bccAddresses,
        testedAt: new Date().toISOString(),
      };
    } finally {
      transport.close();
    }
  }

  async getConnectionStatus(idRaw: string): Promise<unknown> {
    const connectionId = parseId(idRaw, 'connectionId');
    const connection = await this.prisma.rakutenRmsConnection.findUnique({
      where: { id: connectionId },
      select: {
        id: true,
        automationLockToken: true,
        automationLockedAt: true,
        shippingCircuitOpenedAt: true,
        shippingCircuitReason: true,
        mailCircuitOpenedAt: true,
        mailCircuitReason: true,
      },
    });
    if (!connection) throw new NotFoundException('乐天连接不存在');
    const [shippingCounts, mailCounts, shippingIssues, mailIssues] = await Promise.all([
      this.prisma.rakutenOrderShippingReport.groupBy({
        by: ['status'], where: { connectionId }, _count: { _all: true },
      }),
      this.prisma.rakutenOrderMail.groupBy({
        by: ['status'], where: { connectionId }, _count: { _all: true },
      }),
      this.prisma.rakutenOrderShippingReport.findMany({
        where: {
          connectionId,
          status: {
            in: [
              RakutenAutomationStatus.failed,
              RakutenAutomationStatus.skipped,
              RakutenAutomationStatus.dead_letter,
            ],
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 30,
        select: {
          id: true, orderId: true, status: true, attempts: true, lastError: true,
          failureCategory: true, deadLetteredAt: true, nextAttemptAt: true, updatedAt: true,
        },
      }),
      this.prisma.rakutenOrderMail.findMany({
        where: {
          connectionId,
          status: {
            in: [
              RakutenAutomationStatus.failed,
              RakutenAutomationStatus.uncertain,
              RakutenAutomationStatus.dead_letter,
            ],
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 30,
        select: {
          id: true, orderId: true, event: true, status: true, attempts: true, lastError: true,
          failureCategory: true, deadLetteredAt: true, nextAttemptAt: true, updatedAt: true,
        },
      }),
    ]);
    const serialize = (row: Record<string, unknown>) => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === 'bigint' ? value.toString() : value instanceof Date ? value.toISOString() : value,
      ]),
    );
    return {
      running: this.isConnectionLockActive(connection),
      circuits: {
        shipping: {
          open: Boolean(connection.shippingCircuitOpenedAt),
          openedAt: connection.shippingCircuitOpenedAt?.toISOString() ?? null,
          reason: connection.shippingCircuitReason,
        },
        mail: {
          open: Boolean(connection.mailCircuitOpenedAt),
          openedAt: connection.mailCircuitOpenedAt?.toISOString() ?? null,
          reason: connection.mailCircuitReason,
        },
      },
      shipping: Object.fromEntries(shippingCounts.map((row) => [row.status, row._count._all])),
      mail: Object.fromEntries(mailCounts.map((row) => [row.status, row._count._all])),
      issues: [
        ...shippingIssues.map((row) => ({ kind: 'shipping', ...serialize(row) })),
        ...mailIssues.map((row) => ({ kind: 'mail', ...serialize(row) })),
      ].sort((a, b) =>
        String((b as Record<string, unknown>).updatedAt).localeCompare(
          String((a as Record<string, unknown>).updatedAt),
        )),
    };
  }

  async retryJob(
    idRaw: string,
    payload: { kind?: string; id?: string },
    userId: bigint,
  ): Promise<{ retried: boolean }> {
    const connectionId = parseId(idRaw, 'connectionId');
    const jobId = parseId(String(payload?.id ?? ''), 'jobId');
    const data = {
      status: RakutenAutomationStatus.pending,
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      failureCategory: null,
      deadLetteredAt: null,
    } as const;
    if (payload?.kind === 'shipping') {
      const existing = await this.prisma.rakutenOrderShippingReport.findUnique({ where: { id: jobId } });
      if (!existing || existing.connectionId !== connectionId) throw new BadRequestException('回传任务不存在或不属于该连接');
      const rows = await this.loadOrderRows(connectionId, existing.orderId);
      if (!await this.isAutomationEligibleOrder(rows)) throw new BadRequestException('订单不在2026年10月1日起导入范围内');
      const currentType = fulfillmentOf(rows);
      const currentFingerprint = shippingFingerprint(rows, currentType);
      const changedCompleted = existing.status === RakutenAutomationStatus.sent &&
        (existing.fulfillmentType !== currentType || existing.fingerprint !== currentFingerprint);
      if (existing.status === RakutenAutomationStatus.sent && !changedCompleted) throw new BadRequestException('已完成且单号未变化，无需重新回传');
      const result = await this.prisma.rakutenOrderShippingReport.updateMany({
        where: {
          id: jobId,
          connectionId,
          status: {
            in: [
              RakutenAutomationStatus.failed,
              RakutenAutomationStatus.skipped,
              RakutenAutomationStatus.dead_letter,
              ...(changedCompleted ? [RakutenAutomationStatus.sent] : []),
            ],
          },
        },
        data: { ...data, fulfillmentType: currentType, fingerprint: currentFingerprint, responsePayload: Prisma.DbNull },
      });
      if (result.count !== 1) throw new BadRequestException('该回传任务不存在或当前状态不能重试');
      await this.createAudit({
        entityType: 'rakuten_shipping_report',
        entityId: jobId,
        action: AuditAction.update,
        eventType: AuditEventType.RAKUTEN_SHIPPING_RETRIED,
        operatorId: userId,
        afterData: { status: RakutenAutomationStatus.pending, connectionId },
        remark: '用户手动重试乐天单号回传任务',
      });
      return { retried: true };
    }
    if (payload?.kind === 'mail') {
      const existing = await this.prisma.rakutenOrderMail.findUnique({ where: { id: jobId } });
      if (!existing || existing.connectionId !== connectionId) throw new BadRequestException('邮件任务不存在或不属于该连接');
      await this.assertOrderNotDeleted(connectionId, existing.orderId);
      const result = await this.prisma.rakutenOrderMail.updateMany({
        where: {
          id: jobId,
          connectionId,
          status: { in: [RakutenAutomationStatus.failed, RakutenAutomationStatus.dead_letter] },
        },
        data,
      });
      if (result.count !== 1) throw new BadRequestException('该邮件任务不存在或当前状态不能重试');
      await this.createAudit({
        entityType: 'rakuten_order_mail',
        entityId: jobId,
        action: AuditAction.update,
        eventType: AuditEventType.RAKUTEN_MAIL_RETRIED,
        operatorId: userId,
        afterData: { status: RakutenAutomationStatus.pending, connectionId },
        remark: '用户从连接管理弹窗重试乐天邮件任务',
      });
      return { retried: true };
    }
    throw new BadRequestException('kind只支持shipping或mail');
  }

  async resetCircuit(idRaw: string, kindRaw: string, userId: bigint): Promise<{ reset: boolean; kind: string }> {
    const connectionId = parseId(idRaw, 'connectionId');
    const kind = String(kindRaw || '').trim();
    if (kind !== 'shipping' && kind !== 'mail') {
      throw new BadRequestException('熔断器类型只支持shipping或mail');
    }
    const result = await this.prisma.rakutenRmsConnection.updateMany({
      where: { id: connectionId },
      data: kind === 'shipping'
        ? { shippingCircuitOpenedAt: null, shippingCircuitReason: null }
        : { mailCircuitOpenedAt: null, mailCircuitReason: null },
    });
    if (result.count !== 1) throw new NotFoundException('乐天连接不存在');
    await this.createAudit({
      entityType: 'rakuten_rms_connection',
      entityId: connectionId,
      action: AuditAction.update,
      eventType: AuditEventType.RAKUTEN_AUTOMATION_CIRCUIT_RESET,
      operatorId: userId,
      afterData: { circuit: kind, reset: true },
      remark: `用户恢复乐天${kind === 'shipping' ? '单号回传' : '邮件'}自动处理`,
    });
    return { reset: true, kind };
  }

  async listMails(query: MailListQuery): Promise<unknown> {
    const page = this.parsePositiveInteger(query.page, 1, 1, 100_000);
    const pageSize = this.parsePositiveInteger(query.pageSize, 30, 1, 100);
    const status = query.status ? this.parseMailStatus(query.status) : undefined;
    const event = query.event ? this.parseMailEvent(query.event) : undefined;
    const connectionId = query.connectionId
      ? parseId(query.connectionId, 'connectionId')
      : undefined;
    const createdAt = this.parseDateRange(query.dateFrom, query.dateTo);
    const requestedStart = createdAt?.gte instanceof Date ? createdAt.gte : null;
    const effectiveCreatedAt: Prisma.DateTimeFilter = {
      ...createdAt,
      gte: requestedStart && requestedStart > AUTOMATION_ORDER_IMPORT_CUTOFF
        ? requestedStart
        : AUTOMATION_ORDER_IMPORT_CUTOFF,
    };
    const baseWhere: Prisma.RakutenOrderMailWhereInput = {
      ...(connectionId ? { connectionId } : {}),
      ...(event ? { event } : {}),
      ...(query.orderId?.trim()
        ? { orderId: { contains: query.orderId.trim() } }
        : {}),
      createdAt: effectiveCreatedAt,
    };
    const where: Prisma.RakutenOrderMailWhereInput = {
      ...baseWhere,
      ...(status ? { status } : {}),
    };
    const [items, total, grouped] = await Promise.all([
      this.prisma.rakutenOrderMail.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { connection: { select: { id: true, shop: { select: { id: true, name: true } } } } },
      }),
      this.prisma.rakutenOrderMail.count({ where }),
      this.prisma.rakutenOrderMail.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
    ]);
    return {
      items: items.map((item) => this.serializeMail(item)),
      total,
      page,
      pageSize,
      stats: Object.fromEntries(grouped.map((row) => [row.status, row._count._all])),
    };
  }

  async getMailDetail(idRaw: string): Promise<unknown> {
    const id = parseId(idRaw, 'mailId');
    const mail = await this.prisma.rakutenOrderMail.findUnique({
      where: { id },
      include: {
        connection: {
          select: { id: true, smtpBccAddresses: true, shop: { select: { id: true, name: true } } },
        },
      },
    });
    if (!mail) throw new NotFoundException('邮件任务不存在');
    let subject = mail.subject;
    let body = mail.body;
    let previewError: string | null = null;
    const hasImmutableSendSnapshot =
      mail.status === RakutenAutomationStatus.sent ||
      mail.status === RakutenAutomationStatus.uncertain;
    if (!hasImmutableSendSnapshot || !subject || !body) {
      if (!hasImmutableSendSnapshot) {
        subject = null;
        body = null;
      }
      try {
        const rows = await this.loadOrderRows(mail.connectionId, mail.orderId);
        const rendered = await this.renderConfiguredMail(mail.connectionId, mail.event, rows);
        subject = rendered.subject;
        body = rendered.body;
      } catch (error) {
        previewError = this.errorMessage(error);
      }
    }
    const bccRecipients = mail.bccRecipients ?? mail.connection.smtpBccAddresses;
    return { ...this.serializeMail(mail), subject, body, bccRecipients, previewError };
  }

  async retryMail(idRaw: string, userId: bigint): Promise<{ retried: boolean; dependentMailsRetried: number }> {
    const id = parseId(idRaw, 'mailId');
    const mail = await this.prisma.rakutenOrderMail.findUnique({ where: { id } });
    if (!mail) throw new NotFoundException('邮件任务不存在');
    await this.assertOrderNotDeleted(mail.connectionId, mail.orderId);
    if (
      mail.status !== RakutenAutomationStatus.failed &&
      mail.status !== RakutenAutomationStatus.cancelled &&
      mail.status !== RakutenAutomationStatus.uncertain &&
      mail.status !== RakutenAutomationStatus.dead_letter
    ) {
      throw new BadRequestException('只有失败、需人工处理、已取消或发送结果待确认的邮件可以重试');
    }
    const wasUncertain = mail.status === RakutenAutomationStatus.uncertain;
    const dependentEvents = this.dependentMailEvents(mail.event);
    const [result, dependents] = await this.prisma.$transaction([
      this.prisma.rakutenOrderMail.updateMany({
        where: {
          id,
          status: {
            in: [
              RakutenAutomationStatus.failed,
              RakutenAutomationStatus.cancelled,
              RakutenAutomationStatus.uncertain,
              RakutenAutomationStatus.dead_letter,
            ],
          },
        },
        data: {
          status: RakutenAutomationStatus.pending,
          attempts: 0,
          nextAttemptAt: new Date(),
          lastError: null,
          failureCategory: null,
          deadLetteredAt: null,
          sendStartedAt: null,
          ...(wasUncertain ? {
            resolvedAt: new Date(),
            resolvedBy: userId,
            resolutionNote: '用户确认重新发送结果不确定的邮件',
          } : {}),
        },
      }),
      this.prisma.rakutenOrderMail.updateMany({
        where: {
          connectionId: mail.connectionId,
          orderId: mail.orderId,
          event: { in: dependentEvents },
          OR: [
            { status: RakutenAutomationStatus.cancelled, lastError: '前置邮件已取消' },
            { status: RakutenAutomationStatus.dead_letter, failureCategory: 'prerequisite' },
          ],
        },
        data: {
          status: RakutenAutomationStatus.pending,
          attempts: 0,
          nextAttemptAt: new Date(),
          lastError: null,
          failureCategory: null,
          deadLetteredAt: null,
        },
      }),
    ]);
    if (result.count !== 1) throw new BadRequestException('邮件状态已变化，请刷新后重试');
    await this.createAudit({
      entityType: 'rakuten_order_mail',
      entityId: id,
      action: AuditAction.update,
      eventType: AuditEventType.RAKUTEN_MAIL_RETRIED,
      operatorId: userId,
      beforeData: { status: mail.status },
      afterData: { status: RakutenAutomationStatus.pending, dependentMailsRetried: dependents.count },
      remark: wasUncertain ? '用户确认重发SMTP结果不确定的邮件' : '用户手动重试邮件',
    });
    return { retried: true, dependentMailsRetried: dependents.count };
  }

  async cancelMail(idRaw: string, userId: bigint): Promise<{ cancelled: boolean; dependentMailsCancelled: number }> {
    const id = parseId(idRaw, 'mailId');
    const mail = await this.prisma.rakutenOrderMail.findUnique({ where: { id } });
    if (!mail) throw new NotFoundException('邮件任务不存在');
    if (
      mail.status !== RakutenAutomationStatus.pending &&
      mail.status !== RakutenAutomationStatus.failed &&
      mail.status !== RakutenAutomationStatus.uncertain &&
      mail.status !== RakutenAutomationStatus.dead_letter
    ) {
      throw new BadRequestException('只有待处理、失败、需人工处理或发送结果待确认的邮件可以取消');
    }
    const wasUncertain = mail.status === RakutenAutomationStatus.uncertain;
    const dependentEvents = this.dependentMailEvents(mail.event);
    const [result, dependents] = await this.prisma.$transaction([
      this.prisma.rakutenOrderMail.updateMany({
        where: {
          id,
          status: {
            in: [
              RakutenAutomationStatus.pending,
              RakutenAutomationStatus.failed,
              RakutenAutomationStatus.uncertain,
              RakutenAutomationStatus.dead_letter,
            ],
          },
        },
        data: {
          status: RakutenAutomationStatus.cancelled,
          nextAttemptAt: null,
          lastError: '由用户手动取消',
          failureCategory: null,
          deadLetteredAt: null,
          resolvedAt: new Date(),
          resolvedBy: userId,
          resolutionNote: wasUncertain ? '用户确认不再重发结果不确定的邮件' : '用户手动取消邮件',
        },
      }),
      this.prisma.rakutenOrderMail.updateMany({
        where: {
          connectionId: mail.connectionId,
          orderId: mail.orderId,
          event: { in: dependentEvents },
          status: {
            in: [
              RakutenAutomationStatus.pending,
              RakutenAutomationStatus.failed,
              RakutenAutomationStatus.dead_letter,
            ],
          },
        },
        data: {
          status: RakutenAutomationStatus.cancelled,
          nextAttemptAt: null,
          lastError: '前置邮件已取消',
          failureCategory: null,
          deadLetteredAt: null,
        },
      }),
    ]);
    if (result.count !== 1) throw new BadRequestException('邮件状态已变化，请刷新后重试');
    await this.createAudit({
      entityType: 'rakuten_order_mail',
      entityId: id,
      action: AuditAction.update,
      eventType: AuditEventType.RAKUTEN_MAIL_CANCELLED,
      operatorId: userId,
      beforeData: { status: mail.status },
      afterData: { status: RakutenAutomationStatus.cancelled, dependentMailsCancelled: dependents.count },
      remark: wasUncertain ? '用户确认停止重发SMTP结果不确定的邮件' : '用户手动取消邮件',
    });
    return { cancelled: true, dependentMailsCancelled: dependents.count };
  }

  async markMailAsSent(idRaw: string, userId: bigint): Promise<{ markedSent: boolean }> {
    const id = parseId(idRaw, 'mailId');
    const mail = await this.prisma.rakutenOrderMail.findUnique({ where: { id } });
    if (!mail) throw new NotFoundException('邮件任务不存在');
    const result = await this.prisma.rakutenOrderMail.updateMany({
      where: { id, status: RakutenAutomationStatus.uncertain },
      data: {
        status: RakutenAutomationStatus.sent,
        sentAt: new Date(),
        nextAttemptAt: null,
        lastError: null,
        failureCategory: null,
        deadLetteredAt: null,
        resolvedAt: new Date(),
        resolvedBy: userId,
        resolutionNote: '用户核实后确认邮件已发送或无需重发',
      },
    });
    if (result.count !== 1) throw new BadRequestException('只有发送结果待确认的邮件可以标记为已发送');
    await this.createAudit({
      entityType: 'rakuten_order_mail',
      entityId: id,
      action: AuditAction.update,
      eventType: AuditEventType.RAKUTEN_MAIL_MARKED_SENT,
      operatorId: userId,
      beforeData: { status: mail.status },
      afterData: { status: RakutenAutomationStatus.sent },
      remark: '用户人工确认SMTP结果并标记为已发送',
    });
    return { markedSent: true };
  }

  async ignoreMail(idRaw: string, userId: bigint): Promise<{ ignored: boolean }> {
    const id = parseId(idRaw, 'mailId');
    const mail = await this.prisma.rakutenOrderMail.findUnique({ where: { id } });
    if (!mail) throw new NotFoundException('邮件任务不存在');
    const result = await this.prisma.rakutenOrderMail.updateMany({
      where: { id, status: RakutenAutomationStatus.pending },
      data: {
        status: RakutenAutomationStatus.cancelled,
        nextAttemptAt: null,
        lastError: null,
        failureCategory: null,
        deadLetteredAt: null,
        resolvedAt: new Date(),
        resolvedBy: userId,
        resolutionNote: IGNORED_MAIL,
      },
    });
    if (result.count !== 1) throw new BadRequestException('只有待发送邮件可以忽略，请刷新清单');
    await this.createAudit({
      entityType: 'rakuten_order_mail',
      entityId: id,
      action: AuditAction.update,
      eventType: AuditEventType.RAKUTEN_MAIL_CANCELLED,
      operatorId: userId,
      beforeData: { status: mail.status },
      afterData: { status: RakutenAutomationStatus.cancelled, resolutionNote: IGNORED_MAIL },
      remark: '用户人工忽略邮件并允许继续后续邮件阶段',
    });
    return { ignored: true };
  }

  async verifyCompletedShippingReport(idRaw: string, userId: bigint): Promise<{ verified: boolean }> {
    const id = parseId(idRaw, 'shippingReportId');
    const report = await this.prisma.rakutenOrderShippingReport.findUnique({ where: { id }, include: { connection: true } });
    if (!report) throw new NotFoundException('单号回传任务不存在');
    if (report.status !== RakutenAutomationStatus.sent && report.status !== RakutenAutomationStatus.skipped) {
      throw new BadRequestException('只有已完成或已跳过的回传记录可以核实，请刷新清单');
    }
    const token = randomUUID();
    if (!await this.acquireConnectionLock(report.connectionId, token)) throw new BadRequestException('店铺正在处理任务，请稍后再核实');
    const heartbeat = this.startConnectionLockHeartbeat(report.connectionId, token);
    try {
      const rows = await this.loadOrderRows(report.connectionId, report.orderId);
      if (!await this.isAutomationEligibleOrder(rows)) throw new BadRequestException('订单不在2026年10月1日起导入范围内');
      const block = orderBlockReason(rows);
      if (block) throw new BadRequestException(block);
      const type = fulfillmentOf(rows);
      if (!shippingTargetsReady(rows, type)) throw new BadRequestException('包裹资料或出货、清关确认不完整，请先核对');
      const fingerprint = shippingFingerprint(rows, type);
      const baskets = this.buildShippingBaskets(shippingTargetRows(rows, type));
      const verifiedBaskets = baskets.map((basket) => ({ ...basket, ShippingModelList: basket.ShippingModelList.map((shipping) => ({ ...shipping })) }));
      const credentials = this.decryptApiCredentials(report.connection);
      const orders = await this.client.getOrders(credentials.serviceSecret, credentials.licenseKey, [report.orderId]);
      const current = this.resolveCurrentOrder(orders, report.orderId);
      const progress = current && this.resolveOrderProgress(current);
      if (!current || progress === null || ![100, 200, 300, 400, 500, 600, 700].includes(progress)) {
        throw new BadRequestException('乐天目标订单或订单状态无法核实，请人工核对');
      }
      const packages = current.PackageModelList ?? current.packageModelList;
      if (!Array.isArray(packages) || !baskets.every((basket) => {
        const pkg = packages.find((value) => Number(value?.basketId ?? value?.BasketId) === basket.basketId);
        const shipping = pkg?.ShippingModelList ?? pkg?.shippingModelList;
        return Array.isArray(shipping) && basket.ShippingModelList.every((expected) => shipping.some((actual) =>
          Number(actual?.shippingDeleteFlag ?? 0) !== 1 &&
          String(actual?.shippingNumber ?? actual?.ShippingNumber ?? '').trim() === expected.shippingNumber &&
          String(actual?.deliveryCompany ?? actual?.DeliveryCompany ?? '').trim() === expected.deliveryCompany &&
          String(actual?.shippingDate ?? actual?.ShippingDate ?? '').trim() === expected.shippingDate));
      })) throw new BadRequestException('乐天端单号、配送公司或発送日与当前包裹不一致，不能忽略提醒');
      await this.assertExecutionLock(report.connectionId);
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM rakuten_order_records
          WHERE rms_connection_id = ${report.connectionId} AND
            (rms_order_id = ${report.orderId} OR (rms_order_id IS NULL AND order_id = ${report.orderId}))
          ORDER BY id FOR UPDATE`);
        const latestRows = await tx.rakutenOrderRecord.findMany({ where: {
          deletedAt: null, rmsConnectionId: report.connectionId, ...rakutenOrderIdentityWhere(report.orderId),
        }, orderBy: { id: 'asc' } });
        if (orderBlockReason(latestRows) || fulfillmentOf(latestRows) !== type || !shippingTargetsReady(latestRows, type) ||
          shippingFingerprint(latestRows, type) !== fingerprint) throw new BadRequestException('核实期间包裹信息已变化，请刷新后重试');
        const result = await tx.rakutenOrderShippingReport.updateMany({ where: {
          id, status: report.status, fingerprint: report.fingerprint, updatedAt: report.updatedAt,
        }, data: {
          fulfillmentType: type, fingerprint, nextAttemptAt: null, failureCategory: null, deadLetteredAt: null,
          lastError: report.status === RakutenAutomationStatus.skipped ? VERIFIED_SHIPPING : null,
          responsePayload: { ...this.jsonObject(report.responsePayload),
            wmsManualShippingVerification: { verifiedAt: new Date().toISOString(), verifiedBy: userId.toString(), baskets: verifiedBaskets },
          } as Prisma.InputJsonValue,
        } });
        if (result.count !== 1) throw new BadRequestException('回传记录已变化，请刷新后重试');
        await this.createAudit({ db: tx, entityType: 'rakuten_shipping_report', entityId: id, action: AuditAction.update,
          eventType: AuditEventType.RAKUTEN_SHIPPING_IGNORED, operatorId: userId,
          beforeData: { status: report.status, fulfillmentType: report.fulfillmentType, fingerprint: report.fingerprint, lastError: report.lastError },
          afterData: { status: report.status, fulfillmentType: type, fingerprint, verifiedBaskets: baskets },
          remark: '用户确认已人工回传，核实乐天全部包裹信息一致后忽略信息变化提醒',
        });
      });
      return { verified: true };
    } finally {
      clearInterval(heartbeat);
      await this.releaseConnectionLock(report.connectionId, token);
    }
  }

  async ignoreShippingReport(idRaw: string, userId: bigint): Promise<{ ignored: boolean }> {
    const id = parseId(idRaw, 'shippingReportId');
    const report = await this.prisma.rakutenOrderShippingReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException('单号回传任务不存在');
    const result = await this.prisma.rakutenOrderShippingReport.updateMany({
      where: {
        id,
        status: { in: [RakutenAutomationStatus.pending, RakutenAutomationStatus.failed, RakutenAutomationStatus.dead_letter] },
      },
      data: {
        status: RakutenAutomationStatus.skipped,
        nextAttemptAt: null,
        lastError: MANUALLY_IGNORED_SHIPPING_NOTE,
        failureCategory: null,
        deadLetteredAt: null,
      },
    });
    if (result.count !== 1) throw new BadRequestException('只有待回传、失败或需人工处理的单号回传任务可以忽略，请刷新清单');
    await this.createAudit({
      entityType: 'rakuten_shipping_report',
      entityId: id,
      action: AuditAction.update,
      eventType: AuditEventType.RAKUTEN_SHIPPING_IGNORED,
      operatorId: userId,
      beforeData: { status: report.status },
      afterData: { status: RakutenAutomationStatus.skipped, reason: MANUALLY_IGNORED_SHIPPING_NOTE },
      remark: '用户确认由人工回传或无需系统回传，忽略单号回传任务',
    });
    return { ignored: true };
  }

  async listMailTemplates(connectionIdRaw: string): Promise<unknown> {
    const connectionId = await this.requireConnection(connectionIdRaw);
    const activeVersions = await this.prisma.rakutenMailTemplateVersion.findMany({
      where: { connectionId, isActive: true },
      orderBy: [{ event: 'asc' }, { version: 'desc' }],
      include: { creator: { select: { id: true, username: true } } },
    });
    const activeByEvent = new Map<RakutenOrderMailEvent, typeof activeVersions[number]>();
    for (const version of activeVersions) {
      if (!activeByEvent.has(version.event)) activeByEvent.set(version.event, version);
    }
    return {
      connectionId: connectionId.toString(),
      variables: MAIL_TEMPLATE_VARIABLES,
      templates: Object.values(RakutenOrderMailEvent).map((event) => {
        const active = activeByEvent.get(event);
        if (active) return this.serializeMail(active);
        return { event, version: 0, isActive: false, isSystemDefault: true, ...this.defaultMailTemplate(event) };
      }),
    };
  }

  async getMailTemplateHistory(connectionIdRaw: string, eventRaw: string): Promise<unknown> {
    const connectionId = await this.requireConnection(connectionIdRaw);
    const event = this.parseMailEvent(eventRaw);
    const versions = await this.prisma.rakutenMailTemplateVersion.findMany({
      where: { connectionId, event },
      orderBy: { version: 'desc' },
      include: { creator: { select: { id: true, username: true } } },
    });
    return {
      event,
      versions: [
        ...versions.map((version) => this.serializeMail(version)),
        {
          event,
          version: 0,
          isActive: false,
          isSystemDefault: true,
          createdAt: null,
          creator: null,
          ...this.defaultMailTemplate(event),
        },
      ],
    };
  }

  async saveMailTemplate(
    connectionIdRaw: string,
    eventRaw: string,
    payload: MailTemplatePayload,
    userId: bigint,
  ): Promise<unknown> {
    const connectionId = await this.requireConnection(connectionIdRaw);
    const event = this.parseMailEvent(eventRaw);
    const template = this.validateMailTemplate(payload, event);
    const created = await this.prisma.$transaction(async (tx) => {
      const maximum = await tx.rakutenMailTemplateVersion.aggregate({
        where: { connectionId, event },
        _max: { version: true },
      });
      await tx.rakutenMailTemplateVersion.updateMany({
        where: { connectionId, event, isActive: true },
        data: { isActive: false },
      });
      return tx.rakutenMailTemplateVersion.create({
        data: {
          connectionId,
          event,
          version: (maximum._max.version ?? 0) + 1,
          subjectTemplate: template.subjectTemplate,
          bodyTemplate: template.bodyTemplate,
          isActive: true,
          createdBy: userId,
          activatedAt: new Date(),
        },
        include: { creator: { select: { id: true, username: true } } },
      });
    });
    await this.createAudit({
      entityType: 'rakuten_mail_template',
      entityId: connectionId,
      action: AuditAction.create,
      eventType: AuditEventType.RAKUTEN_MAIL_TEMPLATE_SAVED,
      operatorId: userId,
      afterData: { event, version: created.version, isActive: true },
      remark: `保存并启用乐天邮件模板 ${event} 版本 ${created.version}`,
    });
    return this.serializeMail(created);
  }

  async activateMailTemplateVersion(
    connectionIdRaw: string,
    eventRaw: string,
    versionRaw: string,
    userId: bigint,
  ): Promise<unknown> {
    const connectionId = await this.requireConnection(connectionIdRaw);
    const event = this.parseMailEvent(eventRaw);
    const version = this.parsePositiveInteger(versionRaw, 0, 0, 1_000_000);
    if (version === 0) {
      // Explicit restoration saves a real active version; a preview-only default
      // must never silently become the scheduled sender's fallback.
      return this.saveMailTemplate(connectionIdRaw, eventRaw, this.defaultMailTemplate(event), userId);
    }
    const target = await this.prisma.rakutenMailTemplateVersion.findUnique({
      where: { connectionId_event_version: { connectionId, event, version } },
    });
    if (!target) throw new NotFoundException('邮件模板版本不存在');
    this.validateMailTemplate(target, event);
    const activated = await this.prisma.$transaction(async (tx) => {
      await tx.rakutenMailTemplateVersion.updateMany({
        where: { connectionId, event, isActive: true },
        data: { isActive: false },
      });
      return tx.rakutenMailTemplateVersion.update({
        where: { id: target.id },
        data: { isActive: true, activatedAt: new Date() },
        include: { creator: { select: { id: true, username: true } } },
      });
    });
    await this.createAudit({
      entityType: 'rakuten_mail_template',
      entityId: connectionId,
      action: AuditAction.update,
      eventType: AuditEventType.RAKUTEN_MAIL_TEMPLATE_ACTIVATED,
      operatorId: userId,
      afterData: { event, version, isSystemDefault: false },
      remark: `启用乐天邮件模板 ${event} 版本 ${version}`,
    });
    return this.serializeMail(activated);
  }

  async previewMailTemplate(
    connectionIdRaw: string,
    eventRaw: string,
    payload: MailTemplatePayload,
  ): Promise<unknown> {
    const connectionId = await this.requireConnection(connectionIdRaw);
    const event = this.parseMailEvent(eventRaw);
    const hasDraft = payload.subjectTemplate !== undefined || payload.bodyTemplate !== undefined;
    const template = hasDraft
      ? this.validateMailTemplate(payload, event)
      : await this.resolveActiveMailTemplate(connectionId, event);
    let orderId = String(payload.orderId ?? '').trim();
    if (!orderId) {
      const latest = await this.prisma.rakutenOrderRecord.findFirst({
        where: { deletedAt: null, rmsConnectionId: connectionId, orderId: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { orderId: true, rmsOrderId: true },
      });
      orderId = latest ? originalRakutenOrderId(latest) : '';
    }
    if (!orderId) throw new BadRequestException('该店铺没有可用于预览的订单，请输入订单号');
    const rows = await this.loadOrderRows(connectionId, orderId);
    if (!rows.length) throw new NotFoundException('该店铺下未找到预览订单');
    const rendered = template ? this.renderTemplate(template, rows, event) : this.renderMail(event, rows);
    return {
      orderId,
      recipient: this.resolveRecipient(rows),
      subject: rendered.subject,
      body: rendered.body,
    };
  }

  async listAutomationRuns(query: AutomationRunListQuery): Promise<unknown> {
    const page = Math.max(1, Number.parseInt(query.page || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize || '30', 10) || 30));
    const status = String(query.status || '').trim();
    if (status && !Object.values(RakutenAutomationRunStatus).includes(status as RakutenAutomationRunStatus)) {
      throw new BadRequestException('自动化运行状态无效');
    }
    const connectionId = query.connectionId?.trim()
      ? parseId(query.connectionId, 'connectionId')
      : undefined;
    const where: Prisma.RakutenAutomationRunWhereInput = {
      ...(connectionId ? { connectionId } : {}),
      ...(status ? { status: status as RakutenAutomationRunStatus } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.rakutenAutomationRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { connection: { select: { id: true, shop: { select: { id: true, name: true } } } } },
      }),
      this.prisma.rakutenAutomationRun.count({ where }),
    ]);
    return this.serializeMail({ items, total, page, pageSize });
  }

  async listShippingReports(query: ShippingReportListQuery): Promise<unknown> {
    const page = this.parsePositiveInteger(query.page, 1, 1, 100_000);
    const pageSize = this.parsePositiveInteger(query.pageSize, 30, 1, 100);
    const connectionId = query.connectionId?.trim()
      ? parseId(query.connectionId, 'connectionId')
      : undefined;
    const statusRaw = String(query.status || '').trim();
    if (statusRaw && !Object.values(RakutenAutomationStatus).includes(statusRaw as RakutenAutomationStatus)) {
      throw new BadRequestException('单号回传状态无效');
    }
    const baseWhere: Prisma.RakutenOrderShippingReportWhereInput = {
      ...(connectionId ? { connectionId } : {}),
      ...(query.orderId?.trim() ? { orderId: { contains: query.orderId.trim() } } : {}),
    };
    const where: Prisma.RakutenOrderShippingReportWhereInput = {
      ...baseWhere,
      ...(statusRaw ? { status: statusRaw as RakutenAutomationStatus } : {}),
    };
    const [items, total, statusCounts] = await Promise.all([
      this.prisma.rakutenOrderShippingReport.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { connection: { include: { shop: { select: { id: true, name: true } } } } },
      }),
      this.prisma.rakutenOrderShippingReport.count({ where }),
      this.prisma.rakutenOrderShippingReport.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
    ]);
    return this.serializeMail({
      items,
      total,
      page,
      pageSize,
      stats: Object.fromEntries(statusCounts.map((row) => [row.status, row._count._all])),
    });
  }

  async resolveMissingOrderMail(connectionIdRaw: string, orderIdRaw: string, eventRaw: string, mode: string, userId: bigint): Promise<unknown> {
    const connectionId = parseId(connectionIdRaw, 'connectionId');
    const orderId = String(orderIdRaw ?? '').trim();
    if (!['new_order', 'japan_shipped'].includes(eventRaw)) throw new BadRequestException('此处仅支持缺失的新規或日本発邮件');
    const event = this.parseMailEvent(eventRaw);
    const label = event === RakutenOrderMailEvent.new_order ? '新規' : '日本発';
    if (!orderId || !['create', 'ignore'].includes(mode)) throw new BadRequestException('请选择生成邮件任务或确认无需发送');
    const connection = await this.prisma.rakutenRmsConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.status !== 1 || !connection.mailNotificationsEnabled) throw new BadRequestException('该店铺邮件功能未启用');
    const rows = await this.loadOrderRows(connectionId, orderId);
    if (!await this.isAutomationEligibleOrder(rows) || !rows.some((row) => row.sourceKind === 'rms_api')) {
      throw new BadRequestException('订单不在2026年10月1日起首次导入的API订单范围内');
    }
    const block = mailOrderBlockReason(event, rows);
    if (block) throw new BadRequestException(block);
    let externalShipping = false;
    if (event === RakutenOrderMailEvent.japan_shipped) {
      const report = await this.prisma.rakutenOrderShippingReport.findUnique({ where: { connectionId_orderId: { connectionId, orderId } } });
      if (fulfillmentOf(rows) !== 'japan' || !shippingSatisfied(report) || !japanWarehouseReady(rows)) {
        throw new BadRequestException('请先确认日本侧实际出货及单号回传完成');
      }
      const condition = mailConditionReason(event, rows, report);
      if (condition && !condition.includes('外部')) throw new BadRequestException(condition);
      externalShipping = report?.status === RakutenAutomationStatus.skipped;
    }
    const existing = await this.prisma.rakutenOrderMail.findUnique({ where: { connectionId_orderId_event: {
      connectionId, orderId, event,
    } } });
    if (existing) throw new BadRequestException(`${label}任务已存在，请刷新订单进度`);
    let created;
    try {
      created = await this.prisma.rakutenOrderMail.create({ data: {
        connectionId, orderId, event,
        ...(mode === 'create' && externalShipping ? { resolutionNote: '用户确认重新发送结果不确定的邮件', resolvedAt: new Date(), resolvedBy: userId } : {}),
        ...(mode === 'ignore' ? { status: RakutenAutomationStatus.cancelled, resolutionNote: IGNORED_MAIL,
          resolvedAt: new Date(), resolvedBy: userId } : {}),
      } });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) throw new BadRequestException(`${label}任务已存在，请刷新订单进度`);
      throw error;
    }
    await this.createAudit({ entityType: 'rakuten_order_mail', entityId: created.id, action: AuditAction.update,
      eventType: mode === 'ignore' ? AuditEventType.RAKUTEN_MAIL_CANCELLED : AuditEventType.RAKUTEN_MAIL_RETRIED,
      operatorId: userId, afterData: { connectionId, orderId, event, status: created.status },
      remark: mode === 'ignore' ? `用户确认缺失的${label}邮件无需发送` : `用户核实发送记录后补建缺失的${label}邮件任务`,
    });
    return this.serializeMail(created);
  }

  async listOrderWorkflows(query: { connectionId?: string; orderId?: string; view?: string; page?: string; pageSize?: string }): Promise<unknown> {
    const page = this.parsePositiveInteger(query.page, 1, 1, 100000);
    const pageSize = this.parsePositiveInteger(query.pageSize, 30, 1, 100);
    const connectionId = query.connectionId ? parseId(query.connectionId, 'connectionId') : null;
    const keyword = String(query.orderId ?? '').trim();
    const view = String(query.view || 'all');
    if (!['all', 'manual', 'processing', 'done'].includes(view)) throw new BadRequestException('订单流程视图无效');
    const scope = Prisma.sql`
      FROM rakuten_order_records records
      INNER JOIN rakuten_rms_connections connections ON connections.id = records.rms_connection_id
      WHERE records.deleted_at IS NULL AND COALESCE(records.rms_order_id, records.order_id) IS NOT NULL AND COALESCE(records.rms_order_id, records.order_id) <> ''
        ${connectionId ? Prisma.sql`AND records.rms_connection_id = ${connectionId}` : Prisma.empty}
        ${keyword ? Prisma.sql`AND (COALESCE(records.rms_order_id, records.order_id) LIKE ${`%${keyword}%`} OR records.order_id LIKE ${`%${keyword}%`})` : Prisma.empty}
        AND NOT EXISTS (
          SELECT 1 FROM rakuten_order_records older_records
          WHERE older_records.rms_connection_id = records.rms_connection_id
            AND COALESCE(older_records.rms_order_id, older_records.order_id) = COALESCE(records.rms_order_id, records.order_id)
            AND older_records.created_at < ${AUTOMATION_ORDER_IMPORT_CUTOFF}
        )
      GROUP BY records.rms_connection_id, COALESCE(records.rms_order_id, records.order_id)
      HAVING MIN(records.created_at) >= ${AUTOMATION_ORDER_IMPORT_CUTOFF}
        AND SUM(records.source_kind = 'rms_api') > 0
    `;
    if (view !== 'all') {
      // Workflow state depends on facts and independent results. Evaluate before
      // pagination so manual cases on later pages cannot disappear from the inbox.
      const refs = await this.prisma.$queryRaw<Array<{ connectionId: bigint; orderId: string }>>(Prisma.sql`
        SELECT records.rms_connection_id AS connectionId, COALESCE(records.rms_order_id, records.order_id) AS orderId ${scope}
        ORDER BY MIN(records.created_at) DESC, records.rms_connection_id ASC, COALESCE(records.rms_order_id, records.order_id) ASC
      `);
      const summary = { manual: 0, processing: 0, done: 0 };
      const items: ReturnType<typeof buildOrderWorkflow>[] = [];
      let total = 0;
      const offset = (page - 1) * pageSize;
      for (let index = 0; index < refs.length; index += 100) {
        const workflows = await this.loadOrderWorkflowBatch(refs.slice(index, index + 100));
        for (const workflow of workflows) {
          summary[workflow.state as keyof typeof summary] += 1;
          if (workflow.state !== view) continue;
          if (total >= offset && items.length < pageSize) items.push(workflow);
          total += 1;
        }
      }
      return { items, total, summary, view, page, pageSize, intervalMinutes: 20 };
    }
    const [countRows, refs] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`SELECT COUNT(*) AS total FROM (SELECT COALESCE(records.rms_order_id, records.order_id) ${scope}) scoped`),
      this.prisma.$queryRaw<Array<{ connectionId: bigint; orderId: string }>>(Prisma.sql`
        SELECT records.rms_connection_id AS connectionId, COALESCE(records.rms_order_id, records.order_id) AS orderId ${scope}
        ORDER BY MIN(records.created_at) DESC, records.rms_connection_id ASC, COALESCE(records.rms_order_id, records.order_id) ASC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `),
    ]);
    const total = Number(countRows[0]?.total ?? 0);
    if (!refs.length) return { items: [], total, page, pageSize, intervalMinutes: 20 };
    const items = await this.loadOrderWorkflowBatch(refs);
    return { items, total, page, pageSize, intervalMinutes: 20 };
  }

  private async loadOrderWorkflowBatch(refs: Array<{ connectionId: bigint; orderId: string }>): Promise<ReturnType<typeof buildOrderWorkflow>[]> {
    if (!refs.length) return [];
    const connectionIds = Array.from(new Set(refs.map((ref) => BigInt(ref.connectionId))));
    const orderRefs = refs.map((ref) => ({ connectionId: BigInt(ref.connectionId), orderId: ref.orderId }));
    const [records, reports, mails, connections, templates] = await Promise.all([
      this.prisma.rakutenOrderRecord.findMany({ where: { deletedAt: null, OR: orderRefs.map((ref) => ({ rmsConnectionId: ref.connectionId, ...rakutenOrderIdentityWhere(ref.orderId) })) }, orderBy: { id: 'asc' } }),
      this.prisma.rakutenOrderShippingReport.findMany({ where: { OR: orderRefs } }),
      this.prisma.rakutenOrderMail.findMany({ where: { OR: orderRefs } }),
      this.prisma.rakutenRmsConnection.findMany({ where: { id: { in: connectionIds } }, include: { shop: { select: { name: true } } } }),
      this.prisma.rakutenMailTemplateVersion.findMany({ where: { connectionId: { in: connectionIds }, isActive: true }, select: { connectionId: true, event: true, version: true, subjectTemplate: true, bodyTemplate: true } }),
    ]);
    return orderRefs.flatMap((ref) => {
      const connection = connections.find((row) => row.id === ref.connectionId);
      if (!connection) return [];
      return [buildOrderWorkflow({
        connection,
        rows: records.filter((row) => row.rmsConnectionId === ref.connectionId && originalRakutenOrderId(row) === ref.orderId),
        report: reports.find((row) => row.connectionId === ref.connectionId && row.orderId === ref.orderId) ?? null,
        mails: mails.filter((row) => row.connectionId === ref.connectionId && row.orderId === ref.orderId),
        templateVersions: new Map(templates.filter((row) => { if (row.connectionId !== ref.connectionId) return false; try { this.validateMailTemplate(row, row.event); return true; } catch { return false; } }).map((row) => [row.event, row.version])),
      })];
    });
  }

  // Human holds are excluded from the execution queue. Recheck them separately
  // with a rotating cursor so fixing facts/templates can resume eligible tasks.
  private async refreshMailHolds(connectionId: bigint): Promise<void> {
    const key = `holds:${connectionId}`;
    const cursor = this.candidateCursors.get(key) ?? '0';
    const held = await this.prisma.rakutenOrderMail.findMany({ where: {
      connectionId, id: { gt: BigInt(cursor) }, status: { in: [RakutenAutomationStatus.pending, RakutenAutomationStatus.failed] },
      failureCategory: { in: ['manual_review', 'template_missing', 'order_changed', 'prerequisite_missing'] },
    }, orderBy: { id: 'asc' }, take: 100 });
    this.candidateCursors.set(key, held.length >= 100 ? held[held.length - 1].id.toString() : '0');
    for (const mail of held) {
      try {

        const rows = await this.loadOrderRows(connectionId, mail.orderId);
        if (mailOrderBlockReason(mail.event, rows)) continue;
        const template = await this.resolveActiveMailTemplate(connectionId, mail.event);
        if (!template) continue;
        try { this.validateMailTemplate(template, mail.event); } catch { continue; }
        const report = await this.prisma.rakutenOrderShippingReport.findUnique({ where: { connectionId_orderId: { connectionId, orderId: mail.orderId } } });
        const prerequisiteEvent = this.mailPrerequisiteEvent(mail.event);
        if (prerequisiteEvent) {
          const prerequisite = await this.prisma.rakutenOrderMail.findUnique({ where: { connectionId_orderId_event: {
            connectionId, orderId: mail.orderId, event: prerequisiteEvent,
          } } });
          if (!mailSatisfied(prerequisite)) continue;
        }
        if (mailConditionReason(mail.event, rows, report)) continue;
        const reviewRequired = this.requiresManualMailReview(mail.event, rows);
        await this.prisma.rakutenOrderMail.updateMany({ where: {
          id: mail.id, status: mail.status, failureCategory: mail.failureCategory, lastError: mail.lastError, sendStartedAt: null,
        }, data: {
          failureCategory: reviewRequired ? 'manual_review' : null,
          lastError: reviewRequired ? '请人工核对商品调整、数量、特殊说明及收件资料后确认正文' : null,
          nextAttemptAt: null,
        } });
      } catch (error) {
        this.logger.error(`Rakuten refreshMailHolds 单笔处理失败：${this.errorMessage(error)}`);
      }
    }
  }

  async prepareOrderTasks(connectionIdRaw?: string): Promise<unknown> {
    const connectionId = connectionIdRaw ? parseId(connectionIdRaw, 'connectionId') : undefined;
    await this.recoverStaleJobs();
    const connections = await this.prisma.rakutenRmsConnection.findMany({ where: {
      ...(connectionId ? { id: connectionId } : {}), status: 1,
      OR: [{ autoShippingEnabled: true }, { mailNotificationsEnabled: true }],
    }, include: { shop: { select: { id: true, name: true } } }, orderBy: { id: 'asc' } });
    let preparedConnections = 0;
    let lockedConnections = 0;
    for (const connection of connections) {
      const token = randomUUID();
      if (!await this.acquireConnectionLock(connection.id, token)) { lockedConnections += 1; continue; }
      const heartbeat = this.startConnectionLockHeartbeat(connection.id, token);
      try {
        if (connection.autoShippingEnabled) await this.prepareShippingReports(connection);
        if (connection.mailNotificationsEnabled) {
          await this.refreshMailHolds(connection.id);
          await this.prepareTrackingMails(connection);
          await this.prepareCustomsMails(connection);
        }
        preparedConnections += 1;
      } finally {
        clearInterval(heartbeat);
        await this.releaseConnectionLock(connection.id, token);
      }
    }
    return { preparedConnections, lockedConnections };
  }

  async previewManualMailAction(idRaw: string, templateVersionRaw?: number): Promise<unknown> {
    const id = parseId(idRaw, 'mailId');
    const templateVersion = Number(templateVersionRaw);
    if (!Number.isInteger(templateVersion) || templateVersion <= 0) {
      throw new BadRequestException('邮件模板版本无效，请重新整理清单');
    }
    const mail = await this.prisma.rakutenOrderMail.findUnique({
      where: { id },
      include: { connection: { include: { shop: { select: { id: true, name: true } } } } },
    });
    if (!mail) throw new NotFoundException('邮件任务不存在');
    if (mail.status !== RakutenAutomationStatus.pending && mail.status !== RakutenAutomationStatus.failed) {
      throw new BadRequestException('邮件状态已变化，请重新整理清单');
    }
    const template = await this.prisma.rakutenMailTemplateVersion.findUnique({
      where: {
        connectionId_event_version: {
          connectionId: mail.connectionId,
          event: mail.event,
          version: templateVersion,
        },
      },
      select: { version: true, subjectTemplate: true, bodyTemplate: true, isActive: true },
    });
    if (!template?.isActive) {
      throw new BadRequestException('邮件模板已变化或未启用，请重新整理清单');
    }
    const rows = await this.loadOrderRows(mail.connectionId, mail.orderId);
    const recipient = this.resolveRecipient(rows);
    if (!recipient) throw new BadRequestException('乐天订单没有返回可用的买家匿名邮箱');
    const smtp = this.decryptSmtpCredentials(mail.connection);
    const rendered = this.renderTemplate(template, rows, mail.event);
    const manualReviewReason = this.manualMailReviewReason(mail.event, rows);
    return this.serializeMail({
      id: mail.id,
      connectionId: mail.connectionId,
      shopName: mail.connection.shop.name,
      orderId: mail.orderId,
      event: mail.event,
      recipient,
      fromAddress: smtp.fromAddress,
      fromName: smtp.fromName,
      bccAddresses: smtp.bccAddresses,
      templateVersion: template.version,
      orderFingerprint: this.mailOrderFingerprint(rows, mail.event),
      requiresManualReview: Boolean(manualReviewReason),
      manualReviewReason,
      subject: rendered.subject,
      body: rendered.body,
    });
  }

  async executeManualActions(selections: ManualAutomationSelection[]): Promise<unknown> {
    if (!Array.isArray(selections) || !selections.length) throw new BadRequestException('请选择要执行的任务');
    if (selections.length > 100) throw new BadRequestException('一次最多执行100个任务');
    const normalized = Array.from(new Map(selections.map((selection) => {
      const kind = String(selection?.kind || '').trim();
      if (kind !== 'shipping' && kind !== 'mail') throw new BadRequestException('任务类型只支持shipping或mail');
      const id = parseId(String(selection?.id || ''), 'jobId');
      const templateVersion = kind === 'mail' ? Number(selection?.templateVersion) : undefined;
      const orderFingerprint = kind === 'mail'
        ? String(selection?.orderFingerprint ?? '').trim().toLowerCase()
        : undefined;
      const manualReviewConfirmed = kind === 'mail' && selection?.manualReviewConfirmed === true;
      const bodyOverride = kind === 'mail' && selection?.bodyOverride !== undefined
        ? String(selection.bodyOverride)
        : undefined;
      if (kind === 'mail' && (!Number.isInteger(templateVersion) || Number(templateVersion) <= 0)) {
        throw new BadRequestException('邮件模板版本无效，请重新整理清单');
      }
      if (orderFingerprint && !/^[a-f0-9]{40}$/.test(orderFingerprint)) {
        throw new BadRequestException('订单预览版本无效，请重新预览邮件');
      }
      if (bodyOverride !== undefined && (!bodyOverride.trim() || bodyOverride.length > 50_000)) {
        throw new BadRequestException('人工确认的邮件正文不能为空或超过50000个字符');
      }
      return [`${kind}:${id.toString()}`, {
        kind,
        id,
        templateVersion,
        orderFingerprint,
        manualReviewConfirmed,
        bodyOverride,
      }];
    })).values());
    const shippingIds = normalized.filter((item) => item.kind === 'shipping').map((item) => item.id);
    const mailIds = normalized.filter((item) => item.kind === 'mail').map((item) => item.id);
    const [shippingRows, mailRows] = await Promise.all([
      this.prisma.rakutenOrderShippingReport.findMany({
        where: { id: { in: shippingIds } },
        include: { connection: { include: { shop: { select: { id: true, name: true } } } } },
      }),
      this.prisma.rakutenOrderMail.findMany({
        where: { id: { in: mailIds } },
        include: { connection: { include: { shop: { select: { id: true, name: true } } } } },
      }),
    ]);
    if (shippingRows.length !== shippingIds.length || mailRows.length !== mailIds.length) {
      throw new BadRequestException('部分任务已不存在，请刷新清单');
    }
    const eligibleKeys = await this.loadEligibleAutomationOrderKeys([
      ...shippingRows.map((row) => ({ connectionId: row.connectionId, orderId: row.orderId })),
      ...mailRows.map((row) => ({ connectionId: row.connectionId, orderId: row.orderId })),
    ]);
    const ineligibleRow = [...shippingRows, ...mailRows].find((row) =>
      !eligibleKeys.has(this.automationOrderKey(row.connectionId, row.orderId)));
    if (ineligibleRow) {
      throw new BadRequestException(`订单 ${ineligibleRow.orderId} 在2026年10月1日前导入，不适用单号回传和邮件发送功能`);
    }
    const now = new Date();
    for (const row of shippingRows) {
      if (!row.connection.autoShippingEnabled || row.connection.status !== 1 || row.connection.shippingCircuitOpenedAt) {
        throw new BadRequestException(`订单 ${row.orderId} 的单号回传当前不可执行`);
      }
      if ((row.status !== RakutenAutomationStatus.pending && row.status !== RakutenAutomationStatus.failed) || (row.nextAttemptAt && row.nextAttemptAt > now)) {
        throw new BadRequestException(`订单 ${row.orderId} 的单号回传状态已变化，请刷新清单`);
      }
      const orderRows = await this.loadOrderRows(row.connectionId, row.orderId);
      const executionCondition = shippingConditionReason(orderRows, row.fulfillmentType, await this.shippingPrerequisiteSatisfied(row.connectionId, row.orderId));
      if (executionCondition) throw new BadRequestException(executionCondition);
    }
    for (const row of mailRows) {
      if (!row.connection.mailNotificationsEnabled || row.connection.status !== 1 || row.connection.mailCircuitOpenedAt) {
        throw new BadRequestException(`订单 ${row.orderId} 的邮件当前不可执行`);
      }
      if ((row.status !== RakutenAutomationStatus.pending && row.status !== RakutenAutomationStatus.failed) || (row.nextAttemptAt && row.nextAttemptAt > now)) {
        throw new BadRequestException(`订单 ${row.orderId} 的邮件状态已变化，请刷新清单`);
      }
      const selected = normalized.find((item) => item.kind === 'mail' && item.id === row.id);
      const activeTemplate = await this.prisma.rakutenMailTemplateVersion.findFirst({
        where: { connectionId: row.connectionId, event: row.event, isActive: true },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      if (!activeTemplate || activeTemplate.version !== selected?.templateVersion) {
        throw new BadRequestException(`订单 ${row.orderId} 的邮件模板已变化或未配置，请重新整理清单`);
      }
      const orderRows = await this.loadOrderRows(row.connectionId, row.orderId);
      const requiresManualReview = this.requiresManualMailReview(row.event, orderRows);
      if (requiresManualReview && (
        !selected?.manualReviewConfirmed ||
        !selected.orderFingerprint ||
        selected.bodyOverride === undefined
      )) {
        throw new BadRequestException(`订单 ${row.orderId} 需要人工确认，请先点击待确认、确认邮件正文后再发送`);
      }
      if (!requiresManualReview && (selected?.manualReviewConfirmed || selected?.bodyOverride !== undefined)) {
        throw new BadRequestException(`订单 ${row.orderId} 无需人工修改邮件正文，请刷新清单`);
      }
      if (selected?.orderFingerprint && this.mailOrderFingerprint(orderRows, row.event) !== selected.orderFingerprint) {
        throw new BadRequestException(`订单 ${row.orderId} 在预览后已发生变化，请重新预览邮件后再发送`);
      }
    }
    const connectionIds = Array.from(new Set([
      ...shippingRows.map((row) => row.connectionId),
      ...mailRows.map((row) => row.connectionId),
    ]));
    const results: ConnectionAutomationRunResult[] = [];
    for (const connectionId of connectionIds) {
      const sourceRow = [...shippingRows, ...mailRows].find((row) => row.connectionId === connectionId);
      if (!sourceRow) throw new BadRequestException('任务所属乐天连接不存在，请刷新清单');
      const connection = sourceRow.connection;
      const lockToken = randomUUID();
      if (!(await this.acquireConnectionLock(connectionId, lockToken))) {
        throw new BadRequestException(`${connection.shop.name} 当前已有任务正在执行`);
      }
      const heartbeat = this.startConnectionLockHeartbeat(connectionId, lockToken);
      try {
        const run = await this.prisma.rakutenAutomationRun.create({
          data: { connectionId, trigger: RakutenAutomationRunTrigger.manual },
          select: { id: true },
        });
        const shipping = await this.processShippingReports(
          connectionId,
          shippingRows.filter((row) => row.connectionId === connectionId).map((row) => row.id),
        );
        const mail = await this.processMails(
          connectionId,
          mailRows.filter((row) => row.connectionId === connectionId).map((row) => row.id),
          new Map(normalized
            .filter((item) => item.kind === 'mail' && item.templateVersion &&
              mailRows.some((row) => row.id === item.id && row.connectionId === connectionId))
            .map((item) => [item.id.toString(), Number(item.templateVersion)])),
          new Map(normalized
            .filter((item) => item.kind === 'mail' && item.orderFingerprint &&
              mailRows.some((row) => row.id === item.id && row.connectionId === connectionId))
            .map((item) => [item.id.toString(), String(item.orderFingerprint)])),
          new Map(normalized
            .filter((item) => item.kind === 'mail' && item.manualReviewConfirmed && item.bodyOverride !== undefined &&
              mailRows.some((row) => row.id === item.id && row.connectionId === connectionId))
            .map((item) => [item.id.toString(), String(item.bodyOverride)])),
        );
        const failedJobs = shipping.failed + mail.failed;
        const completedJobs = shipping.sent + shipping.skipped + mail.sent;
        const status = failedJobs > 0 || mail.blocked > 0
          ? completedJobs > 0 || mail.blocked > 0 ? RakutenAutomationRunStatus.partial : RakutenAutomationRunStatus.failed
          : RakutenAutomationRunStatus.success;
        await this.prisma.rakutenAutomationRun.update({
          where: { id: run.id },
          data: {
            status,
            shippingSent: shipping.sent,
            shippingSkipped: shipping.skipped,
            shippingFailed: shipping.failed,
            mailSent: mail.sent,
            mailFailed: mail.failed,
            mailBlocked: mail.blocked,
            finishedAt: new Date(),
          },
        });
        results.push({
          connectionId: connectionId.toString(),
          shopName: connection.shop.name,
          runId: run.id.toString(),
          status,
          shipping,
          mail,
          errors: [],
        });
      } finally {
        clearInterval(heartbeat);
        await this.releaseConnectionLock(connectionId, lockToken);
      }
    }
    return this.serializeMail({ executed: normalized.length, results });
  }

  async runAutomation(
    connectionId?: bigint,
    trigger: RakutenAutomationRunTrigger = RakutenAutomationRunTrigger.manual,
    stage?: 'shipping' | 'mail',
  ): Promise<AutomationRunResult> {
    await this.recoverStaleJobs();
    const connections = await this.prisma.rakutenRmsConnection.findMany({
      where: {
        ...(connectionId ? { id: connectionId } : {}),
        status: 1,
        ...(stage === 'shipping' ? { autoShippingEnabled: true } : stage === 'mail' ? { mailNotificationsEnabled: true }
          : { OR: [{ autoShippingEnabled: true }, { mailNotificationsEnabled: true }] }),
      },
      include: { shop: { select: { id: true, name: true } } },
    });
    if (connectionId && !connections.length) {
      throw new NotFoundException('当前乐天连接不存在、已停用或未启用自动回传/邮件');
    }
    const connectionRuns: ConnectionAutomationRunResult[] = [];
    const shipping: ShippingRunCounts = { sent: 0, skipped: 0, failed: 0 };
    const mail: MailRunCounts = { sent: 0, failed: 0, blocked: 0 };
    let lockedConnections = 0;
    for (const connection of connections) {
      const lockToken = randomUUID();
      if (!(await this.acquireConnectionLock(connection.id, lockToken))) {
        lockedConnections += 1;
        continue;
      }
      const heartbeat = this.startConnectionLockHeartbeat(connection.id, lockToken);
      try {
        const result = await this.runConnectionAutomation(connection, trigger, stage);
        connectionRuns.push(result);
        shipping.sent += result.shipping.sent;
        shipping.skipped += result.shipping.skipped;
        shipping.failed += result.shipping.failed;
        mail.sent += result.mail.sent;
        mail.failed += result.mail.failed;
        mail.blocked += result.mail.blocked;
      } catch (error) {
        const message = this.errorMessage(error);
        this.logger.error(
          `Rakuten automation connection ${connection.id.toString()} failed unexpectedly: ${message}`,
        );
        connectionRuns.push({
          connectionId: connection.id.toString(),
          shopName: connection.shop.name,
          runId: '',
          status: RakutenAutomationRunStatus.failed,
          shipping: { sent: 0, skipped: 0, failed: 0 },
          mail: { sent: 0, failed: 0, blocked: 0 },
          errors: [`运行记录或执行初始化失败：${message}`],
        });
      } finally {
        clearInterval(heartbeat);
        await this.releaseConnectionLock(connection.id, lockToken);
      }
    }
    return {
      alreadyRunning: Boolean(connectionId && lockedConnections === connections.length),
      lockedConnections,
      shippingReports: shipping.sent,
      mails: mail.sent,
      shipping,
      mail,
      connectionRuns,
    };
  }

  private async acquireConnectionLock(connectionId: bigint, lockToken: string): Promise<boolean> {
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
    const result = await this.prisma.rakutenRmsConnection.updateMany({
      where: {
        id: connectionId,
        OR: [
          { automationLockToken: null },
          { automationLockedAt: null },
          { automationLockedAt: { lt: staleBefore } },
        ],
      },
      data: { automationLockToken: lockToken, automationLockedAt: new Date() },
    });
    if (result.count === 1) this.ownedLocks.set(connectionId, { token: lockToken, lost: false });
    return result.count === 1;
  }

  private async shippingPrerequisiteSatisfied(connectionId: bigint, orderId: string): Promise<boolean> {
    const mail = await this.prisma.rakutenOrderMail.findUnique({ where: { connectionId_orderId_event: { connectionId, orderId, event: RakutenOrderMailEvent.new_order } } });
    return mailSatisfied(mail);
  }

  private async assertExecutionLock(connectionId: bigint): Promise<void> {
    const owned = this.ownedLocks.get(connectionId);
    if (!owned || owned.lost) throw new Error("执行锁已失效，停止后续操作");
    const result = await this.prisma.rakutenRmsConnection.updateMany({
      where: { id: connectionId, automationLockToken: owned.token },
      data: { automationLockedAt: new Date() },
    });
    if (result.count !== 1) { owned.lost = true; throw new Error("执行锁已失效，停止后续操作"); }
  }

  private startConnectionLockHeartbeat(connectionId: bigint, lockToken: string): ReturnType<typeof setInterval> {
    this.ownedLocks.set(connectionId, { token: lockToken, lost: false });
    return setInterval(() => {
      void this.prisma.rakutenRmsConnection.updateMany({
        where: { id: connectionId, automationLockToken: lockToken },
        data: { automationLockedAt: new Date() },
      }).then((result) => {
        if (result.count !== 1) {
          const owned = this.ownedLocks.get(connectionId);
          if (owned?.token === lockToken) owned.lost = true;
          this.logger.error(`Rakuten automation lock lost for connection ${connectionId.toString()}`);
        }
      }).catch((error) => {
        const owned = this.ownedLocks.get(connectionId);
        if (owned?.token === lockToken) owned.lost = true;
        this.logger.error(
          `Rakuten automation lock heartbeat failed for connection ${connectionId.toString()}: ${this.errorMessage(error)}`,
        );
      });
    }, AUTOMATION_LOCK_HEARTBEAT_MS);
  }

  private async releaseConnectionLock(connectionId: bigint, lockToken: string): Promise<void> {
    if (this.ownedLocks.get(connectionId)?.token === lockToken) this.ownedLocks.delete(connectionId);
    try {
      await this.prisma.rakutenRmsConnection.updateMany({
        where: { id: connectionId, automationLockToken: lockToken },
        data: { automationLockToken: null, automationLockedAt: null },
      });
    } catch (error) {
      this.logger.error(
        `Rakuten automation lock release failed for connection ${connectionId.toString()}: ${this.errorMessage(error)}`,
      );
    }
  }

  private isConnectionLockActive(connection: {
    automationLockToken: string | null;
    automationLockedAt: Date | null;
  }): boolean {
    return Boolean(
      connection.automationLockToken &&
      connection.automationLockedAt &&
      connection.automationLockedAt.getTime() >= Date.now() - STALE_PROCESSING_MS,
    );
  }

  private async runConnectionAutomation(
    connection: ConnectionWithShop,
    trigger: RakutenAutomationRunTrigger,
    stage?: 'shipping' | 'mail',
  ): Promise<ConnectionAutomationRunResult> {
    const run = await this.prisma.rakutenAutomationRun.create({
      data: { connectionId: connection.id, trigger },
      select: { id: true },
    });
    const shipping: ShippingRunCounts = { sent: 0, skipped: 0, failed: 0 };
    const mail: MailRunCounts = { sent: 0, failed: 0, blocked: 0 };
    const errors: string[] = [];
    if (stage !== 'mail' && connection.autoShippingEnabled && connection.shippingCircuitOpenedAt) {
      errors.push(`单号回传阶段已暂停：${connection.shippingCircuitReason || '检测到店铺级配置错误'}`);
    } else if (stage !== 'mail' && connection.autoShippingEnabled) {
      try {
        await this.prepareShippingReports(connection);
        Object.assign(shipping, await this.processShippingReports(connection.id));
      } catch (error) {
        errors.push(`单号回传阶段：${this.errorMessage(error)}`);
      }
    }
    if (stage !== 'shipping') try {
      await this.prepareTrackingMails(connection);
      await this.prepareCustomsMails(connection);
    } catch (error) { errors.push(`邮件任务整理：${this.errorMessage(error)}`); }
    if (stage !== 'shipping' && connection.mailNotificationsEnabled && connection.mailCircuitOpenedAt) {
      errors.push(`邮件阶段已暂停：${connection.mailCircuitReason || '检测到店铺级配置错误'}`);
    } else if (stage !== 'shipping' && connection.mailNotificationsEnabled) {
      try {
        await this.refreshMailHolds(connection.id);
        Object.assign(mail, await this.processMails(connection.id));
      } catch (error) {
        errors.push(`邮件阶段：${this.errorMessage(error)}`);
      }
    }
    const failedJobs = shipping.failed + mail.failed;
    const completedJobs = shipping.sent + shipping.skipped + mail.sent;
    const hasIssue = errors.length > 0 || failedJobs > 0 || mail.blocked > 0;
    const status = hasIssue
      ? completedJobs === 0 && mail.blocked === 0
        ? RakutenAutomationRunStatus.failed
        : RakutenAutomationRunStatus.partial
      : RakutenAutomationRunStatus.success;
    await this.prisma.rakutenAutomationRun.update({
      where: { id: run.id },
      data: {
        status,
        shippingSent: shipping.sent,
        shippingSkipped: shipping.skipped,
        shippingFailed: shipping.failed,
        mailSent: mail.sent,
        mailFailed: mail.failed,
        mailBlocked: mail.blocked,
        errorMessage: errors.length ? errors.join('\n') : null,
        finishedAt: new Date(),
      },
    });
    return {
      connectionId: connection.id.toString(),
      shopName: connection.shop.name,
      runId: run.id.toString(),
      status,
      shipping,
      mail,
      errors,
    };
  }

  private async recoverStaleJobs(): Promise<void> {
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
    const disconnected = { OR: [{ automationLockToken: null }, { automationLockedAt: null }, { automationLockedAt: { lt: staleBefore } }] };
    await this.prisma.$transaction([
      this.prisma.rakutenOrderShippingReport.updateMany({
        where: { connection: disconnected, status: RakutenAutomationStatus.processing, updatedAt: { lt: staleBefore } },
        data: {
          status: RakutenAutomationStatus.failed,
          nextAttemptAt: new Date(),
          lastError: '上次自动回传执行中断，已自动恢复并重新核对乐天侧状态',
        },
      }),
      this.prisma.rakutenOrderMail.updateMany({
        where: {
          connection: disconnected,
          status: RakutenAutomationStatus.processing,
          sendStartedAt: null,
          updatedAt: { lt: staleBefore },
        },
        data: {
          status: RakutenAutomationStatus.failed,
          nextAttemptAt: new Date(),
          lastError: '上次任务在连接SMTP前中断，已安全恢复重试',
        },
      }),
      this.prisma.rakutenOrderMail.updateMany({
        where: {
          connection: disconnected,
          status: RakutenAutomationStatus.processing,
          sendStartedAt: { not: null },
          updatedAt: { lt: staleBefore },
        },
        data: {
          status: RakutenAutomationStatus.uncertain,
          nextAttemptAt: null,
          lastError: 'SMTP发送开始后任务中断，结果可能已送达；为避免重复邮件，必须人工确认',
        },
      }),
      this.prisma.rakutenAutomationRun.updateMany({
        where: { connection: disconnected, status: RakutenAutomationRunStatus.running, startedAt: { lt: staleBefore } },
        data: {
          status: RakutenAutomationRunStatus.failed,
          errorMessage: '执行者已失联且运行记录超过30分钟未结束，已标记为中断',
          finishedAt: new Date(),
        },
      }),
      this.prisma.rakutenRmsConnection.updateMany({
        where: { automationLockedAt: { lt: staleBefore } },
        data: { automationLockToken: null, automationLockedAt: null },
      }),
    ]);
  }

  async getSummary(): Promise<unknown> {
    const lockActiveAfter = new Date(Date.now() - STALE_PROCESSING_MS);
    const [shippingByStatus, mailByStatus, shippingErrors, mailErrors, activeLocks] = await Promise.all([
      this.prisma.rakutenOrderShippingReport.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.rakutenOrderMail.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.rakutenOrderShippingReport.findMany({
        where: { status: { in: [RakutenAutomationStatus.failed, RakutenAutomationStatus.dead_letter] } },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: {
          orderId: true, status: true, attempts: true, lastError: true,
          failureCategory: true, deadLetteredAt: true, nextAttemptAt: true,
        },
      }),
      this.prisma.rakutenOrderMail.findMany({
        where: {
          status: {
            in: [
              RakutenAutomationStatus.failed,
              RakutenAutomationStatus.uncertain,
              RakutenAutomationStatus.dead_letter,
            ],
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: {
          orderId: true, event: true, status: true, attempts: true, lastError: true,
          failureCategory: true, deadLetteredAt: true, nextAttemptAt: true,
        },
      }),
      this.prisma.rakutenRmsConnection.count({
        where: { automationLockToken: { not: null }, automationLockedAt: { gte: lockActiveAfter } },
      }),
    ]);
    return {
      cron: RAKUTEN_ORDER_PROCESSING_CRON,
      timezone: AUTOMATION_TIMEZONE,
      running: activeLocks > 0,
      activeConnections: activeLocks,
      shipping: Object.fromEntries(shippingByStatus.map((row) => [row.status, row._count._all])),
      mail: Object.fromEntries(mailByStatus.map((row) => [row.status, row._count._all])),
      shippingErrors,
      mailErrors,
    };
  }

  async getAutomationHealth(connectionIdRaw?: string): Promise<unknown> {
    const connectionId = String(connectionIdRaw || '').trim()
      ? parseId(String(connectionIdRaw), 'connectionId')
      : null;
    const connectionWhere = connectionId ? { connectionId } : {};
    const taskWhere = { ...connectionWhere, createdAt: { gte: AUTOMATION_ORDER_IMPORT_CUTOFF } };
    const staleBefore = new Date(Date.now() - 30 * 60_000);
    const [
      connections,
      shippingCounts,
      mailCounts,
      staleShipping,
      staleMail,
      oldestShipping,
      oldestMail,
      lastShippingSuccess,
      lastMailSuccess,
    ] = await Promise.all([
      this.prisma.rakutenRmsConnection.findMany({
        where: connectionId ? { id: connectionId } : {},
        orderBy: { id: 'asc' },
        select: {
          id: true,
          status: true,
          syncOrders: true,
          autoShippingEnabled: true,
          mailNotificationsEnabled: true,
          smtpAuthId: true,
          encryptedSmtpPassword: true,
          smtpPasswordIv: true,
          smtpPasswordAuthTag: true,
          smtpFromAddress: true,
          licenseExpiresAt: true,
          lastSuccessfulSyncAt: true,
          lastSyncError: true,
          automationLockToken: true,
          automationLockedAt: true,
          shippingCircuitOpenedAt: true,
          shippingCircuitReason: true,
          mailCircuitOpenedAt: true,
          mailCircuitReason: true,
          shop: { select: { id: true, name: true } },
        },
      }),
      this.prisma.rakutenOrderShippingReport.groupBy({
        by: ['connectionId', 'status'],
        where: taskWhere,
        _count: { _all: true },
      }),
      this.prisma.rakutenOrderMail.groupBy({
        by: ['connectionId', 'status'],
        where: taskWhere,
        _count: { _all: true },
      }),
      this.prisma.rakutenOrderShippingReport.groupBy({
        by: ['connectionId'],
        where: {
          ...connectionWhere,
          status: RakutenAutomationStatus.pending,
          createdAt: { gte: AUTOMATION_ORDER_IMPORT_CUTOFF, lt: staleBefore },
        },
        _count: { _all: true },
      }),
      this.prisma.rakutenOrderMail.groupBy({
        by: ['connectionId'],
        where: {
          ...connectionWhere,
          status: RakutenAutomationStatus.pending,
          createdAt: { gte: AUTOMATION_ORDER_IMPORT_CUTOFF, lt: staleBefore },
        },
        _count: { _all: true },
      }),
      this.prisma.rakutenOrderShippingReport.groupBy({
        by: ['connectionId'],
        where: { ...taskWhere, status: { in: [RakutenAutomationStatus.pending, RakutenAutomationStatus.failed, RakutenAutomationStatus.dead_letter, RakutenAutomationStatus.uncertain] } },
        _min: { createdAt: true },
      }),
      this.prisma.rakutenOrderMail.groupBy({
        by: ['connectionId'],
        where: { ...taskWhere, status: { in: [RakutenAutomationStatus.pending, RakutenAutomationStatus.failed, RakutenAutomationStatus.dead_letter, RakutenAutomationStatus.uncertain] } },
        _min: { createdAt: true },
      }),
      this.prisma.rakutenOrderShippingReport.groupBy({
        by: ['connectionId'],
        where: { ...taskWhere, status: RakutenAutomationStatus.sent },
        _max: { reportedAt: true },
      }),
      this.prisma.rakutenOrderMail.groupBy({
        by: ['connectionId'],
        where: { ...taskWhere, status: RakutenAutomationStatus.sent },
        _max: { sentAt: true },
      }),
    ]);
    const diagnostics = await Promise.all(connections.map(async (connection) => {
      const [runs, templates] = await Promise.all([
        this.prisma.rakutenAutomationRun.findMany({ where: { connectionId: connection.id, status: { not: RakutenAutomationRunStatus.running } }, orderBy: { startedAt: 'desc' }, take: 100 }),
        this.prisma.rakutenMailTemplateVersion.findMany({ where: { connectionId: connection.id, isActive: true } }),
      ]);
      let noProgressRounds = 0;
      for (const run of runs) { if (run.shippingSent > 0 || run.mailSent > 0) break; noProgressRounds += 1; }
      const templateIssues = templates.flatMap((template) => {
        try { this.validateMailTemplate(template, template.event); return []; }
        catch (error) { return [{ event: template.event, version: template.version, reason: this.errorMessage(error) }]; }
      });
      return { connectionId: connection.id.toString(), noProgressRounds, historyLimitReached: noProgressRounds === 100, templateIssues };
    }));
    const statusMap = (
      rows: Array<{ connectionId: bigint; status: RakutenAutomationStatus; _count: { _all: number } }>,
    ) => {
      const mapped = new Map<string, Record<string, number>>();
      for (const row of rows) {
        const key = row.connectionId.toString();
        const counts = mapped.get(key) ?? {};
        counts[row.status] = row._count._all;
        mapped.set(key, counts);
      }
      return mapped;
    };
    const countMap = (rows: Array<{ connectionId: bigint; _count: { _all: number } }>) =>
      new Map(rows.map((row) => [row.connectionId.toString(), row._count._all]));
    const dateMap = <T extends { connectionId: bigint }>(
      rows: T[],
      value: (row: T) => Date | null,
    ) => new Map(rows.map((row) => [row.connectionId.toString(), value(row)]));
    const shippingByConnection = statusMap(shippingCounts);
    const mailByConnection = statusMap(mailCounts);
    const staleShippingMap = countMap(staleShipping);
    const staleMailMap = countMap(staleMail);
    const oldestShippingMap = dateMap(oldestShipping, (row) => row._min.createdAt);
    const oldestMailMap = dateMap(oldestMail, (row) => row._min.createdAt);
    const lastShippingMap = dateMap(lastShippingSuccess, (row) => row._max.reportedAt);
    const lastMailMap = dateMap(lastMailSuccess, (row) => row._max.sentAt);
    const items = connections.map((connection) => {
      const key = connection.id.toString();
      const shipping = shippingByConnection.get(key) ?? {};
      const mail = mailByConnection.get(key) ?? {};
      const staleShippingCount = staleShippingMap.get(key) ?? 0;
      const staleMailCount = staleMailMap.get(key) ?? 0;
      const smtpReady = Boolean(
        connection.smtpAuthId &&
        connection.encryptedSmtpPassword &&
        connection.smtpPasswordIv &&
        connection.smtpPasswordAuthTag &&
        connection.smtpFromAddress,
      );
      const licenseDaysRemaining = connection.licenseExpiresAt
        ? Math.ceil((connection.licenseExpiresAt.getTime() - Date.now()) / 86_400_000)
        : null;
      const diagnostic = diagnostics.find((item) => item.connectionId === key)!;
      const oldest = [oldestShippingMap.get(key), oldestMailMap.get(key)].filter((value): value is Date => Boolean(value)).sort((a, b) => a.getTime() - b.getTime())[0];
      const oldestWaitingMinutes = oldest ? Math.max(0, Math.floor((Date.now() - oldest.getTime()) / 60_000)) : 0;
      const backlog = Boolean(oldest);
      const alerts: string[] = [];
      let health: 'healthy' | 'warning' | 'critical' | 'disabled' = 'healthy';
      const warn = (message: string, critical = false) => {
        alerts.push(message);
        if (critical) health = 'critical';
        else if (health === 'healthy') health = 'warning';
      };
      if (
        connection.status !== 1 ||
        (!connection.syncOrders && !connection.autoShippingEnabled && !connection.mailNotificationsEnabled)
      ) {
        health = 'disabled';
      } else {
        if (connection.mailNotificationsEnabled && !smtpReady) warn('邮件通知已启用，但SMTP配置不完整', true);
        if (connection.shippingCircuitOpenedAt) {
          warn(`自动回传已暂停：${connection.shippingCircuitReason || '店铺级配置错误'}`, true);
        }
        if (connection.mailCircuitOpenedAt) {
          warn(`邮件发送已暂停：${connection.mailCircuitReason || '店铺级配置错误'}`, true);
        }
        if ((connection.syncOrders || connection.autoShippingEnabled) && licenseDaysRemaining === null) {
          warn('未登记License到期日');
        } else if ((connection.syncOrders || connection.autoShippingEnabled) && licenseDaysRemaining !== null) {
          if (licenseDaysRemaining < 0) warn('RMS API License已到期', true);
          else if (licenseDaysRemaining <= 14) warn(`RMS API License将在${licenseDaysRemaining}天内到期`);
        }
        if (Number(mail.uncertain ?? 0) > 0) warn(`有${mail.uncertain}封邮件发送结果待人工确认`, true);
        if (Number(mail.dead_letter ?? 0) > 0) warn(`有${mail.dead_letter}封邮件需要人工处理`, true);
        if (Number(shipping.dead_letter ?? 0) > 0) warn(`有${shipping.dead_letter}个单号回传需要人工处理`, true);
        if (Number(mail.failed ?? 0) > 0) warn(`有${mail.failed}封邮件发送失败`);
        if (Number(shipping.failed ?? 0) > 0) warn(`有${shipping.failed}个单号回传失败`);
        if (staleMailCount > 0) warn(`有${staleMailCount}封邮件待处理超过30分钟`);
        if (staleShippingCount > 0) warn(`有${staleShippingCount}个单号回传待处理超过30分钟`);
        if (connection.lastSyncError) warn('最近一次订单同步存在错误');
        for (const issue of diagnostic.templateIssues) warn(`${issue.event} 模板v${issue.version}需修订并明确启用新版：${issue.reason}`, true);
        if (backlog && diagnostic.noProgressRounds >= 3) warn(`存在积压，最近${diagnostic.noProgressRounds}轮无回传或邮件完成`);
      }
      return {
        connectionId: key,
        shop: this.serializeMail(connection.shop),
        health,
        alerts,
        running: this.isConnectionLockActive(connection),
        circuits: {
          shipping: {
            open: Boolean(connection.shippingCircuitOpenedAt),
            openedAt: connection.shippingCircuitOpenedAt?.toISOString() ?? null,
            reason: connection.shippingCircuitReason,
          },
          mail: {
            open: Boolean(connection.mailCircuitOpenedAt),
            openedAt: connection.mailCircuitOpenedAt?.toISOString() ?? null,
            reason: connection.mailCircuitReason,
          },
        },
        features: {
          connectionEnabled: connection.status === 1,
          syncOrders: connection.syncOrders,
          autoShipping: connection.autoShippingEnabled,
          mailNotifications: connection.mailNotificationsEnabled,
          smtpReady,
        },
        licenseExpiresAt: connection.licenseExpiresAt?.toISOString() ?? null,
        licenseDaysRemaining,
        lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt?.toISOString() ?? null,
        lastSyncError: connection.lastSyncError,
        shipping,
        mail,
        stale: { shipping: staleShippingCount, mail: staleMailCount },
        backlog: { oldestWaitingMinutes, noProgressRounds: backlog ? diagnostic.noProgressRounds : 0, historyLimitReached: diagnostic.historyLimitReached, oldestWaitingAt: oldest?.toISOString() ?? null },
        templateIssues: diagnostic.templateIssues,
        oldestPendingAt: {
          shipping: oldestShippingMap.get(key)?.toISOString() ?? null,
          mail: oldestMailMap.get(key)?.toISOString() ?? null,
        },
        lastSuccessAt: {
          shipping: lastShippingMap.get(key)?.toISOString() ?? null,
          mail: lastMailMap.get(key)?.toISOString() ?? null,
        },
      };
    });
    const healthCounts = items.reduce<Record<string, number>>((counts, item) => {
      counts[item.health] = (counts[item.health] ?? 0) + 1;
      return counts;
    }, {});
    return {
      checkedAt: new Date().toISOString(),
      staleThresholdMinutes: 30,
      running: items.some((item) => item.running),
      activeConnections: items.filter((item) => item.running).length,
      summary: healthCounts,
      items,
    };
  }

  private async prepareShippingReports(connection: ConnectionWithShop): Promise<void> {
    const cursorKey = `shipping:${connection.id}`;
    const cursor = this.candidateCursors.get(cursorKey) ?? '';
    const candidates = await this.prisma.$queryRaw<Array<{ orderId: string }>>(Prisma.sql`
      SELECT DISTINCT COALESCE(records.rms_order_id, records.order_id) AS orderId
      FROM rakuten_order_records records
      LEFT JOIN rakuten_order_shipping_reports reports
        ON reports.connection_id = records.rms_connection_id
        AND reports.order_id = COALESCE(records.rms_order_id, records.order_id)
      WHERE records.deleted_at IS NULL AND records.rms_connection_id = ${connection.id}
        AND records.source_kind = 'rms_api'
        AND records.created_at >= ${AUTOMATION_ORDER_IMPORT_CUTOFF}
        AND NOT EXISTS (
          SELECT 1
          FROM rakuten_order_records older_records
          WHERE older_records.rms_connection_id = records.rms_connection_id
            AND COALESCE(older_records.rms_order_id, older_records.order_id) = COALESCE(records.rms_order_id, records.order_id)
            AND older_records.created_at < ${AUTOMATION_ORDER_IMPORT_CUTOFF}
        )
        AND COALESCE(records.rms_order_id, records.order_id) IS NOT NULL
        AND COALESCE(records.rms_order_id, records.order_id) > ${cursor}
        AND records.shipment_no IS NOT NULL
        AND records.shipment_no <> ''
        AND reports.id IS NULL
      ORDER BY COALESCE(records.rms_order_id, records.order_id) ASC
      LIMIT 500
    `);
    this.candidateCursors.set(cursorKey, candidates.length >= 500 ? String(candidates[candidates.length - 1].orderId) : '');
    for (const candidate of candidates) {
      try {

        const orderId = String(candidate.orderId ?? '').trim();
        if (!orderId) continue;
        const existing = await this.prisma.rakutenOrderShippingReport.findUnique({
          where: { connectionId_orderId: { connectionId: connection.id, orderId } },
          select: { id: true },
        });
        if (existing) continue;
        const rows = await this.loadOrderRows(connection.id, orderId);
        const fulfillmentType = fulfillmentOf(rows);
        if (shippingConditionReason(rows, fulfillmentType, true)) continue;
        const fingerprint = shippingFingerprint(rows, fulfillmentType);
        await this.prisma.rakutenOrderShippingReport.create({
          data: { connectionId: connection.id, orderId, fulfillmentType, fingerprint },
        }).catch((error: unknown) => {
          if (!this.isUniqueConstraintError(error)) throw error;
        });
      } catch (error) {
        this.logger.error(`Rakuten prepareShippingReports 单笔处理失败：${this.errorMessage(error)}`);
      }
    }
  }

  private async processShippingReports(connectionId?: bigint, selectedIds?: bigint[]): Promise<ShippingRunCounts> {
    const cursorKey = `shipping_jobs:${connectionId ?? 'all'}`;
    const cursor = selectedIds ? 0n : BigInt(this.candidateCursors.get(cursorKey) ?? '0');
    const rows = await this.prisma.rakutenOrderShippingReport.findMany({
      where: {
        ...(connectionId ? { connectionId } : {}),
        ...(selectedIds ? { id: { in: selectedIds } } : { id: { gt: cursor } }),
        status: { in: [RakutenAutomationStatus.pending, RakutenAutomationStatus.failed] },
        attempts: { lt: MAX_ATTEMPTS },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
        connection: { status: 1, autoShippingEnabled: true },
      },
      orderBy: { id: 'asc' },
      take: selectedIds ? selectedIds.length : 50,
      include: { connection: { include: { shop: { select: { id: true, name: true } } } } },
    });
    if (!selectedIds) this.candidateCursors.set(cursorKey, rows.length >= 50 ? rows[rows.length - 1].id.toString() : '0');
    const counts: ShippingRunCounts = { sent: 0, skipped: 0, failed: 0 };
    for (const report of rows) {
      await this.assertExecutionLock(report.connectionId);
      try {

        const latestRows = await this.loadOrderRows(report.connectionId, report.orderId);
        if (!await this.isAutomationEligibleOrder(latestRows)) { await this.markShippingSkipped(report.id, '订单在2026年10月1日前导入，不适用单号回传'); counts.skipped += 1; continue; }
        const condition = shippingConditionReason(latestRows, report.fulfillmentType, await this.shippingPrerequisiteSatisfied(report.connectionId, report.orderId));
        if (condition) {
          const manual = Boolean(orderBlockReason(latestRows) || fulfillmentOf(latestRows) !== report.fulfillmentType);
          await this.prisma.rakutenOrderShippingReport.update({ where: { id: report.id }, data: {
            ...(manual ? { status: RakutenAutomationStatus.dead_letter, deadLetteredAt: new Date() } : {}),
            nextAttemptAt: manual ? null : new Date(Date.now() + 20 * 60_000), failureCategory: manual ? 'order_changed' : 'waiting_conditions', lastError: condition,
          } });
          if (manual) counts.failed += 1;
          continue;
        }
        const claimed = await this.prisma.rakutenOrderShippingReport.updateMany({
          where: {
            id: report.id,
            status: { in: [RakutenAutomationStatus.pending, RakutenAutomationStatus.failed] },
          },
          data: {
            status: RakutenAutomationStatus.processing,
            attempts: { increment: 1 },
            lastError: null,
            failureCategory: null,
            deadLetteredAt: null,
          },
        });
        if (claimed.count !== 1) continue;
        try {
          const orderRows = await this.loadOrderRows(report.connectionId, report.orderId);
          const finalCondition = shippingConditionReason(orderRows, report.fulfillmentType, await this.shippingPrerequisiteSatisfied(report.connectionId, report.orderId));
          if (finalCondition) throw new BadRequestException(finalCondition);
          if (!await this.isAutomationEligibleOrder(orderRows)) {
            await this.markShippingSkipped(report.id, '订单在2026年10月1日前导入，不适用自动单号回传');
            counts.skipped += 1;
            continue;
          }
          const fulfillmentType = report.fulfillmentType as FulfillmentType;
          const selectedRows = this.shippingTargetRows(orderRows, fulfillmentType);
          const baskets = this.buildShippingBaskets(selectedRows);
          const credentials = this.decryptApiCredentials(report.connection);
          const currentOrders = await this.client.getOrders(
            credentials.serviceSecret,
            credentials.licenseKey,
            [report.orderId],
          );
          const currentOrder = this.resolveCurrentOrder(currentOrders, report.orderId);
          if (!currentOrder) throw new Error('乐天 getOrder 未返回目标订单，已停止回传并等待重试');
          const alreadyReported = this.shippingAlreadyReported([currentOrder], baskets);
          const previousPayload = this.jsonObject(report.responsePayload);
          const previousRequest = previousPayload?.wmsUpdateRequestedAt && previousPayload.wmsRequestFingerprint === shippingFingerprint(orderRows, fulfillmentType);
          if (alreadyReported && !previousRequest) {
            const markVerified = this.prisma.rakutenOrderShippingReport.update({ where: { id: report.id }, data: {
              status: RakutenAutomationStatus.skipped, lastError: VERIFIED_SHIPPING,
              fingerprint: shippingFingerprint(orderRows, fulfillmentType), nextAttemptAt: null, failureCategory: null, deadLetteredAt: null,
            } });
            if (fulfillmentType === 'japan') {
              await this.prisma.$transaction([
                markVerified,
                this.prisma.rakutenOrderMail.upsert({
                  where: { connectionId_orderId_event: { connectionId: report.connectionId, orderId: report.orderId, event: RakutenOrderMailEvent.japan_shipped } },
                  create: { connectionId: report.connectionId, orderId: report.orderId, event: RakutenOrderMailEvent.japan_shipped,
                    status: RakutenAutomationStatus.uncertain, failureCategory: 'external_shipping',
                    lastError: '乐天已有日本侧单号，请核实外部是否已发送邮件，再确认已发送或确认重发' }, update: {},
                }),
                this.prisma.rakutenOrderMail.updateMany({ where: {
                  connectionId: report.connectionId, orderId: report.orderId, event: RakutenOrderMailEvent.japan_shipped,
                  status: { in: [RakutenAutomationStatus.pending, RakutenAutomationStatus.failed] },
                }, data: { status: RakutenAutomationStatus.uncertain, nextAttemptAt: null, failureCategory: 'external_shipping',
                  lastError: '乐天已有日本侧单号，请核实外部是否已发送邮件，再确认已发送或确认重发' } }),
              ]);
            } else {
              await markVerified;
            }
            counts.skipped += 1;
            continue;
          }
          const orderProgress = this.resolveOrderProgress(currentOrder);
          if (!alreadyReported && orderProgress === null) {
            throw new Error('乐天 getOrder 响应缺少 orderProgress，无法确认订单仍为待発送');
          }
          if (!alreadyReported && orderProgress !== PENDING_SHIPMENT_ORDER_PROGRESS) {
            await this.markShippingSkipped(
              report.id,
              `乐天订单当前状态为 ${orderProgress}，不是待発送（${PENDING_SHIPMENT_ORDER_PROGRESS}），已停止自动回传`,
            );
            counts.skipped += 1;
            continue;
          }
          await this.assertExecutionLock(report.connectionId);
          if (!alreadyReported) {
            await this.prisma.rakutenOrderShippingReport.update({ where: { id: report.id }, data: {
              responsePayload: { wmsUpdateRequestedAt: new Date().toISOString(), wmsRequestFingerprint: shippingFingerprint(orderRows, fulfillmentType) },
            } });
          }
          await this.assertExecutionLock(report.connectionId);
          const response = alreadyReported
            ? { MessageModelList: [], alreadyReportedAfterRetry: true }
            : await this.client.updateOrderShipping(
              credentials.serviceSecret,
              credentials.licenseKey,
              report.orderId,
              baskets,
            );
          const markSent = this.prisma.rakutenOrderShippingReport.update({
            where: { id: report.id },
            data: {
              status: RakutenAutomationStatus.sent,
              reportedAt: new Date(),
              fingerprint: shippingFingerprint(orderRows, fulfillmentType),
              nextAttemptAt: null,
              lastError: null,
              failureCategory: null,
              deadLetteredAt: null,
              responsePayload: response as Prisma.InputJsonValue,
            },
          });
          if (fulfillmentType === 'japan') {
            await this.prisma.$transaction([
              markSent,
              this.prisma.rakutenOrderMail.upsert({
                where: {
                  connectionId_orderId_event: {
                    connectionId: report.connectionId,
                    orderId: report.orderId,
                    event: RakutenOrderMailEvent.japan_shipped,
                  },
                },
                create: {
                  connectionId: report.connectionId,
                  orderId: report.orderId,
                  event: RakutenOrderMailEvent.japan_shipped,
                },
                update: {},
              }),
            ]);
          } else {
            await markSent;
          }
          counts.sent += 1;
        } catch (error) {
          const handling = await this.markShippingFailed(report.id, report.attempts + 1, error);
          counts.failed += 1;
          if (this.shouldOpenCircuit(handling)) {
            await this.openCircuit(report.connectionId, 'shipping', this.errorMessage(error));
            break;
          }
        }
      } catch (error) {
        this.logger.error(`Rakuten processShippingReports 单笔处理失败：${this.errorMessage(error)}`);
        counts.failed += 1;
      }
    }
    return counts;
  }

  private async prepareTrackingMails(connection: ConnectionWithShop): Promise<void> {
    const cursorKey = `tracking:${connection.id}`;
    const cursor = this.candidateCursors.get(cursorKey) ?? '';
    const candidates = await this.prisma.$queryRaw<Array<{ orderId: string }>>(Prisma.sql`
      SELECT DISTINCT COALESCE(records.rms_order_id, records.order_id) AS orderId
      FROM rakuten_order_records records
      LEFT JOIN rakuten_order_mails mails
        ON mails.connection_id = records.rms_connection_id
        AND mails.order_id = COALESCE(records.rms_order_id, records.order_id)
        AND mails.event IN ('china_delay', 'mixed_partial')
      WHERE records.deleted_at IS NULL AND records.rms_connection_id = ${connection.id}
        AND records.source_kind = 'rms_api'
        AND records.created_at >= ${AUTOMATION_ORDER_IMPORT_CUTOFF}
        AND NOT EXISTS (
          SELECT 1
          FROM rakuten_order_records older_records
          WHERE older_records.rms_connection_id = records.rms_connection_id
            AND COALESCE(older_records.rms_order_id, older_records.order_id) = COALESCE(records.rms_order_id, records.order_id)
            AND older_records.created_at < ${AUTOMATION_ORDER_IMPORT_CUTOFF}
        )
        AND COALESCE(records.rms_order_id, records.order_id) IS NOT NULL
        AND COALESCE(records.rms_order_id, records.order_id) > ${cursor}
        AND records.shipment_no IS NOT NULL
        AND records.shipment_no <> ''
        AND mails.id IS NULL
      ORDER BY COALESCE(records.rms_order_id, records.order_id) ASC
      LIMIT 500
    `);
    this.candidateCursors.set(cursorKey, candidates.length >= 500 ? String(candidates[candidates.length - 1].orderId) : '');
    for (const candidate of candidates) {
      try {

        const orderId = String(candidate.orderId ?? '').trim();
        if (!orderId) continue;
        const rows = await this.loadOrderRows(connection.id, orderId);
        if (orderBlockReason(rows)) continue;
        const fulfillmentType = fulfillmentOf(rows);
        if (fulfillmentType === 'japan') continue;
        const targetRows = fulfillmentType === 'china'
          ? rows.filter((row) => isChinaRow(row))
          : rows.filter((row) => !isChinaRow(row));
        if (fulfillmentType === 'mixed' && !japanWarehouseReady(targetRows)) continue;
        if (!trackingReady(targetRows)) continue;
        const prerequisite = await this.prisma.rakutenOrderMail.findUnique({
          where: {
            connectionId_orderId_event: {
              connectionId: connection.id,
              orderId,
              event: RakutenOrderMailEvent.new_order,
            },
          },
          select: { status: true, resolutionNote: true },
        });
        if (!mailSatisfied(prerequisite)) continue;
        const event = fulfillmentType === 'china'
          ? RakutenOrderMailEvent.china_delay
          : RakutenOrderMailEvent.mixed_partial;
        await this.prisma.rakutenOrderMail.create({
          data: { connectionId: connection.id, orderId, event },
        }).catch((error: unknown) => {
          if (!this.isUniqueConstraintError(error)) throw error;
        });
      } catch (error) {
        this.logger.error(`Rakuten prepareTrackingMails 单笔处理失败：${this.errorMessage(error)}`);
      }
    }
  }

  private async prepareCustomsMails(connection: ConnectionWithShop): Promise<void> {
    const cursorKey = `customs:${connection.id}`;
    const cursor = this.candidateCursors.get(cursorKey) ?? '';
    const candidates = await this.prisma.$queryRaw<Array<{ orderId: string }>>(Prisma.sql`
      SELECT DISTINCT COALESCE(records.rms_order_id, records.order_id) AS orderId
      FROM rakuten_order_records records
      INNER JOIN rakuten_order_shipping_reports reports
        ON reports.connection_id = records.rms_connection_id
        AND reports.order_id = COALESCE(records.rms_order_id, records.order_id)
        AND (
          reports.status = 'sent'
          OR (reports.status = 'skipped' AND reports.last_error = ${VERIFIED_SHIPPING})
        )
      INNER JOIN rakuten_order_mails prerequisite
        ON prerequisite.connection_id = records.rms_connection_id
        AND prerequisite.order_id = COALESCE(records.rms_order_id, records.order_id)
        AND prerequisite.event IN ('china_delay', 'mixed_partial')
        AND (
          prerequisite.status = 'sent'
          OR (prerequisite.status = 'cancelled' AND prerequisite.resolution_note = ${IGNORED_MAIL})
        )
      LEFT JOIN rakuten_order_mails mails
        ON mails.connection_id = records.rms_connection_id
        AND mails.order_id = COALESCE(records.rms_order_id, records.order_id)
        AND mails.event IN ('china_customs', 'mixed_customs')
      WHERE records.deleted_at IS NULL AND records.rms_connection_id = ${connection.id}
        AND COALESCE(records.rms_order_id, records.order_id) IS NOT NULL
        AND COALESCE(records.rms_order_id, records.order_id) > ${cursor}
        AND records.created_at >= ${AUTOMATION_ORDER_IMPORT_CUTOFF}
        AND NOT EXISTS (
          SELECT 1
          FROM rakuten_order_records older_records
          WHERE older_records.rms_connection_id = records.rms_connection_id
            AND COALESCE(older_records.rms_order_id, older_records.order_id) = COALESCE(records.rms_order_id, records.order_id)
            AND older_records.created_at < ${AUTOMATION_ORDER_IMPORT_CUTOFF}
        )
        AND records.dispatch_mode IN ('china_pending', 'china_no_stock')
        AND records.tracking_has_customs_clearance = TRUE
        AND mails.id IS NULL
      ORDER BY COALESCE(records.rms_order_id, records.order_id) ASC
      LIMIT 500
    `);
    this.candidateCursors.set(cursorKey, candidates.length >= 500 ? String(candidates[candidates.length - 1].orderId) : '');
    for (const candidate of candidates) {
      try {

        const orderId = String(candidate.orderId ?? '').trim();
        if (!orderId) continue;
        const rows = await this.loadOrderRows(connection.id, orderId);
        if (orderBlockReason(rows)) continue;
        const chinaRows = rows.filter((row) => isChinaRow(row));
        if (!trackingReady(chinaRows, true)) continue;
        const report = await this.prisma.rakutenOrderShippingReport.findUnique({
          where: { connectionId_orderId: { connectionId: connection.id, orderId } },
        });
        if (report?.status !== RakutenAutomationStatus.sent && !(
          report?.status === RakutenAutomationStatus.skipped &&
          report.lastError === VERIFIED_SHIPPING
        )) continue;
        const event = fulfillmentOf(rows) === 'mixed'
          ? RakutenOrderMailEvent.mixed_customs
          : RakutenOrderMailEvent.china_customs;
        const prerequisiteEvent = event === RakutenOrderMailEvent.mixed_customs
          ? RakutenOrderMailEvent.mixed_partial
          : RakutenOrderMailEvent.china_delay;
        const prerequisite = await this.prisma.rakutenOrderMail.findUnique({
          where: {
            connectionId_orderId_event: {
              connectionId: connection.id,
              orderId,
              event: prerequisiteEvent,
            },
          },
          select: { status: true, resolutionNote: true },
        });
        if (!mailSatisfied(prerequisite)) continue;
        await this.prisma.rakutenOrderMail.create({
          data: { connectionId: connection.id, orderId, event,
            ...(report.status === RakutenAutomationStatus.skipped ? { status: RakutenAutomationStatus.uncertain,
              failureCategory: 'external_shipping', lastError: '乐天已有中国侧单号，请核实外部是否已发送邮件，再确认已发送或确认重发' } : {}),
          },
        }).catch((error: unknown) => {
          if (!this.isUniqueConstraintError(error)) throw error;
        });
      } catch (error) {
        this.logger.error(`Rakuten prepareCustomsMails 单笔处理失败：${this.errorMessage(error)}`);
      }
    }
  }

  private async processMails(
    connectionId?: bigint,
    selectedIds?: bigint[],
    expectedTemplateVersions?: Map<string, number>,
    expectedOrderFingerprints?: Map<string, string>,
    reviewedBodyOverrides?: Map<string, string>,
  ): Promise<MailRunCounts> {
    const cursorKey = `mail_jobs:${connectionId ?? 'all'}`;
    const cursor = selectedIds ? 0n : BigInt(this.candidateCursors.get(cursorKey) ?? '0');
    const mails = await this.prisma.rakutenOrderMail.findMany({
      where: {
        ...(connectionId ? { connectionId } : {}),
        ...(selectedIds ? { id: { in: selectedIds } } : {
          id: { gt: cursor },
          AND: [{ OR: [{ failureCategory: null }, { failureCategory: { notIn: ['manual_review', 'template_missing', 'order_changed', 'prerequisite_missing'] } }] }],
        }),
        status: { in: [RakutenAutomationStatus.pending, RakutenAutomationStatus.failed] },
        attempts: { lt: MAX_ATTEMPTS },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
        connection: { status: 1, mailNotificationsEnabled: true },
      },
      orderBy: { id: 'asc' },
      take: selectedIds ? selectedIds.length : 100,
      include: { connection: { include: { shop: { select: { id: true, name: true } } } } },
    });
    if (!selectedIds) this.candidateCursors.set(cursorKey, mails.length >= 100 ? mails[mails.length - 1].id.toString() : '0');
    const counts: MailRunCounts = { sent: 0, failed: 0, blocked: 0 };
    for (const mail of mails) {
      await this.assertExecutionLock(mail.connectionId);
      try {

        const prerequisiteEvent = this.mailPrerequisiteEvent(mail.event);
        if (prerequisiteEvent) {
          const prerequisite = await this.prisma.rakutenOrderMail.findUnique({
            where: {
              connectionId_orderId_event: {
                connectionId: mail.connectionId,
                orderId: mail.orderId,
                event: prerequisiteEvent,
              },
            },
            select: { status: true, resolutionNote: true },
          });
          if (!mailSatisfied(prerequisite)) {
            if (!prerequisite) {
              await this.prisma.rakutenOrderMail.update({
                where: { id: mail.id },
                data: {
                  nextAttemptAt: null, failureCategory: 'prerequisite_missing',
                  lastError: `缺少前置邮件 ${prerequisiteEvent}，请人工核对`,
                },
              });
              counts.blocked += 1;
              continue;
            }
            if (prerequisite.status === RakutenAutomationStatus.cancelled) {
              await this.prisma.rakutenOrderMail.update({ where: { id: mail.id }, data: {
                status: RakutenAutomationStatus.cancelled, nextAttemptAt: null,
                resolutionNote: '前置邮件已取消', lastError: '前置邮件已取消', failureCategory: null,
              } });
              counts.blocked += 1;
              continue;
            }
            if (prerequisite.status === RakutenAutomationStatus.dead_letter) {
              await this.prisma.rakutenOrderMail.update({
                where: { id: mail.id },
                data: {
                  status: RakutenAutomationStatus.dead_letter,
                  nextAttemptAt: null,
                  failureCategory: 'prerequisite',
                  deadLetteredAt: new Date(),
                  lastError: `前置邮件 ${prerequisiteEvent} 需要人工处理，本邮件已停止自动重试`,
                },
              });
              counts.failed += 1;
              continue;
            }
            await this.prisma.rakutenOrderMail.update({
              where: { id: mail.id },
              data: {
                nextAttemptAt: new Date(Date.now() + 20 * 60_000),
                lastError: `等待前置邮件 ${prerequisiteEvent} 发送成功`,
              },
            });
            counts.blocked += 1;
            continue;
          }
        }
        const latestRows = await this.loadOrderRows(mail.connectionId, mail.orderId);
        const businessBlock = mailOrderBlockReason(mail.event, latestRows);
        const reviewRequired = this.requiresManualMailReview(mail.event, latestRows);
        let template = await this.resolveActiveMailTemplate(mail.connectionId, mail.event);
        let templateIssue: string | null = null;
        if (template) {
          try { this.validateMailTemplate(template, mail.event); }
          catch (error) { templateIssue = this.errorMessage(error); template = null; }
        }
        const report = mail.event === RakutenOrderMailEvent.new_order ? null :
          await this.prisma.rakutenOrderShippingReport.findUnique({ where: { connectionId_orderId: {
            connectionId: mail.connectionId, orderId: mail.orderId,
          } } });
        let condition = mailConditionReason(mail.event, latestRows, report);
        // An explicit human resend of externally registered shipping resolves only
        // external-mail ambiguity, not tracking, cancellation or other prerequisites.
        if (condition?.includes('外部') && mail.resolutionNote === '用户确认重新发送结果不确定的邮件') condition = null;
        if (businessBlock || !template || reviewRequired && !reviewedBodyOverrides?.has(mail.id.toString()) || condition) {
          const manual = Boolean(businessBlock || !template || reviewRequired || condition?.includes('人工') || condition?.includes('外部'));
          await this.prisma.rakutenOrderMail.update({ where: { id: mail.id }, data: {
            failureCategory: businessBlock ? 'order_changed' : !template ? 'template_missing' : reviewRequired ? 'manual_review' : manual ? 'order_changed' : 'waiting_conditions',
            lastError: businessBlock || (!template ? templateIssue ?? '请配置并启用邮件模板' : reviewRequired ? '请人工核对商品调整、数量、特殊说明及收件资料后确认正文' : condition),
            nextAttemptAt: manual ? null : new Date(Date.now() + 20 * 60_000),
          } });
          counts.blocked += 1;
          continue;
        }
        const claimed = await this.prisma.rakutenOrderMail.updateMany({
          where: { id: mail.id, status: { in: [RakutenAutomationStatus.pending, RakutenAutomationStatus.failed] } },
          data: {
            status: RakutenAutomationStatus.processing,
            attempts: { increment: 1 },
            lastError: null,
            failureCategory: null,
            deadLetteredAt: null,
          },
        });
        if (claimed.count !== 1) continue;
        let sendAttemptStarted = false;
        let smtpAccepted = false;
        try {
          const rows = await this.loadOrderRows(mail.connectionId, mail.orderId);
          const expectedOrderFingerprint = expectedOrderFingerprints?.get(mail.id.toString());
          if (expectedOrderFingerprint && this.mailOrderFingerprint(rows, mail.event) !== expectedOrderFingerprint) {
            await this.prisma.rakutenOrderMail.update({
              where: { id: mail.id },
              data: {
                status: RakutenAutomationStatus.dead_letter,
                attempts: { decrement: 1 },
                nextAttemptAt: null,
                lastError: '订单在预览后已发生变化，请重新预览邮件后再发送',
                failureCategory: 'order_changed',
                deadLetteredAt: new Date(),
              },
            });
            counts.blocked += 1;
            continue;
          }
          const requiresManualReview = this.requiresManualMailReview(mail.event, rows);
          const reviewedBody = reviewedBodyOverrides?.get(mail.id.toString());
          if (requiresManualReview && (!expectedOrderFingerprint || reviewedBody === undefined)) {
            await this.prisma.rakutenOrderMail.update({
              where: { id: mail.id },
              data: {
                status: RakutenAutomationStatus.pending,
                attempts: { decrement: 1 },
                nextAttemptAt: null,
                lastError: '订单需要人工确认，请确认邮件正文后再发送',
                failureCategory: 'manual_review',
                deadLetteredAt: null,
              },
            });
            counts.blocked += 1;
            continue;
          }
          if (!await this.isAutomationEligibleOrder(rows)) {
            await this.prisma.rakutenOrderMail.update({
              where: { id: mail.id },
              data: {
                status: RakutenAutomationStatus.cancelled,
                nextAttemptAt: null,
                lastError: '订单在2026年10月1日前导入，不适用邮件发送功能',
                failureCategory: null,
                deadLetteredAt: null,
              },
            });
            counts.blocked += 1;
            continue;
          }
          const refreshedReport = mail.event === RakutenOrderMailEvent.new_order ? null : await this.prisma.rakutenOrderShippingReport.findUnique({ where: { connectionId_orderId: { connectionId: mail.connectionId, orderId: mail.orderId } } });
          let refreshedCondition = mailConditionReason(mail.event, rows, refreshedReport);
          if (refreshedCondition?.includes('外部') && mail.resolutionNote === '用户确认重新发送结果不确定的邮件') refreshedCondition = null;
          const refreshedBlock = mailOrderBlockReason(mail.event, rows) || refreshedCondition;
          const refreshedPrerequisite = prerequisiteEvent ? await this.prisma.rakutenOrderMail.findUnique({ where: { connectionId_orderId_event: { connectionId: mail.connectionId, orderId: mail.orderId, event: prerequisiteEvent } } }) : null;
          if (refreshedBlock || prerequisiteEvent && !mailSatisfied(refreshedPrerequisite)) {
            const manual = Boolean(refreshedBlock && /人工|外部|不存在|取消|变更/.test(refreshedBlock));
            await this.prisma.rakutenOrderMail.update({ where: { id: mail.id }, data: { status: RakutenAutomationStatus.pending, attempts: { decrement: 1 }, nextAttemptAt: manual ? null : new Date(Date.now() + 20 * 60_000), failureCategory: manual ? 'order_changed' : 'waiting_conditions', lastError: refreshedBlock || '前置邮件状态已变化' } });
            counts.blocked += 1;
            continue;
          }
          const recipient = this.resolveRecipient(rows);
          if (!recipient) throw new Error('乐天订单没有返回可用的买家匿名邮箱');
          const smtp = this.decryptSmtpCredentials(mail.connection);
          const bccAddresses = smtp.bccAddresses ?? [];
          const expectedTemplateVersion = expectedTemplateVersions?.get(mail.id.toString());
          const generated = expectedTemplateVersion
            ? await this.renderMailTemplateVersion(mail.connectionId, mail.event, expectedTemplateVersion, rows)
            : await this.renderConfiguredMail(mail.connectionId, mail.event, rows);
          const rendered = reviewedBody === undefined ? generated : { ...generated, body: reviewedBody };
          let liveBlock: string | null;
          try {
            liveBlock = await this.liveMailBlockReason(mail.connection, mail.orderId, mail.event);
          } catch (error) {
            // A read outage is not an SMTP attempt and cannot prove cancellation.
            const retryable = this.classifyFailure(error, 'mail').retryable;
            await this.prisma.rakutenOrderMail.update({ where: { id: mail.id }, data: {
              status: retryable ? RakutenAutomationStatus.pending : RakutenAutomationStatus.dead_letter, attempts: { decrement: 1 },
              failureCategory: retryable ? 'live_check' : 'order_changed', lastError: `发送前核实失败，${retryable ? '等待下一轮' : '请人工核对'}：${this.errorMessage(error)}`,
              nextAttemptAt: retryable ? new Date(Date.now() + 20 * 60_000) : null,
              deadLetteredAt: retryable ? null : new Date(),
            } });
            counts.blocked += 1;
            continue;
          }
          if (liveBlock) {
            await this.prisma.rakutenOrderMail.update({ where: { id: mail.id }, data: {
              status: RakutenAutomationStatus.dead_letter, failureCategory: 'order_changed',
              attempts: { decrement: 1 },
              lastError: liveBlock, nextAttemptAt: null, deadLetteredAt: new Date(),
            } });
            counts.blocked += 1;
            continue;
          }
          await this.assertExecutionLock(mail.connectionId);
          const smtpMessageId = this.buildSmtpMessageId(mail.id, smtp.fromAddress);
          let recordedSmtpMessageId = smtpMessageId;
          await this.prisma.rakutenOrderMail.update({
            where: { id: mail.id },
            data: {
              recipient,
              bccRecipients: bccAddresses.join(', ') || null,
              subject: rendered.subject,
              body: rendered.body,
              smtpMessageId,
              sendStartedAt: new Date(),
            },
          });
          sendAttemptStarted = true;
          const transport = this.createSmtpTransport(smtp);
          try {
            await this.assertExecutionLock(mail.connectionId);
            const info = await transport.sendMail({
              from: { address: smtp.fromAddress, name: smtp.fromName },
              to: recipient,
              ...(bccAddresses.length ? { bcc: bccAddresses } : {}),
              subject: rendered.subject,
              text: rendered.body,
              messageId: smtpMessageId,
            });
            const accepted = (info?.accepted ?? []).map((address: string | { address: string }) => String(typeof address === "string" ? address : address.address).trim().toLowerCase());
            if (!accepted.includes(recipient.trim().toLowerCase())) {
              const error = Object.assign(new Error("买家地址未被SMTP明确接受"), { code: "EENVELOPE" });
              throw error;
            }
            smtpAccepted = true;
            const returnedMessageId = String(info?.messageId || '').trim();
            if (returnedMessageId && returnedMessageId !== smtpMessageId) {
              recordedSmtpMessageId = returnedMessageId;
              await this.prisma.rakutenOrderMail.update({
                where: { id: mail.id },
                data: { smtpMessageId: returnedMessageId },
              });
            }
          } finally {
            transport.close();
          }
          await this.prisma.rakutenOrderMail.update({
            where: { id: mail.id },
            data: {
              status: RakutenAutomationStatus.sent,
              recipient,
              subject: rendered.subject,
              body: rendered.body,
              smtpMessageId: recordedSmtpMessageId,
              sentAt: new Date(),
              nextAttemptAt: null,
              lastError: null,
              failureCategory: null,
              deadLetteredAt: null,
            },
          });
          counts.sent += 1;
        } catch (error) {
          // SMTP cannot guarantee that a rejected promise means no delivery.
          // After starting an attempt, never retry without human verification.
          if (smtpAccepted || sendAttemptStarted) {
            await this.markMailUncertain(mail.id, error);
            counts.blocked += 1;
          } else {
            const handling = await this.markMailFailed(mail.id, mail.attempts + 1, error);
            counts.failed += 1;
            if (this.shouldOpenCircuit(handling)) {
              await this.openCircuit(mail.connectionId, 'mail', this.errorMessage(error));
              break;
            }
          }
        }
      } catch (error) {
        this.logger.error(`Rakuten processMails 单笔处理失败：${this.errorMessage(error)}`);
        counts.failed += 1;
      }
    }
    return counts;
  }

  private defaultMailTemplate(event: RakutenOrderMailEvent): MailTemplateDefinition {
    if (event === RakutenOrderMailEvent.new_order) {
      return {
        subjectTemplate: '【DGAZ楽天市場店】ご注文いただきありがとうございます！',
        bodyTemplate: [
          '{{buyer_name}}様', '',
          'このたびは、「DGAZ楽天市場店」をご利用いただきありがとうございます。',
          'スタッフ一同大変うれしく思っております。',
          '出荷作業に取り組みますので、いましばらくお待ちくださいませ。', '',
          '発送が完了いたしましたら、発送伝票番号をお知らせするメールをお送りいたします。',
          'スタッフ一同、細心の注意で商品をお届けいたします。',
          '商品到着までいましばらくお待ちくださいませ。', '',
          'なお、万が一お届け致しましたお品物に不備などお気づきがあれば',
          '大変お手数ではございますが、下記までお気軽にご連絡ください。', '',
          '至急、返品、交換、取り扱い方法のご説明などを対応させていただきます。', '',
          '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
          '▽お問い合わせ先▽', '(メール)info@createbetter.co.jp', '(電話)047-727-7616',
          '受付時間：10:00-18:00(土日祝除く)',
          '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛', '',
          '到着後、ご使用になられましたらレビューの記載をお願いできますと幸いです！',
          'https://order.my.rakuten.co.jp',
          '※レビューは下記「購入履歴」にログイン後、ページ下部の「商品レビューを書く」より、ご記入お願いいたします。',
          '（ご購入後、数時間はお買い物が履歴に反映されない場合がございます。）', '',
          '到着後の使用感などを伺えれば、スタッフ一同励みになります。',
          '{{signature}}',
        ].join('\n'),
      };
    }
    if (event === RakutenOrderMailEvent.china_delay) {
      return {
        subjectTemplate: '発送遅延について',
        bodyTemplate: [
          '{{buyer_name}}様', '', 'お世話になっております。', '',
          'このたびはご注文いただき、誠にありがとうございます。', '',
          '誠に申し訳ございませんが、ご注文いただきました商品は現在在庫切れとなっておりますため、工場にて生産・発送の手配を進めております。', '',
          'お届けまで約7～10日ほどお時間を頂戴する見込みでございます。', '',
          'また、自社倉庫以外からの発送となるため、配送会社やお届け時間のご指定は承ることができかねます。', '',
          'ご不便をおかけし誠に恐縮ではございますが、何卒ご理解賜りますようお願い申し上げます。', '',
          'このたびはご迷惑をおかけいたしますこと、心よりお詫び申し上げます。', '',
          '商品到着まで今しばらくお待ちいただけますと幸いです。', '',
          '引き続きよろしくお願いいたします。', '{{signature}}',
        ].join('\n'),
      };
    }
    if (event === RakutenOrderMailEvent.mixed_partial) {
      return {
        subjectTemplate: '商品について',
        bodyTemplate: [
          '{{buyer_name}}様', '', 'お世話になっております。', 'ご注文ありがとうございます。',
          '恐れ入りますが、',
          '今回のご注文は在庫により、倉庫を分けて送ることになっております。', '',
          '自社から発送：', '', '{{japan_items}}', '', '{{japan_tracking}}', '',
          '工場側直送（7-10日）：', '', '{{china_items}}', '',
          '自社以外発送する場合は運送会社や配達時間を指定することが出来かねます。',
          'ご迷惑をおかけてしまい大変申し訳ございませんでした。',
          'よろしくお願いいたします。', '{{signature}}',
        ].join('\n'),
      };
    }
    const isDirect = event === RakutenOrderMailEvent.china_customs || event === RakutenOrderMailEvent.mixed_customs;
    return {
      subjectTemplate: '商品発送のご連絡',
      bodyTemplate: [
        '{{buyer_name}}様', '', 'いつもお世話になっております。', '',
        ...(isDirect ? ['工場直送分のお荷物の通関許可を確認いたしました。配送情報をご案内いたします。'] : ['ご注文いただきました商品の発送が完了いたしました。']),
        ...(isDirect ? [] : ['商品はご指定いただいた日時にお送りいたします。']), '',
        '只今当店ではレビュー書いて頂くとプレゼントを差し上げます。', '',
        'レビュー記入後、連絡するだけでDGAZ楽天市場店で使える500円OFFクーポンを無料プレゼント致します。',
        '', '宜しければ是非ご評価してください。', 'よろしくお願いいたします。', '',
        '※※※お知らせ※※※',
        ...(isDirect ? [] : ['発送日のご指定がない場合は最短お届け日を設定いたします。', '']),
        '{{order_summary}}', '',
        ...(isDirect ? [
          '大変申し訳ございませんが、',
          'こちらの商品は工場からの直送となっており、',
          '運送会社や配達日時のご指定を承ることができません。', '',
          'ご不便をおかけし誠に恐縮ではございますが、',
          '何卒ご理解賜りますようお願い申し上げます。', '',
          '発送情報は下記のとおりでございます。', '',
          '{{china_tracking_sections}}', '',
        ] : ['{{tracking_sections}}', '']),
        '{{signature}}',
      ].join('\n'),
    };
  }

  private renderTemplate(
    template: MailTemplateDefinition,
    rows: RakutenOrderRecord[],
    event?: RakutenOrderMailEvent,
  ): { subject: string; body: string } {
    this.validateMailTemplate(template, event);
    const first = rows[0];
    if (!first) throw new Error('订单明细不存在');
    const japanRows = rows.filter((row) => !isChinaRow(row));
    const chinaRows = rows.filter((row) => isChinaRow(row));
    const values: Record<string, () => string> = {
      buyer_name: () => this.resolveBuyerName(rows),
      order_number: () => originalRakutenOrderId(first),
      order_summary: () => this.renderOrderSummary(rows),
      tracking_sections: () => this.renderTrackingSections(rows),
      china_tracking_sections: () => this.renderTrackingSections(chinaRows),
      japan_items: () => this.renderDispatchItems(japanRows),
      china_items: () => this.renderDispatchItems(chinaRows),
      japan_tracking: () => this.renderCompactTrackingLines(japanRows),
      signature: () => this.renderSignature(),
    };
    const renderedValues = new Map<string, string>();
    const replace = (source: string) => source.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => {
      if (!values[key]) throw new Error(`未知邮件模板变量：${key}`);
      if (!renderedValues.has(key)) renderedValues.set(key, values[key]());
      return renderedValues.get(key) ?? '';
    });
    const subject = replace(template.subjectTemplate).trim();
    const body = replace(template.bodyTemplate);
    if (!subject || subject.length > 255 || /[\r\n]/.test(subject)) {
      throw new Error('渲染后的邮件主题无效或超过255个字符');
    }
    return { subject, body };
  }

  private async resolveActiveMailTemplate(
    connectionId: bigint,
    event: RakutenOrderMailEvent,
  ): Promise<MailTemplateDefinition | null> {
    return this.prisma.rakutenMailTemplateVersion.findFirst({
      where: { connectionId, event, isActive: true },
      orderBy: { version: 'desc' },
      select: { subjectTemplate: true, bodyTemplate: true },
    });
  }

  private async renderConfiguredMail(
    connectionId: bigint,
    event: RakutenOrderMailEvent,
    rows: RakutenOrderRecord[],
  ): Promise<{ subject: string; body: string }> {
    const template = await this.resolveActiveMailTemplate(connectionId, event);
    if (!template) throw new Error('请配置并启用邮件模板');
    return this.renderTemplate(template, rows, event);
  }

  private async renderMailTemplateVersion(
    connectionId: bigint,
    event: RakutenOrderMailEvent,
    version: number,
    rows: RakutenOrderRecord[],
  ): Promise<{ subject: string; body: string }> {
    const template = await this.prisma.rakutenMailTemplateVersion.findUnique({
      where: { connectionId_event_version: { connectionId, event, version } },
      select: { subjectTemplate: true, bodyTemplate: true, isActive: true },
    });
    if (!template?.isActive) throw new Error('邮件模板已变化或未启用，请重新整理清单');
    return this.renderTemplate(template, rows, event);
  }

  private renderMail(
    event: RakutenOrderMailEvent,
    rows: RakutenOrderRecord[],
  ): { subject: string; body: string } {
    return this.renderTemplate(this.defaultMailTemplate(event), rows, event);
  }

  private renderOrderSummary(rows: RakutenOrderRecord[]): string {
    const first = rows[0];
    if (!first) return '';
    const order = hasRemovedOrderItems(rows) ? null : this.resolveRawOrder(rows);
    const settlement = this.jsonObject(order?.SettlementModel ?? order?.settlementModel);
    const point = this.jsonObject(order?.PointModel ?? order?.pointModel);
    const paymentMethod = this.pickObjectText(settlement, 'settlementMethod', 'settlementMethodName', 'paymentMethod');
    const couponAmount = this.pickObjectNumber(order, 'couponAllTotalPrice', 'CouponAllTotalPrice');
    const usedPoint = this.pickObjectNumber(point, 'usedPoint', 'UsedPoint') ?? this.pickObjectNumber(order, 'usedPoint');
    const lines = [
      `[受注番号] ${originalRakutenOrderId(first)}`,
      `[日時] ${String(first.orderImportedAtRaw ?? '')}`,
      `[注文者] ${this.resolveBuyerName(rows)} 様`,
      paymentMethod ? `[支払方法] ${paymentMethod}` : '',
      couponAmount === null ? '' : `[クーポン利用] ${couponAmount > 0 ? 'あり' : 'なし'}`,
      usedPoint === null ? '' : `[ポイント利用] ${usedPoint > 0 ? 'あり' : 'なし'}`,
      `[配送方法] ${String(first.deliveryMethod ?? '')}`,
      `[備考] ${String(first.orderRemark ?? '')}`,
      '[配送日時指定:]',
      String(first.deliveryDateRaw ?? ''),
      String(first.deliveryTimeSlot ?? ''),
      '',
    ].filter((line, index, values) => line !== '' || values[index - 1] !== '');
    const groups = this.groupRowsByBasket(rows);
    for (const group of groups) {
      const destination = group[0];
      lines.push(
        '--------------------------------',
        `[送付先] ${String(destination.shippingName ?? '')} 様`,
        `      〒${String(destination.shippingPostalCode ?? '')} ${String(destination.shippingPrefecture ?? '')} ${String(destination.shippingCity ?? '')} ${String(destination.shippingAddress ?? '')}`,
        `      (TEL) ${String(destination.shippingPhone ?? '')}`,
        '[商品]',
        this.renderItemLines(group),
        '',
      );
    }
    lines.push(...this.renderOrderTotals(order, rows));
    return lines.filter((line, index, values) => line !== '' || values[index - 1] !== '').join('\n');
  }

  private renderItemLines(rows: RakutenOrderRecord[]): string {
    const adjusted = hasRemovedOrderItems(rows);
    const items = adjusted ? rows : this.uniquePurchasedRows(rows);
    return items.map((row) => {
      const raw = this.jsonObject(row.rawPayload);
      const rawItem = this.jsonObject(raw?.rmsItem);
      const quantity = validOrderQuantity(row.orderQuantity);
      const price = hasRemovedOrderItems(rows) ? null : this.pickObjectNumber(rawItem, 'price', 'itemPrice', 'unitPrice');
      const subtotal = (hasRemovedOrderItems(rows) ? null : this.pickObjectNumber(rawItem, 'subtotalPrice', 'subtotal')) ?? (price === null || quantity === null ? null : price * quantity);
      const itemUrl = this.pickObjectText(rawItem, 'itemUrl', 'itemURL');
      return [
        `      ${this.renderBuyerItemName(row, row.isComboOrder && adjusted)}`,
        row.productNameExtra
          ? row.productNameExtra.split(/\r\n|\n|\r/).map((line) => `      ${line}`).join('\n')
          : '',
        `      数量: ${quantity ?? '要確認'}`,
        itemUrl ? `      ${itemUrl}` : '',
        price === null || quantity === null || subtotal === null ? '' : `      価格 ${this.formatYen(price)} x ${quantity}(個) = ${this.formatYen(subtotal)} (税込)`,
      ].filter(Boolean).join('\n');
    }).join('\n');
  }

  private renderDispatchItems(rows: RakutenOrderRecord[]): string {
    return rows.map((row) => {
      return [this.renderBuyerItemName(row, row.isComboOrder),
        row.productNameExtra ?? '', `数量: ${validOrderQuantity(row.orderQuantity) ?? '要確認'}`].filter(Boolean).join('\n');
    }).join('\n\n');
  }

  private renderBuyerItemName(row: RakutenOrderRecord, component: boolean): string {
    const raw = this.jsonObject(row.rawPayload);
    const item = this.jsonObject(raw?.rmsItem);
    // Combo expansion replaces productName with the WMS component name. The
    // original marketplace title remains in rawPayload and is the buyer-facing name.
    const originalName = this.pickObjectText(item, 'itemName', 'ItemName') || this.pickObjectText(raw, '商品名');
    if (row.isComboOrder) {
      if (!originalName) return 'セット構成商品（商品名は確認中）';
      return component ? `${originalName}（構成商品）` : originalName;
    }
    return originalName || String(row.productName ?? row.skuCode ?? '');
  }

  private renderTrackingLines(rows: RakutenOrderRecord[]): string {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const row of rows) {
      const trackingNo = String(row.shipmentNo ?? '').trim();
      if (!trackingNo || seen.has(trackingNo)) continue;
      seen.add(trackingNo);
      const shippingDate = isChinaRow(row)
        ? (row.trackingCustomsClearanceDate ? this.formatMailDate(row.trackingCustomsClearanceDate) : '確認中')
        : this.formatMailDate(row.warehouseShippedAt);
      lines.push(`[発送日] ${shippingDate}`);
      lines.push(`[お荷物伝票番号] ${trackingNo}`);
      lines.push(`[配送会社] ${this.deliveryCompanyName(row)}`);
    }
    return lines.join('\n');
  }

  private renderCompactTrackingLines(rows: RakutenOrderRecord[]): string {
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const trackingNo = String(row.shipmentNo ?? '').trim();
      if (!trackingNo || seen.has(trackingNo)) return [];
      seen.add(trackingNo);
      return [`${this.deliveryCompanyName(row)}：${trackingNo}`];
    }).join('\n');
  }

  private renderTrackingSections(rows: RakutenOrderRecord[]): string {
    return this.groupRowsByBasket(rows).map((group) => {
      const destination = group[0];
      return [
        `[送付先] ${String(destination.shippingName ?? '')} 様`,
        `      〒${String(destination.shippingPostalCode ?? '')} ${String(destination.shippingPrefecture ?? '')} ${String(destination.shippingCity ?? '')} ${String(destination.shippingAddress ?? '')}`,
        `      (TEL) ${String(destination.shippingPhone ?? '')}`,
        '',
        this.renderTrackingLines(group),
      ].join('\n');
    }).join('\n\n');
  }

  private resolveRawOrder(rows: RakutenOrderRecord[]): Record<string, unknown> | null {
    const raw = this.jsonObject(rows[0]?.rawPayload);
    return this.jsonObject(raw?.rmsOrder);
  }

  private resolveBuyerName(rows: RakutenOrderRecord[]): string {
    const order = this.resolveRawOrder(rows);
    const orderer = this.jsonObject(order?.OrdererModel ?? order?.ordererModel);
    const familyName = this.pickObjectText(orderer, 'familyName', 'lastName');
    const firstName = this.pickObjectText(orderer, 'firstName');
    const combined = [familyName, firstName].filter(Boolean).join(' ').trim();
    return combined || this.pickObjectText(orderer, 'name', 'fullName') || String(rows[0]?.shippingName ?? '').trim() || 'お客様';
  }

  private groupRowsByBasket(rows: RakutenOrderRecord[]): RakutenOrderRecord[][] {
    const groups = new Map<string, RakutenOrderRecord[]>();
    for (const row of rows) {
      const basketId = this.resolveBasketId(row.rawPayload);
      const destinationKey = [
        row.shippingName,
        row.shippingPostalCode,
        row.shippingPrefecture,
        row.shippingCity,
        row.shippingAddress,
      ].map((value) => String(value ?? '').trim()).join('|');
      const key = basketId === null ? `destination:${destinationKey}` : `basket:${basketId}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    return Array.from(groups.values());
  }

  private renderOrderTotals(order: Record<string, unknown> | null, rows: RakutenOrderRecord[]): string[] {
    if (hasRemovedOrderItems(rows)) return ['商品内容が変更されています。金額は確認が必要です。'];
    const goodsPrice = this.pickObjectNumber(order, 'goodsPrice', 'GoodsPrice') ?? this.sumItemSubtotal(rows);
    const postagePrice = this.pickObjectNumber(order, 'postagePrice', 'deliveryPrice', 'PostagePrice');
    const paymentCharge = this.pickObjectNumber(order, 'paymentCharge', 'PaymentCharge');
    const couponAmount = this.pickObjectNumber(order, 'couponAllTotalPrice', 'CouponAllTotalPrice');
    const point = this.jsonObject(order?.PointModel ?? order?.pointModel);
    const usedPoint = this.pickObjectNumber(point, 'usedPoint', 'UsedPoint') ?? this.pickObjectNumber(order, 'usedPoint');
    const requestPrice = this.pickObjectNumber(order, 'requestPrice', 'totalPrice', 'RequestPrice');
    const purchasedRows = this.uniquePurchasedRows(rows);
    const quantities = purchasedRows.map((row) => validOrderQuantity(row.orderQuantity));
    const quantity = quantities.every((value) => value !== null) ? quantities.reduce<number>((sum, value) => sum + value!, 0) : null;
    const lines = [
      '****************************************************************',
      `送付先件数   ${this.groupRowsByBasket(rows).length}(件)`,
      quantity === null ? '' : `合計商品数   ${quantity}(個)`,
      goodsPrice === null ? '' : `商品価格計(税込) ${this.formatYen(goodsPrice)}`,
      '--------------------------------',
      goodsPrice === null ? '' : `商品小計(税込)   ${this.formatYen(goodsPrice)}`,
      postagePrice === null ? '' : `送料(税込)   ${this.formatYen(postagePrice)}`,
      paymentCharge !== null && paymentCharge > 0 ? `決済手数料(税込)   ${this.formatYen(paymentCharge)}` : '',
      usedPoint !== null && usedPoint > 0 ? `ポイント利用 -${this.formatYen(usedPoint)}` : '',
      couponAmount !== null && couponAmount > 0 ? `クーポン利用 -${this.formatYen(couponAmount)}` : '',
      '----------------------------------------------------------------',
      requestPrice === null ? '' : `お支払い金額(税込)   ${this.formatYen(requestPrice)}`,
      '----------------------------------------------------------------',
    ];
    return lines.filter(Boolean);
  }

  private sumItemSubtotal(rows: RakutenOrderRecord[]): number | null {
    let total = 0;
    let found = false;
    for (const row of this.uniquePurchasedRows(rows)) {
      const raw = this.jsonObject(row.rawPayload);
      const item = this.jsonObject(raw?.rmsItem);
      const quantity = validOrderQuantity(row.orderQuantity);
      const subtotal = this.pickObjectNumber(item, 'subtotalPrice', 'subtotal');
      const price = this.pickObjectNumber(item, 'price', 'itemPrice', 'unitPrice');
      if (subtotal !== null) {
        total += subtotal;
        found = true;
      } else if (price !== null && quantity !== null) {
        total += price * quantity;
        found = true;
      } else {
        return null;
      }
    }
    return found ? total : null;
  }

  private uniquePurchasedRows(rows: RakutenOrderRecord[]): RakutenOrderRecord[] {
    const seen = new Set<string>();
    return rows.filter((row) => {
      const raw = this.jsonObject(row.rawPayload);
      const item = this.jsonObject(raw?.rmsItem);
      const itemDetailId = this.pickObjectText(item, 'itemDetailId', 'ItemDetailId');
      const normalizedItemKey = String(row.rmsItemKey ?? '').replace(/\|component:[^|]+$/i, '');
      const key = itemDetailId ? `detail:${itemDetailId}` : `key:${normalizedItemKey || row.id.toString()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private pickObjectText(source: Record<string, unknown> | null, ...keys: string[]): string {
    if (!source) return '';
    for (const key of keys) {
      const value = source[key];
      if (value === null || value === undefined) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return '';
  }

  private pickObjectNumber(source: Record<string, unknown> | null, ...keys: string[]): number | null {
    const text = this.pickObjectText(source, ...keys).replace(/,/g, '');
    if (!text) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }

  private formatYen(value: number): string {
    return `${Math.round(value).toLocaleString('ja-JP')}(円)`;
  }

  private formatMailDate(value: Date | null): string {
    const iso = this.formatShippingDate(value);
    const [year, month, day] = iso.split('-');
    return `${year}年${month}月${day}日`;
  }

  private renderSignature(): string {
    return [
      '    -------------------------------------------------------',
      '    株式会社Ｃｒｅａｔｅ　Ｂｅｔｔｅｒ',
      '    CreateBetter',
      '    2702222 千葉県松戸市高塚新田２１５－１６',
      '    (TEL) 0477277616',
      '    (URL) http://www.rakuten.co.jp/createbetter/',
      '    中野 優(info@createbetter.co.jp)',
    ].join('\n');
  }

  private buildShippingBaskets(rows: RakutenOrderRecord[]): ShippingBasket[] {
    const byBasket = new Map<number, Map<string, RakutenOrderRecord>>();
    for (const row of rows) {
      const trackingNo = String(row.shipmentNo ?? '').trim();
      const basketId = this.resolveBasketId(row.rawPayload);
      if (!trackingNo || basketId === null) continue;
      const shippingDate = isChinaRow(row) ? row.trackingCustomsClearanceDate : row.warehouseShippedAt;
      if (!shippingDate) continue;
      const trackingRows = byBasket.get(basketId) ?? new Map<string, RakutenOrderRecord>();
      if (!trackingRows.has(trackingNo)) trackingRows.set(trackingNo, row);
      byBasket.set(basketId, trackingRows);
    }
    return Array.from(byBasket.entries()).map(([basketId, trackingRows]) => ({
      basketId,
      ShippingModelList: Array.from(trackingRows.entries()).map(([shippingNumber, row]) => ({
        shippingNumber,
        deliveryCompany: this.deliveryCompanyCode(row),
        shippingDate: this.formatShippingDate(isChinaRow(row) ? row.trackingCustomsClearanceDate : row.warehouseShippedAt),
        shippingDeleteFlag: 0,
      })),
    }));
  }

  private shippingAlreadyReported(currentOrders: Array<Record<string, unknown>>, baskets: ShippingBasket[]): boolean {
    const currentNumbersByBasket = new Map<number, Set<string>>();
    for (const order of currentOrders) {
      const packages = Array.isArray(order.PackageModelList)
        ? order.PackageModelList
        : Array.isArray(order.packageModelList)
          ? order.packageModelList
          : [];
      for (const rawPackage of packages) {
        const pkg = this.jsonObject(rawPackage);
        const basketId = Number(pkg?.basketId ?? pkg?.BasketId);
        if (!Number.isInteger(basketId) || basketId < 0) continue;
        const currentNumbers = currentNumbersByBasket.get(basketId) ?? new Set<string>();
        const shippingModels = Array.isArray(pkg?.ShippingModelList)
          ? pkg.ShippingModelList
          : Array.isArray(pkg?.shippingModelList)
            ? pkg.shippingModelList
            : [];
        for (const rawShipping of shippingModels) {
          const shipping = this.jsonObject(rawShipping);
          const number = String(shipping?.shippingNumber ?? shipping?.ShippingNumber ?? '').trim();
          if (number) currentNumbers.add(number);
        }
        currentNumbersByBasket.set(basketId, currentNumbers);
      }
    }
    return baskets.length > 0 && baskets.every((basket) => {
      const currentNumbers = currentNumbersByBasket.get(basket.basketId);
      return Boolean(
        currentNumbers &&
        basket.ShippingModelList.length > 0 &&
        basket.ShippingModelList.every((shipping) => currentNumbers.has(shipping.shippingNumber)),
      );
    });
  }

  private async assertOrderNotDeleted(connectionId: bigint, orderId: string): Promise<void> {
    const active = await this.prisma.rakutenOrderRecord.findFirst({ where: {
      rmsConnectionId: connectionId, ...rakutenOrderIdentityWhere(orderId), deletedAt: null,
    }, select: { id: true } });
    if (!active) throw new BadRequestException('订单已人工确认逻辑删除，不能恢复后续任务');
  }

  private async liveMailBlockReason(connection: RakutenRmsConnection, orderId: string, event: RakutenOrderMailEvent): Promise<string | null> {
    const credentials = this.decryptApiCredentials(connection);
    const orders = await this.client.getOrders(credentials.serviceSecret, credentials.licenseKey, [orderId]);
    const order = this.resolveCurrentOrder(orders, orderId);
    if (!order) return '乐天未返回可核实的目标订单，邮件停止发送，请人工核对';
    const progress = this.resolveOrderProgress(order);
    if (progress === 800 || progress === 900) return '乐天状态为取消相关状态，请人工核对是否逻辑删除；邮件暂不发送';
    if (progress === null || ![100, 200, 300, 400, 500, 600, 700].includes(progress)) {
      return '乐天订单状态无法确认，邮件停止发送，请人工核对';
    }
    if (event === RakutenOrderMailEvent.new_order && progress !== 300) {
      return '乐天订单已离开待发货状态，请人工核对是否仍需发送新規邮件';
    }
    return null;
  }

  private resolveCurrentOrder(
    orders: Array<Record<string, unknown>>,
    orderId: string,
  ): Record<string, unknown> | null {
    const matched = orders.find((order) =>
      String(order.orderNumber ?? order.OrderNumber ?? '').trim() === orderId,
    );
    return matched ?? null;
  }

  private resolveOrderProgress(order: Record<string, unknown>): number | null {
    const value = order.orderProgress ?? order.OrderProgress;
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }

  private resolveBasketId(rawPayload: Prisma.JsonValue | null): number | null {
    return basketIdOf({ rawPayload } as RakutenOrderRecord);
  }

  private resolveRecipient(rows: RakutenOrderRecord[]): string | null {
    const recipients = new Set(rows.map((row) => String(row.buyerEmail ?? '').trim().toLowerCase()));
    if (recipients.size > 1) throw new BadRequestException('同一订单的买家邮箱不一致，请人工核对');
    return Array.from(recipients)[0] || null;
  }

  private shippingTargetRows(rows: RakutenOrderRecord[], fulfillmentType: FulfillmentType): RakutenOrderRecord[] {
    return shippingTargetRows(rows, fulfillmentType);
  }

  private deliveryCompanyCode(row: Pick<RakutenOrderRecord, 'shipmentCompany'>) {
    return rakutenDeliveryCompanyCode(row.shipmentCompany);
  }

  private deliveryCompanyName(row: Pick<RakutenOrderRecord, 'shipmentCompany'>): string {
    return { '1001': 'ヤマト運輸', '1002': '佐川急便', '1003': '日本郵便' }[this.deliveryCompanyCode(row)];
  }

  private formatShippingDate(value: Date | null): string {
    if (!value || Number.isNaN(value.getTime())) throw new BadRequestException('缺少有效的实际出货或清关日期，不能生成発送日');
    const date = value;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: AUTOMATION_TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  private automationOrderKey(connectionId: bigint, orderId: string): string {
    return `${connectionId.toString()}:${orderId}`;
  }

  private async isAutomationEligibleOrder(rows: RakutenOrderRecord[]): Promise<boolean> {
    const first = rows[0];
    if (!first?.rmsConnectionId || !first.orderId || rows.some((row) => row.createdAt < AUTOMATION_ORDER_IMPORT_CUTOFF)) return false;
    const orderId = originalRakutenOrderId(first);
    const eligible = await this.loadEligibleAutomationOrderKeys([{ connectionId: first.rmsConnectionId, orderId }]);
    return eligible.has(this.automationOrderKey(first.rmsConnectionId, orderId));
  }

  private async loadEligibleAutomationOrderKeys(
    refs: Array<{ connectionId: bigint; orderId: string }>,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Set<string>> {
    const uniqueRefs = Array.from(new Map(refs.map((ref) => [
      this.automationOrderKey(ref.connectionId, ref.orderId),
      ref,
    ])).values());
    if (!uniqueRefs.length) return new Set();
    const records = await db.rakutenOrderRecord.findMany({
      where: {
        OR: uniqueRefs.map((ref) => ({ rmsConnectionId: ref.connectionId, ...rakutenOrderIdentityWhere(ref.orderId) })),
      },
      select: { rmsConnectionId: true, orderId: true, rmsOrderId: true, createdAt: true, deletedAt: true },
    });
    const earliestByOrder = new Map<string, Date>();
    const activeKeys = new Set<string>();
    for (const record of records) {
      if (!record.rmsConnectionId || !record.orderId) continue;
      const key = this.automationOrderKey(record.rmsConnectionId, originalRakutenOrderId(record));
      if (!record.deletedAt) activeKeys.add(key);
      const earliest = earliestByOrder.get(key);
      if (!earliest || record.createdAt < earliest) earliestByOrder.set(key, record.createdAt);
    }
    return new Set(Array.from(earliestByOrder.entries())
      .filter(([key, createdAt]) => activeKeys.has(key) && createdAt >= AUTOMATION_ORDER_IMPORT_CUTOFF)
      .map(([key]) => key));
  }

  private async loadOrderRows(connectionId: bigint, orderId: string): Promise<RakutenOrderRecord[]> {
    return this.prisma.rakutenOrderRecord.findMany({
      where: { deletedAt: null, rmsConnectionId: connectionId, ...rakutenOrderIdentityWhere(orderId) },
      orderBy: { id: 'asc' },
    });
  }

  private mailOrderFingerprint(rows: RakutenOrderRecord[], event?: RakutenOrderMailEvent): string {
    if (event === RakutenOrderMailEvent.new_order) {
      return createHash('sha1').update(JSON.stringify({ orderId: rows[0] ? originalRakutenOrderId(rows[0]) : null,
        recipient: this.resolveRecipient(rows), buyerName: this.resolveBuyerName(rows) })).digest('hex');
    }
    const snapshot = rows.map((row) => ({
      id: row.id.toString(),
      orderId: row.orderId,
      rmsOrderId: originalRakutenOrderId(row),
      buyerEmail: row.buyerEmail,
      skuCode: row.skuCode,
      orderQuantity: row.orderQuantity,
      productName: row.productName,
      productNameExtra: row.productNameExtra,
      shippingName: row.shippingName,
      shippingPostalCode: row.shippingPostalCode,
      shippingPrefecture: row.shippingPrefecture,
      shippingCity: row.shippingCity,
      shippingAddress: row.shippingAddress,
      shippingPhone: row.shippingPhone,
      shipmentCompany: row.shipmentCompany,
      shipmentNo: row.shipmentNo,
      shipmentNoRegisteredAt: row.shipmentNoRegisteredAt?.toISOString() ?? null,
      warehouseShippedAt: row.warehouseShippedAt?.toISOString() ?? null,
      trackingCustomsClearanceDate: row.trackingCustomsClearanceDate?.toISOString() ?? null,
      trackingHasCustomsClearance: row.trackingHasCustomsClearance,
      rmsManualOverrideAt: row.rmsManualOverrideAt?.toISOString() ?? null,
      isComboOrder: row.isComboOrder,
      comboOrderSku: row.comboOrderSku,
      setComponentSkuCode: row.setComponentSkuCode,
      dispatchMode: row.dispatchMode,
      deliveryMethod: row.deliveryMethod,
      deliveryDateRaw: row.deliveryDateRaw,
      deliveryTimeSlot: row.deliveryTimeSlot,
      orderRemark: row.orderRemark,
      rawPayload: row.rawPayload,
    }));
    return createHash('sha1').update(JSON.stringify(snapshot)).digest('hex');
  }

  private requiresManualMailReview(event: RakutenOrderMailEvent, rows: RakutenOrderRecord[]): boolean {
    return Boolean(this.manualMailReviewReason(event, rows));
  }

  private manualMailReviewReason(event: RakutenOrderMailEvent, rows: RakutenOrderRecord[]): ManualMailReviewReason | null {
    return mailEventReviewReason(event, rows);
  }

  private decryptApiCredentials(connection: RakutenRmsConnection): { serviceSecret: string; licenseKey: string } {
    return {
      serviceSecret: this.crypto.decrypt(connection.encryptedServiceSecret, connection.serviceSecretIv, connection.serviceSecretAuthTag),
      licenseKey: this.crypto.decrypt(connection.encryptedLicenseKey, connection.licenseKeyIv, connection.licenseKeyAuthTag),
    };
  }

  private decryptSmtpCredentials(connection: RakutenRmsConnection): {
    authId: string; password: string; fromAddress: string; fromName: string; bccAddresses: string[];
  } {
    const authId = String(connection.smtpAuthId ?? '').trim();
    const fromAddress = String(connection.smtpFromAddress ?? '').trim();
    if (!authId || !fromAddress || !connection.encryptedSmtpPassword || !connection.smtpPasswordIv || !connection.smtpPasswordAuthTag) {
      throw new Error('乐天SMTP配置不完整');
    }
    return {
      authId,
      password: this.crypto.decrypt(connection.encryptedSmtpPassword, connection.smtpPasswordIv, connection.smtpPasswordAuthTag),
      fromAddress,
      fromName: String(connection.smtpFromName ?? '').trim() || 'DGAZ楽天市場店',
      bccAddresses: String(connection.smtpBccAddresses ?? '').split(',').map((address) => address.trim()).filter(Boolean),
    };
  }

  private createSmtpTransport(smtp: {
    authId: string; password: string; fromAddress: string; fromName: string; bccAddresses: string[];
  }) {
    return createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      requireTLS: true,
      auth: { user: smtp.authId, pass: smtp.password },
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 30_000,
    });
  }

  private async markShippingFailed(id: bigint, attempts: number, error: unknown): Promise<FailureHandlingResult> {
    const classification = this.classifyFailure(error, 'shipping');
    const exhausted = attempts >= MAX_ATTEMPTS;
    const deadLetter = exhausted || !classification.retryable;
    await this.prisma.rakutenOrderShippingReport.update({
      where: { id },
      data: {
        status: deadLetter ? RakutenAutomationStatus.dead_letter : RakutenAutomationStatus.failed,
        lastError: this.errorMessage(error).slice(0, 10000),
        failureCategory: exhausted ? 'max_attempts' : classification.category,
        deadLetteredAt: deadLetter ? new Date() : null,
        nextAttemptAt: deadLetter ? null : this.nextRetry(attempts, `shipping:${id.toString()}`),
      },
    });
    return { ...classification, deadLetter };
  }

  private async markShippingSkipped(id: bigint, reason: string): Promise<void> {
    await this.prisma.rakutenOrderShippingReport.update({
      where: { id },
      data: {
        status: RakutenAutomationStatus.skipped,
        lastError: reason.slice(0, 10000),
        failureCategory: null,
        deadLetteredAt: null,
        nextAttemptAt: null,
      },
    });
  }

  private mailPrerequisiteEvent(event: RakutenOrderMailEvent): RakutenOrderMailEvent | null {
    if (
      event === RakutenOrderMailEvent.japan_shipped ||
      event === RakutenOrderMailEvent.china_delay ||
      event === RakutenOrderMailEvent.mixed_partial
    ) {
      return RakutenOrderMailEvent.new_order;
    }
    if (event === RakutenOrderMailEvent.china_customs) return RakutenOrderMailEvent.china_delay;
    if (event === RakutenOrderMailEvent.mixed_customs) return RakutenOrderMailEvent.mixed_partial;
    return null;
  }

  private dependentMailEvents(event: RakutenOrderMailEvent): RakutenOrderMailEvent[] {
    if (event === RakutenOrderMailEvent.new_order) {
      return [
        RakutenOrderMailEvent.japan_shipped,
        RakutenOrderMailEvent.china_delay,
        RakutenOrderMailEvent.china_customs,
        RakutenOrderMailEvent.mixed_partial,
        RakutenOrderMailEvent.mixed_customs,
      ];
    }
    if (event === RakutenOrderMailEvent.china_delay) return [RakutenOrderMailEvent.china_customs];
    if (event === RakutenOrderMailEvent.mixed_partial) return [RakutenOrderMailEvent.mixed_customs];
    return [];
  }

  private parseMailStatus(value: string): RakutenAutomationStatus {
    if (!Object.values(RakutenAutomationStatus).includes(value as RakutenAutomationStatus)) {
      throw new BadRequestException('无效的邮件状态');
    }
    return value as RakutenAutomationStatus;
  }

  private parseMailEvent(value: string): RakutenOrderMailEvent {
    if (!Object.values(RakutenOrderMailEvent).includes(value as RakutenOrderMailEvent)) {
      throw new BadRequestException('无效的邮件类型');
    }
    return value as RakutenOrderMailEvent;
  }

  private async requireConnection(idRaw: string): Promise<bigint> {
    const connectionId = parseId(idRaw, 'connectionId');
    const connection = await this.prisma.rakutenRmsConnection.findUnique({
      where: { id: connectionId },
      select: { id: true },
    });
    if (!connection) throw new NotFoundException('乐天连接不存在');
    return connectionId;
  }

  private validateMailTemplate(payload: MailTemplatePayload, event?: RakutenOrderMailEvent): MailTemplateDefinition {
    const subjectTemplate = String(payload.subjectTemplate ?? '').trim();
    const bodyTemplate = String(payload.bodyTemplate ?? '');
    if (!subjectTemplate) throw new BadRequestException('邮件主题不能为空');
    if (subjectTemplate.length > 255) throw new BadRequestException('邮件主题模板不能超过255个字符');
    if (/[\r\n]/.test(subjectTemplate)) throw new BadRequestException('邮件主题不能换行');
    if (!bodyTemplate.trim()) throw new BadRequestException('邮件正文不能为空');
    if (bodyTemplate.length > 50_000) throw new BadRequestException('邮件正文不能超过50000个字符');
    if (event && ['japan_shipped', 'china_customs', 'mixed_customs'].includes(event) && /本日発送/.test(bodyTemplate) || event && ['china_customs', 'mixed_customs'].includes(event) && /最短お届け日を設定/.test(bodyTemplate)) {
      throw new BadRequestException('模板含旧発送日期或送达日说明，请修订并明确启用新版');
    }
    const allowed = new Set(MAIL_TEMPLATE_VARIABLES.filter((variable) => event !== RakutenOrderMailEvent.new_order ||
      ['buyer_name', 'order_number', 'signature'].includes(variable.key)).map((variable) => variable.key));
    const subjectAllowed = new Set(['buyer_name', 'order_number']);
    const unknown = new Set<string>();
    const inspect = (source: string, valid: Set<string>) => {
      for (const match of source.matchAll(/{{([\s\S]*?)}}/g)) {
        const key = String(match[1] ?? '').trim();
        if (!/^[a-zA-Z0-9_]+$/.test(key) || !valid.has(key)) unknown.add(key || '(空变量)');
      }
      const withoutClosedVariables = source.replace(/{{[\s\S]*?}}/g, '');
      if (withoutClosedVariables.includes('{{') || withoutClosedVariables.includes('}}')) {
        throw new BadRequestException('模板变量括号不完整');
      }
    };
    inspect(subjectTemplate, subjectAllowed);
    inspect(bodyTemplate, allowed);
    if (unknown.size) throw new BadRequestException(`模板包含不支持的变量：${Array.from(unknown).join(', ')}`);
    return { subjectTemplate, bodyTemplate };
  }

  private parsePositiveInteger(
    raw: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new BadRequestException(`数值必须在${minimum}到${maximum}之间`);
    }
    return value;
  }

  private parseDateRange(
    dateFrom?: string,
    dateTo?: string,
  ): Prisma.DateTimeFilter | undefined {
    const parse = (raw: string, endOfDay: boolean): Date => {
      const normalized = raw.trim();
      const date = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
        ? new Date(`${normalized}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+09:00`)
        : new Date(normalized);
      if (Number.isNaN(date.getTime())) throw new BadRequestException('日期格式无效');
      return date;
    };
    const gte = dateFrom?.trim() ? parse(dateFrom, false) : undefined;
    const lte = dateTo?.trim() ? parse(dateTo, true) : undefined;
    if (gte && lte && gte > lte) throw new BadRequestException('开始日期不能晚于结束日期');
    if (!gte && !lte) return undefined;
    return { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
  }

  private serializeMail(mail: unknown): Record<string, unknown> {
    const serializeValue = (value: unknown): unknown => {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Date) return value.toISOString();
      if (Array.isArray(value)) return value.map(serializeValue);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .map(([key, child]) => [key, serializeValue(child)]),
        );
      }
      return value;
    };
    return serializeValue(mail) as Record<string, unknown>;
  }

  private async markMailFailed(id: bigint, attempts: number, error: unknown): Promise<FailureHandlingResult> {
    const classification = this.classifyFailure(error, 'mail');
    const exhausted = attempts >= MAX_ATTEMPTS;
    const deadLetter = exhausted || !classification.retryable;
    await this.prisma.rakutenOrderMail.update({
      where: { id },
      data: {
        status: deadLetter ? RakutenAutomationStatus.dead_letter : RakutenAutomationStatus.failed,
        lastError: this.errorMessage(error).slice(0, 10000),
        failureCategory: exhausted ? 'max_attempts' : classification.category,
        deadLetteredAt: deadLetter ? new Date() : null,
        nextAttemptAt: deadLetter ? null : this.nextRetry(attempts, `mail:${id.toString()}`),
        sendStartedAt: null,
      },
    });
    return { ...classification, deadLetter };
  }

  private async markMailUncertain(id: bigint, error: unknown): Promise<void> {
    await this.prisma.rakutenOrderMail.update({
      where: { id },
      data: {
        status: RakutenAutomationStatus.uncertain,
        lastError: `SMTP发送结果不确定：${this.errorMessage(error)}`.slice(0, 10000),
        failureCategory: 'smtp_uncertain',
        deadLetteredAt: null,
        nextAttemptAt: null,
      },
    });
  }

  private shouldOpenCircuit(result: FailureHandlingResult): boolean {
    return result.deadLetter && ['authentication', 'configuration'].includes(result.category);
  }

  private async openCircuit(
    connectionId: bigint,
    kind: 'shipping' | 'mail',
    reason: string,
  ): Promise<void> {
    const openedAt = new Date();
    await this.prisma.rakutenRmsConnection.update({
      where: { id: connectionId },
      data: kind === 'shipping'
        ? {
            shippingCircuitOpenedAt: openedAt,
            shippingCircuitReason: reason.slice(0, 10000),
          }
        : {
            mailCircuitOpenedAt: openedAt,
            mailCircuitReason: reason.slice(0, 10000),
          },
    });
    this.logger.error(
      `Rakuten ${kind} circuit opened for connection ${connectionId.toString()}: ${reason}`,
    );
  }

  private buildSmtpMessageId(mailId: bigint, fromAddress: string): string {
    const domain = String(fromAddress.split('@')[1] || 'mail.rakuten.local')
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, '') || 'mail.rakuten.local';
    return `<wms-rakuten-mail-${mailId.toString()}@${domain}>`;
  }

  private async createAudit(payload: AuditLogPayload): Promise<void> {
    if (!this.audit) return;
    await this.audit.create(payload);
  }

  private classifyFailure(error: unknown, kind: 'shipping' | 'mail'): FailureClassification {
    const record = error as { code?: unknown; responseCode?: unknown; status?: unknown; getStatus?: () => number };
    const code = String(record?.code ?? '').toUpperCase();
    const responseCode = Number(record?.responseCode ?? 0);
    const status = Number(typeof record?.getStatus === 'function' ? record.getStatus() : record?.status ?? 0);
    const message = this.errorMessage(error).toLowerCase();
    const httpStatus = Number(message.match(/http\s+(\d{3})/i)?.[1] ?? status ?? 0);
    if (
      code === 'EAUTH' || responseCode === 535 || [401, 403].includes(httpStatus) ||
      message.includes('authentication failed') || message.includes('认证失败') || message.includes('license已到期')
    ) {
      return { retryable: false, category: 'authentication' };
    }
    if (
      kind === 'mail' && (
        code === 'EENVELOPE' || [550, 551, 553].includes(responseCode) ||
        message.includes('recipient rejected') || message.includes('mailbox unavailable') ||
        message.includes('买家匿名邮箱')
      )
    ) {
      return { retryable: false, category: 'recipient' };
    }
    if (
      message.includes('smtp配置不完整') || message.includes('模板包含不支持') ||
      message.includes('渲染后的邮件主题无效')
    ) {
      return { retryable: false, category: 'configuration' };
    }
    if (
      message.includes('无法识别配送公司') || message.includes('订单明细不存在') ||
      [400, 404, 422].includes(httpStatus)
    ) {
      return { retryable: false, category: 'validation' };
    }
    if (httpStatus === 429 || responseCode === 421 || message.includes('rate limit') || message.includes('too many')) {
      return { retryable: true, category: 'rate_limit' };
    }
    if (
      httpStatus >= 500 || responseCode >= 400 && responseCode < 500 ||
      ['ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ECONNREFUSED', 'ENOTFOUND'].includes(code) ||
      message.includes('timeout') || message.includes('网络') || message.includes('tls') ||
      message.includes('connection reset') || message.includes('socket')
    ) {
      return { retryable: true, category: 'temporary_remote' };
    }
    return { retryable: false, category: 'unknown' };
  }

  private nextRetry(attempts: number, key: string): Date {
    const baseMinutes = Math.min(5 * 2 ** Math.max(0, attempts - 1), 360);
    const jitterByte = createHash('sha1').update(`${key}:${attempts}`).digest()[0] ?? 128;
    const jitterFactor = 0.8 + (jitterByte / 255) * 0.4;
    return new Date(Date.now() + Math.round(baseMinutes * jitterFactor * 60_000));
  }

  private jsonObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
