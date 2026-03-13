import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsString, Length, ValidateNested } from 'class-validator';

class TransportationSelectionDto {
  @IsString()
  @Length(1, 128)
  shipmentId!: string;

  @IsString()
  @Length(1, 128)
  transportationOptionId!: string;
}

export class ConfirmTransportationOptionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransportationSelectionDto)
  transportationSelections!: TransportationSelectionDto[];
}
