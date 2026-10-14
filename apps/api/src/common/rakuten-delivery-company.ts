export function rakutenDeliveryCompanyCode(company: unknown): '1001' | '1002' | '1003' {
  const value = String(company ?? '').trim().toLowerCase();
  if (value.includes('yamato') || value.includes('ヤマト')) return '1001';
  if (value.includes('xiya-sagawa') || value.includes('sagawa') || value.includes('佐川')) return '1002';
  if (value.includes('japan post') || value.includes('日本郵便')) return '1003';
  throw new Error(`无法识别配送公司“${String(company ?? '')}”，请修正后再回传`);
}
