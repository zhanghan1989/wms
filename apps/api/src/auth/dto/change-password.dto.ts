import { IsString, Length, Matches } from 'class-validator';
import { STRONG_PASSWORD_MESSAGE, STRONG_PASSWORD_PATTERN } from '../password-policy';

export class ChangePasswordDto {
  @IsString()
  @Length(6, 64)
  currentPassword!: string;

  @IsString()
  @Length(12, 64)
  @Matches(STRONG_PASSWORD_PATTERN, { message: STRONG_PASSWORD_MESSAGE })
  newPassword!: string;
}
