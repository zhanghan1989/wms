import { originalRakutenOrderId } from '../common/rakuten-order-identity';
import { createHash } from 'crypto';
import { RakutenOrderMail, RakutenOrderRecord, RakutenOrderShippingReport, RakutenRmsConnection } from '@prisma/client';

export type Fulfillment = 'japan' | 'china' | 'mixed';
export type WorkflowState = 'waiting' | 'ready' | 'manual' | 'retry' | 'done';
export const VERIFIED_SHIPPING = '乐天侧在本次自动任务前已经存在相同快递单号，按人工或其他系统回传处理';
export const IGNORED_MAIL = '用户人工忽略邮件';
const CANCELLED_ORDER_REASON = '订单已取消，流程已终止';
function orderCancellationConfirmed(rows: RakutenOrderRecord[], report?: Pick<RakutenOrderShippingReport, 'status' | 'lastError'> | null): boolean {
  // RMS imports only status 300, so a later getOrder cancellation may exist only
  // in the saved shipping result. Status 800 is still a cancellation request.
  return rows.some((row) => String(row.orderStatusText ?? '').trim() === '900') ||
    Boolean(report?.status === 'skipped' && /^乐天订单当前状态为\s*900[，,]/.test(report.lastError ?? ''));
}
export function validOrderQuantity(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}
export const isChinaRow = (row: Pick<RakutenOrderRecord, 'dispatchMode'>) =>
  ['china_pending', 'china_no_stock'].includes(String(row.dispatchMode ?? '').trim());
