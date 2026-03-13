import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

class GenerateTransportationShipmentConfigurationDto {
  @IsString()
  @Length(1, 128)
  shipmentId!: string;

  @IsOptional()
  @IsISO8601()
  readyToShipWindowStart?: string;

  @IsOptional()
  @IsObject()
  freightInformation?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  pallets?: Record<string, unknown>[];
}

export class GenerateTransportationOptionsDto {
  @IsString()
  @Length(1, 128)
  placementOptionId!: string;

  @IsOptional()
  @IsISO8601()
  readyToShipWindowStart?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GenerateTransportationShipmentConfigurationDto)
  shipmentConfigurations?: GenerateTransportationShipmentConfigurationDto[];
}
