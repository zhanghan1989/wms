import { classifyNoSalesInventoryAge } from '../src/inventory/inventory-dashboard';
import { InventoryService } from '../src/inventory/inventory.service';

describe('inventory dashboard no-sales age classification', () => {
  const now = new Date('2026-07-22T12:00:00.000Z');

  it('keeps newly stocked products in observation until 90 complete days', () => {
    expect(classifyNoSalesInventoryAge(new Date('2026-07-21T12:00:00.000Z'), now)).toEqual({
      status: 'observing',
      observedDays: 1,
      remainingDays: 89,
    });
    expect(classifyNoSalesInventoryAge(new Date('2026-04-23T12:00:01.000Z'), now)).toEqual({
      status: 'observing',
      observedDays: 89,
      remainingDays: 1,
    });
  });

  it('marks a product obsolete only after 90 complete days without sales', () => {
    expect(classifyNoSalesInventoryAge(new Date('2026-04-23T12:00:00.000Z'), now)).toEqual({
      status: 'obsolete',
      observedDays: 90,
      remainingDays: 0,
    });
  });

  it('does not treat products with an unknown first-stock date as obsolete', () => {
    expect(classifyNoSalesInventoryAge(null, now)).toEqual({
      status: 'unknown',
      observedDays: null,
      remainingDays: null,
    });
  });

  it('does not export factory recommendations before an FBA report is selected', async () => {
    const service = new InventoryService({} as never, {} as never);
    await expect(service.buildProductionRecommendationsExcel()).rejects.toThrow(
      '请先上传最近90天FBA销售报告',
    );
    await expect(service.getOverviewDashboard({ includeFba: true })).rejects.toThrow(
      '请先上传最近90天FBA销售报告',
    );
  });
});
