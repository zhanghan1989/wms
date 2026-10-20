import { IsString, Length, Matches } from 'class-validator';

export class PreregisterBatchInboundDto {
  @IsString()
  @Length(1, 48)
  @Matches(/^[A-Za-z0-9_-]+$/)
  batchNo!: string;
}
