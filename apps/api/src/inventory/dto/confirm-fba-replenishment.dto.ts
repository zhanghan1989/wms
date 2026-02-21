import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class ConfirmFbaReplenishmentDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  actualQty!: number;
}

