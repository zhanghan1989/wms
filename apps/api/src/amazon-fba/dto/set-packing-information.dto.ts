import { IsObject } from 'class-validator';

export class SetPackingInformationDto {
  @IsObject()
  packingInformation!: Record<string, unknown>;
}
