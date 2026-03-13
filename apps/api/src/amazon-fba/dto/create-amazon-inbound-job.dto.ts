import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, Min } from 'class-validator';

export class CreateAmazonInboundJobDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  connectionId!: number;

  @IsArray()
  @ArrayMinSize(1)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  fbaReplenishmentIds!: number[];
}
