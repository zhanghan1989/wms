import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class ReplaceBoxPreviewDto {
  @IsString()
  @Length(1, 6)
  fromBoxCode!: string;

  @IsString()
  @Length(1, 6)
  toBoxCode!: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  shelfCode?: string;
}

export class ReplaceBoxDto extends ReplaceBoxPreviewDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  snapshotToken!: string;

  @IsString()
  @Matches(/^[a-zA-Z0-9-]{16,64}$/)
  operationId!: string;
}
