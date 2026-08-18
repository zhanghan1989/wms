import { IsString, Matches } from 'class-validator';

export class SyncRakutenRmsConnectionDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  previewToken!: string;
}
