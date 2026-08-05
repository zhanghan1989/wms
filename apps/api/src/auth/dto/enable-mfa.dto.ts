import { IsString, Matches } from 'class-validator';

export class EnableMfaDto {
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
