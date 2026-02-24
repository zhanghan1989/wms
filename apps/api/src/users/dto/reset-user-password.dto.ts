import { IsString, Length } from 'class-validator';

export class ResetUserPasswordDto {
  @IsString()
  @Length(6, 64)
  password!: string;
}

