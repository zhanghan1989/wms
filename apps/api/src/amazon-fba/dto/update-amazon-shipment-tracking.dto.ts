import { Transform, Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsOptional, IsString, Length, ValidateNested } from 'class-validator';

class AmazonShipmentBoxTrackingItemDto {
  @IsString()
  @Length(1, 128)
  boxId!: string;

  @IsString()
  @Length(1, 128)
  trackingId!: string;
}

export class UpdateAmazonShipmentTrackingDto {
  @IsOptional()
  @IsString()
  @Length(1, 128)
  trackingId?: string;

  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value
      : [],
  )
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AmazonShipmentBoxTrackingItemDto)
  boxTrackingItems?: AmazonShipmentBoxTrackingItemDto[];
}
