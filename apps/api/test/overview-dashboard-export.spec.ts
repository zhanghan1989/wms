import * as XLSX from 'xlsx';
import { InventoryService } from '../src/inventory/inventory.service';

describe('system dashboard Excel export', () => {
  it('exports the full lists and keeps the selected period and production period distinct', async () => {
    const data = {
      generatedAt: '2026-10-27T00:00:00Z',
      period: { month: '2024-02', days: 29, start: '2024-01-31T15:00:00Z', end: '2024-02-29T15:00:00Z' },
      summary: { activeUserCount: 2 }, health: { totalStock: 42 }, orders30d: { totalOrderCount: 3 },
      demand: { outboundQty90d: 120, topSkus: Array.from({ length: 65 }, (_, index) => ({
        productId: `P${index}`, totalOrderQty90d: index + 1,
      })), anomalySkus: [], unmatchedSystemOrders90d: { details: [] } },
      production: { periodDays: 90, recommendations: [{ productId: 'P0', totalOrderQty90d: 999 }] },
      obsolete: { noSales90dSkus: [] },
    };
    const service = new InventoryService({} as never, {} as never);
    const load = jest.spyOn(service, 'getOverviewDashboard').mockResolvedValue(data);
    const file = await service.buildOverviewDashboardExcel({ month: '2024-02', fbaSnapshotId: '10' });
    expect(load).toHaveBeenCalledWith({ month: '2024-02', fbaSnapshotId: '10' });
    expect(file.fileName).toBe('系统看板_2024-02.xlsx');
    const workbook = XLSX.read(file.content, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets['商品排行']);
    expect(rows).toHaveLength(65);
    expect(rows[64]).toMatchObject({ '产品ID': 'P64', '所选周期合计出单件数': 65 });
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['备货建议（近90天）'])[0])
      .toMatchObject({ '近90天合计出单件数': 999 });
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['统计说明'])[0]).toMatchObject({ '月份': '2024-02', '统计天数': 29 });
  });
});
