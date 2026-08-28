import { Type } from 'class-transformer';
import { IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateShoulderStrapPartDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  partName!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999999999)
  stockQty!: number;
}
