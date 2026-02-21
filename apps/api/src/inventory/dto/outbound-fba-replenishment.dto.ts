import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsString, Length, Min } from 'class-validator';

export class OutboundFbaReplenishmentDto {
  @IsArray()
  @ArrayMinSize(1)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids!: number[];

  @IsString()
  @Length(1, 128)
  expressNo!: string;
}

