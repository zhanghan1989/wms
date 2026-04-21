import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

export class CreateRakutenComboProductDto {
  @IsString()
  @Transform(({ value }) => String(value ?? '').trim())
  comboName!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Transform(({ value }) => (Array.isArray(value) ? value.map((item) => String(item ?? '').trim()) : value))
  productIds!: string[];
}
