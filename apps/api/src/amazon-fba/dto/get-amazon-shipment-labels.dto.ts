import { Transform } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class GetAmazonShipmentLabelsDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  labelType?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  pageType?: string;

  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value
      : String(value || '')
          .split(',')
          .map((item) => String(item || '').trim())
          .filter(Boolean),
  )
  @IsArray()
  @IsString({ each: true })
  packageLabelsToPrint?: string[];

  @IsOptional()
  @Transform(({ value }) => (value === '' || value === null || value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  numberOfPackages?: number;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  pageSize?: string;
}
