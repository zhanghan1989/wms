import { Type } from 'class-transformer';
import { IsInt, IsString, Length, Min } from 'class-validator';

export class MoveProductBetweenBoxesDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  skuId!: number;

  @IsString()
  @Length(1, 128)
  fromBoxCode!: string;

  @IsString()
  @Length(1, 128)
  toBoxCode!: string;
}
