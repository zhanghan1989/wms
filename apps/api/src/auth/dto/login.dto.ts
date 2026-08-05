import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class LoginDto {
  @IsString()
  @Length(3, 64)
  username!: string;

  @IsString()
  @Length(6, 64)
  password!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  mfaCode?: string;
}