export function fulfillmentOf(rows: RakutenOrderRecord[]): Fulfillment {
  const china = rows.some(isChinaRow);
  return china && rows.some((row) => !isChinaRow(row)) ? 'mixed' : china ? 'china' : 'japan';
}
export function basketIdOf(row: RakutenOrderRecord): number | null {
  const root = row.rawPayload as Record<string, any> | null;
  const value = root?.rmsPackage?.basketId ?? root?.rmsPackage?.BasketId ?? root?.['送付先ID'];
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : null;
}
export function trackingReady(rows: RakutenOrderRecord[], customs = false): boolean {
  return rows.length > 0 && rows.every((row) => basketIdOf(row) !== null &&
    Boolean(String(row.shipmentNo ?? '').trim()) &&
    (customs ? row.trackingHasCustomsClearance === true && Boolean(row.trackingCustomsClearanceDate)
      : Boolean(row.shipmentNoRegisteredAt)));
}
export function japanWarehouseReady(rows: RakutenOrderRecord[]): boolean {
  return rows.length > 0 && rows.every((row) => !isChinaRow(row) && Boolean(row.warehouseShippedAt));
}
export function shippingTargetRows(rows: RakutenOrderRecord[], type: string = fulfillmentOf(rows)): RakutenOrderRecord[] {
  const split = rows.some((row) => row.orderId !== originalRakutenOrderId(row));
  return split ? rows : rows.filter((row) => type === 'japan' ? !isChinaRow(row) : isChinaRow(row));
}
export function shippingTargetsReady(rows: RakutenOrderRecord[], type: string = fulfillmentOf(rows)): boolean {
  const targets = shippingTargetRows(rows, type);
  return targets.length > 0 && targets.every((row) => trackingReady([row], isChinaRow(row)) &&
    (isChinaRow(row) || japanWarehouseReady([row])));
}
export function shippingFingerprint(rows: RakutenOrderRecord[], type: Fulfillment = fulfillmentOf(rows)): string {
  const baskets = new Map<number, Map<string, RakutenOrderRecord>>();
  for (const row of shippingTargetRows(rows, type)) {
    const id = basketIdOf(row);
    const number = String(row.shipmentNo ?? '').trim();
    const date = isChinaRow(row) ? row.trackingCustomsClearanceDate : row.warehouseShippedAt;
    if (id === null || !number || !date) continue;
    const numbers = baskets.get(id) ?? new Map<string, RakutenOrderRecord>();
    if (!numbers.has(number)) numbers.set(number, row);
    baskets.set(id, numbers);
  }
  const dateString = (date: Date) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  return createHash('sha1').update(JSON.stringify(Array.from(baskets, ([basketId, numbers]) => ({
    basketId,
    ShippingModelList: Array.from(numbers, ([shippingNumber, row]) => ({
      shippingNumber, deliveryCompany: String(row.shipmentCompany ?? '').trim(),
      shippingDate: dateString((isChinaRow(row) ? row.trackingCustomsClearanceDate : row.warehouseShippedAt)!), shippingDeleteFlag: 0,
    })),
  })))).digest('hex');
}
export function orderBlockReason(rows: RakutenOrderRecord[], includeBusinessChanges = true): string | null {
  if (!rows.length) return '订单明细不存在或已逻辑删除';
  if (rows.some((row) => row.deletedAt)) return '订单已人工确认逻辑删除，流程已终止';
  if (rows.some((row) => /^(800|900)$|キャンセル|cancel|取消/i.test(String(row.orderStatusText ?? '').trim()))) {
    return '订单已取消或正在取消，请人工核对';
  }
  if (includeBusinessChanges && rows.some((row) => row.rmsManualActionDetectedAt && !row.rmsManualActionResolvedAt)) {
    return '订单有尚未处理的业务变更，请先处理';
  }
  return null;
}
// Product-ID edits and a purchased combo split across Japan/China need review.
export function hasRemovedOrderItems(rows: RakutenOrderRecord[]): boolean {
  return rows.some((row) => Boolean((row.rawPayload as Record<string, unknown> | null)?._wmsDeletedItemsAt));
}
export function productIdWasManuallyEdited(row: RakutenOrderRecord): boolean {
  const raw = row.rawPayload as Record<string, any> | null;
  if (raw?._wmsProductIdEdited === true) return true;
  if (!row.rmsManualOverrideAt) return false;
  // Legacy form saves list every editable field, even when only an address or
  // remark changed. Compare with the imported product instead of that list.
  if (row.isComboOrder) {
    const originalComponent = row.rmsItemKey?.split('|component:')[1];
    // Long import keys end with a hash; a truncated component is not evidence
    // that its product ID changed.
    return Boolean(originalComponent && !originalComponent.includes('|') &&
      originalComponent.trim() !== String(row.skuCode ?? '').trim());
  }
  const item = raw?.rmsItem;
  const sku = (item?.SkuModelList ?? item?.skuModelList)?.[0];
  const originalSku = raw?._wmsImportedProductId || sku?.variantId;
  return Boolean(originalSku) && String(originalSku).trim() !== String(row.skuCode ?? '').trim();
}
export function hasMixedDispatchCombo(rows: RakutenOrderRecord[]): boolean {
  const origins = new Map<string, Set<'japan' | 'china'>>();
  for (const row of rows) {
    if (!row.isComboOrder || row.deletedAt) continue;
    const raw = row.rawPayload as Record<string, any> | null;
    const item = raw?.rmsItem;
    // Components share the original purchased item, even after a WMS split.
    // Basket and order identity distinguish separate purchases of the same set.
    const itemId = String(item?.itemDetailId ?? item?.ItemDetailId ?? '').trim();
    const itemKey = String(row.rmsItemKey ?? '').split('|component:')[0];
    const key = JSON.stringify([row.rmsConnectionId?.toString() ?? null, originalRakutenOrderId(row),
      basketIdOf(row), itemId || itemKey || row.comboOrderSku || row.setComponentSkuCode]);
    const group = origins.get(key) ?? new Set<'japan' | 'china'>();
    group.add(isChinaRow(row) ? 'china' : 'japan');
    if (group.size === 2) return true;
    origins.set(key, group);
  }
  return false;
}
export type MailReviewReason = 'manual_update' | 'combo_order' | 'manual_update_and_combo';
export function mailReviewMessage(reason: MailReviewReason | null): string | null {
  if (reason === 'combo_order') return '同一组合商品的组件分别从日本和中国发货，请拆分邮件中的「種類」并确认正文';
  if (reason === 'manual_update_and_combo') return '请核对产品ID修改或商品信息异常，并拆分日中混发组合商品在邮件中的「種類」后确认正文';
  return reason === 'manual_update' ? '请人工核对产品ID修改或商品信息异常后确认正文' : null;
}
export function mailReviewReason(rows: RakutenOrderRecord[]): MailReviewReason | null {
  const manual = hasRemovedOrderItems(rows) || rows.some((row) =>
    validOrderQuantity(row.orderQuantity) === null || productIdWasManuallyEdited(row));
  const combo = hasMixedDispatchCombo(rows);
  return manual && combo ? 'manual_update_and_combo' : manual ? 'manual_update' : combo ? 'combo_order' : null;
}
export function mailOrderBlockReason(event: string, rows: RakutenOrderRecord[]) {
  return orderBlockReason(rows, event !== 'new_order');
}
export function mailEventReviewReason(event: string, rows: RakutenOrderRecord[]) {
  return event === 'new_order' ? null : mailReviewReason(rows);
}
export function mailSatisfied(mail: Pick<RakutenOrderMail, 'status'> & Partial<Pick<RakutenOrderMail, 'resolutionNote'>> | null | undefined): boolean {
  return mail?.status === 'sent' || (mail?.status === 'cancelled' && mail.resolutionNote === IGNORED_MAIL);
}
export function shippingSatisfied(report: Pick<RakutenOrderShippingReport, 'status' | 'lastError'> | null | undefined): boolean {
  return report?.status === 'sent' || (report?.status === 'skipped' && report.lastError === VERIFIED_SHIPPING);
}
export function shippingConditionReason(rows: RakutenOrderRecord[], type: string, newOrderCompleted: boolean): string | null {
  const block = orderBlockReason(rows);
  if (block) return block;
  if (fulfillmentOf(rows) !== type) return '订单发货类型已变化，请人工核对';
  if (!newOrderCompleted) return '等待新規完成或人工忽略后回传';
  const targets = shippingTargetRows(rows, type);
  const japan = targets.filter((row) => !isChinaRow(row));
  const china = targets.filter(isChinaRow);
  if (japan.length && !japanWarehouseReady(japan)) return '等待仓库点击5确认本批次作业完成并实际出货';
  if (japan.length && !trackingReady(japan)) return '等待日本侧全部包裹单号及登记日期';
  if (china.length && !trackingReady(china, true)) return '等待中国侧全部包裹通関許可及清关日期';
  if (!targets.length) return '等待全部目标包裹资料';
  return null;
}
export function mailConditionReason(event: string, rows: RakutenOrderRecord[], report?: (Pick<RakutenOrderShippingReport, 'status' | 'lastError'> & Partial<Pick<RakutenOrderShippingReport, 'fingerprint' | 'fulfillmentType'>>) | null): string | null {
  if (orderCancellationConfirmed(rows, report)) return CANCELLED_ORDER_REASON;
  const block = mailOrderBlockReason(event, rows);
  if (block) return block;
  const type = fulfillmentOf(rows);
  const china = rows.filter(isChinaRow);
  const japan = rows.filter((row) => !isChinaRow(row));
  if (event === 'new_order') return null;
  if (['japan_shipped', 'china_customs', 'mixed_customs'].includes(event) && report?.status === 'skipped' && !shippingSatisfied(report)) return '单号回传已跳过但未核实完成，请人工核对后续邮件';
  if (['japan_shipped', 'china_customs', 'mixed_customs'].includes(event) && shippingSatisfied(report) && report?.fingerprint &&
    (report.fulfillmentType !== type || !shippingTargetsReady(rows, type) || report.fingerprint !== shippingFingerprint(rows, type))) return '回传后包裹信息已变化，请人工核对';
  if (event === 'japan_shipped') {
    if (type !== 'japan') return '发货类型已变化，请人工核对';
    if (!japanWarehouseReady(japan)) return '等待仓库点击5确认本批次作业完成并实际出货';
    if (!trackingReady(japan)) return '等待日本侧全部包裹单号及登记日期';
    if (!shippingSatisfied(report)) return '等待日本侧单号回传完成';
    if (report?.status === 'skipped') return '乐天已有单号，请确认外部是否已发送日本発邮件';
  }
  if (event === 'china_delay') {
    if (type !== 'china') return '发货类型已变化，请人工核对';
    if (!trackingReady(china)) return '等待中国侧全部包裹单号及登记日期';
  }
  if (event === 'mixed_partial') {
    if (type !== 'mixed') return '发货类型已变化，请人工核对';
    if (!japanWarehouseReady(japan)) return '等待仓库点击5确认日本侧全部包裹实际出货';
    if (!trackingReady(japan)) return '等待日本侧全部包裹单号及登记日期';
  }
  if (event === 'china_customs' || event === 'mixed_customs') {
    if (type !== (event === 'mixed_customs' ? 'mixed' : 'china')) return '发货类型已变化，请人工核对';
    if (!trackingReady(china, true)) return '等待中国侧全部包裹通関許可及清关日期';
    if (!shippingSatisfied(report)) return '等待中国侧单号回传完成';
    if (report?.status === 'skipped') return '乐天已有中国侧单号，请确认外部是否已发送后续邮件';
  }
  return null;
}
const labels: Record<string, string> = {
  shipping: '单号回传', new_order: '新規', japan_shipped: '日本発', china_delay: '中国発1',
  china_customs: '中国発2', mixed_partial: '混発1', mixed_customs: '混発2',
};
export function buildOrderWorkflow(input: {
  rows: RakutenOrderRecord[];
  connection: RakutenRmsConnection & { shop: { name: string } };
  report: RakutenOrderShippingReport | null;
  mails: RakutenOrderMail[];
  templateVersions: Map<string, number>;
  now?: Date;
}) {
  const { rows, connection, report, mails, templateVersions } = input;
  const now = input.now ?? new Date();
  const fulfillmentType = fulfillmentOf(rows);
  const first = fulfillmentType === 'japan' ? 'japan_shipped' : fulfillmentType === 'china' ? 'china_delay' : 'mixed_partial';
  const second = fulfillmentType === 'china' ? 'china_customs' : fulfillmentType === 'mixed' ? 'mixed_customs' : null;
  const events = ['new_order', 'shipping', first, ...(second ? [second] : [])];
  const cancelled = orderCancellationConfirmed(rows, report);
  const block = orderBlockReason(rows);
  const steps = events.map((event) => {
    const shipping = event === 'shipping';
    const stepBlock = shipping ? block : mailOrderBlockReason(event, rows);
    const job = shipping ? report : mails.find((mail) => mail.event === event);
    let state: WorkflowState = 'waiting';
    let reason: string | null = null;
    const mail = shipping ? null : job as RakutenOrderMail | undefined;
    const templateVersion = shipping ? null : templateVersions.get(event) ?? null;
    const review = !shipping ? mailEventReviewReason(event, rows) : null;
    let condition = shipping
      ? shippingConditionReason(rows, report?.fulfillmentType ?? fulfillmentType, mailSatisfied(mails.find((item) => item.event === 'new_order')))
      : mailConditionReason(event, rows, report);
    if (condition?.includes('外部') && mail?.resolutionNote === '用户确认重新发送结果不确定的邮件') condition = null;
    const prerequisite = event === 'new_order' || shipping ? null : event === 'china_customs' ? 'china_delay'
      : event === 'mixed_customs' ? 'mixed_partial' : 'new_order';
    const terminated = cancelled && !(shipping ? shippingSatisfied(report) : job && ['sent', 'cancelled'].includes(job.status));
    if (cancelled) {
      state = 'done';
      reason = terminated ? CANCELLED_ORDER_REASON
        : mail?.status === 'cancelled' ? mail.resolutionNote ?? '邮件已取消' : null;
    } else if (shipping && report && shippingSatisfied(report) && report.fingerprint &&
      (report.fulfillmentType !== fulfillmentType || !shippingTargetsReady(rows, fulfillmentType) || report.fingerprint !== shippingFingerprint(rows, fulfillmentType))) {
      state = 'manual'; reason = '完成回传后单号、配送公司、日期或发货范围已变化，请人工核对';
    } else if (job && ['sent', 'skipped', 'cancelled'].includes(job.status)) {
      state = 'done';
      reason = shipping && report?.status === 'skipped' ? report.lastError
        : mail?.status === 'cancelled' ? mail.resolutionNote ?? '邮件已取消' : null;
    } else if (job?.status === 'processing') {
      reason = '正在执行';
    } else if (stepBlock) { state = 'manual'; reason = stepBlock;
    } else if (!connection.status || !(shipping ? connection.autoShippingEnabled : connection.mailNotificationsEnabled)) {
      reason = '店铺功能未启用';
    } else if (shipping ? connection.shippingCircuitOpenedAt : connection.mailCircuitOpenedAt) {
      state = 'manual'; reason = '店铺功能已暂停，需要人工恢复';
    } else if (job?.status === 'uncertain' || job?.status === 'dead_letter') {
      state = 'manual'; reason = job.lastError ?? '需要人工处理';
    } else if (shipping && report && fulfillmentType !== report.fulfillmentType) {
      state = 'manual'; reason = '发货类型已变化，请人工核对';
    } else if (shipping && condition) {
      reason = condition;
    } else if (!shipping && prerequisite && !mailSatisfied(mails.find((item) => item.event === prerequisite))) {
      const previous = mails.find((item) => item.event === prerequisite);
      // First China/mixed notifications are created only when tracking/dispatch
      // conditions are ready; their absence before then is normal workflow waiting.
      const awaitingFirstMail = !previous && ['china_delay', 'mixed_partial'].includes(prerequisite);
      if (awaitingFirstMail) {
        reason = condition ?? `等待前置邮件 ${labels[prerequisite]} 生成并完成或人工忽略`;
        state = condition?.includes('人工') || condition?.includes('外部') ? 'manual' : 'waiting';
      } else {
        state = previous?.status === 'cancelled' ? 'done' : !previous || previous.status === 'dead_letter' ? 'manual' : 'waiting';
        reason = previous?.status === 'cancelled' ? '前置邮件已取消，后续邮件停止' : !previous ? `缺少前置邮件 ${labels[prerequisite]}，请人工核对`
          : `等待前置邮件 ${labels[prerequisite]} 完成或人工忽略`;
      }
    } else if (!shipping && condition) {
      reason = condition;
      if (reason?.includes('人工') || reason?.includes('外部')) state = 'manual';
    } else if (!shipping && !templateVersion) {
      state = 'manual'; reason = mail?.failureCategory === 'template_missing'
        ? mail.lastError ?? '请修正并启用邮件模板' : '尚未配置并启用该邮件模板';
    } else if (!job) {
      state = event === 'new_order' || event === 'japan_shipped' && shippingSatisfied(report) ? 'manual' : 'waiting';
      reason = event === 'new_order' ? '缺少新規任务，请人工核对后补发或确认无需发送'
        : event === 'japan_shipped' && shippingSatisfied(report) ? '缺少日本発任务，请人工核对发送记录后补建或确认无需发送' : '条件已满足，等待下一轮整理任务';
    } else if (job.nextAttemptAt && job.nextAttemptAt > now) {
      state = 'retry'; reason = `等待重试时间 ${job.nextAttemptAt.toISOString()}`;
    } else if (review) {
      state = 'manual'; reason = review === 'manual_update'
        ? '订单产品ID修改或商品信息异常，请核对并确认正文' : mailReviewMessage(review);
    } else {
      state = job.status === 'failed' ? 'retry' : 'ready';
      reason = job.status === 'failed' ? job.lastError : null;
    }
    const executable = Boolean(job && ['pending', 'failed'].includes(job.status) &&
      (state === 'ready' || state === 'retry' && (!job.nextAttemptAt || job.nextAttemptAt <= now)));
    const canReviewBody = Boolean(mail && ['pending', 'failed'].includes(mail.status) && state === 'manual' && review &&
      templateVersion && !stepBlock && !condition && connection.status && connection.mailNotificationsEnabled &&
      !connection.mailCircuitOpenedAt && (!prerequisite || mailSatisfied(mails.find((item) => item.event === prerequisite))));
    return {
      event, label: labels[event], state, reason, status: job?.status ?? null,
      id: job?.id.toString() ?? null, kind: shipping ? 'shipping' : 'mail', templateVersion,
      executable, canReviewBody, requiresManualReview: Boolean(review), manualReviewReason: review,
      outcome: terminated ? 'terminated' : job?.status === 'sent' ? 'completed' : shipping && report?.status === 'skipped' && shippingSatisfied(report) ? 'verified'
        : mail?.status === 'cancelled' && mail.resolutionNote === IGNORED_MAIL ? 'ignored' : job?.status ?? null,
      completedAt: shipping ? report?.reportedAt?.toISOString() ?? null : mail?.sentAt?.toISOString() ?? null,
    };
  });
  return {
    connectionId: connection.id.toString(), shopName: connection.shop.name,
    orderId: rows[0] ? originalRakutenOrderId(rows[0]) : undefined,
    internalOrderIds: [...new Set(rows.map((row) => row.orderId).filter(Boolean))],
    fulfillmentType, steps,
    state: steps.some((step) => step.state === 'manual') ? 'manual'
      : steps.every((step) => step.state === 'done') ? 'done' : 'processing',
  };
}
