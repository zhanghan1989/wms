import { IsOptional, IsString, Length } from 'class-validator';

export class UpdateMasterProductPrintSettingsDto {
  @IsOptional()
  @IsString()
  @Length(0, 128)
  yamatoPrinterName?: string;
}
