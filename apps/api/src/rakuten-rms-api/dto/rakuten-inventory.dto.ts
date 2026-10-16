import { IsBoolean, IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class SaveRakutenInventoryMappingDto {
  @IsString() @MaxLength(128) @Matches(/\S/) productId!: string;
  @IsString() @Matches(/^[a-zA-Z0-9_-]{1,32}$/) manageNumber!: string;
  @IsString() @Matches(/^[a-zA-Z0-9_-]{1,32}$/) variantId!: string;
  @IsInt() @Min(0) @Max(99999) safetyStock!: number;
  @IsBoolean() enabled!: boolean;
}
export class UpdateRakutenInventoryEnabledDto {
  @IsBoolean() enabled!: boolean;
}
export class ExecuteRakutenInventoryDto {
  @IsString() @Matches(/^[a-f0-9-]{36}$/) previewId!: string;
}
