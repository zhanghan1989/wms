import { Type } from 'class-transformer';
import { IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';

export class CollectBatchInboundDto {
  @IsString()
  @Length(1, 32)
  @Matches(/^[A-Za-z0-9_-]+$/)
  batchNo!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  boxCount!: number;
}
