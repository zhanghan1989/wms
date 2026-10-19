/** Confirmation is tied to the saved remark so subsequent changes require review again. */
export function rakutenOrderRemarkNeedsConfirmation(row: { orderRemark?: string | null; rawPayload?: unknown }): boolean {
  const remark = String(row.orderRemark ?? '').trim();
  if (remark === '[配送日時指定:]') return false;
  const raw = row.rawPayload;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true;
  const confirmation = raw as Record<string, unknown>;
  return !(typeof confirmation._wmsRemarkConfirmedAt === 'string' && confirmation._wmsRemarkConfirmedAt &&
    typeof confirmation._wmsRemarkConfirmedValue === 'string' && confirmation._wmsRemarkConfirmedValue.trim() === remark);
}
