import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class MasterProductBomItemDto {
  @IsString()
  componentProductId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(9999)
  quantity!: number;
}

export class UpdateMasterProductBomDto {
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => MasterProductBomItemDto)
  items!: MasterProductBomItemDto[];
}
