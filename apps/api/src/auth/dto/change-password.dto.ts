import { IsString, Length } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @Length(6, 64)
  currentPassword!: string;

  @IsString()
  @Length(6, 64)
  newPassword!: string;
}

