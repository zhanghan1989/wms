import { Type } from 'class-transformer';
import { IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';

export class CollectBatchInboundDto {
  @IsString()
  @Length(1, 20)
  @Matches(/^[1-9]\d*$/)
  batchNo!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  boxCount!: number;
}
