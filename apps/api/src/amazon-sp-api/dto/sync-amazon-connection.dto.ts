import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class SyncAmazonConnectionDto {
  @IsOptional()
  @IsIn(['full', 'fbm_orders', 'fba_orders', 'fba_inventory'])
  syncType?: 'full' | 'fbm_orders' | 'fba_orders' | 'fba_inventory';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  initialLookbackDays?: number;
}
