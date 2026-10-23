import { IsString, Length, Matches } from 'class-validator';
import { PASSWORD_MESSAGE, PASSWORD_PATTERN } from '../password-policy';

export class ChangePasswordDto {
  @IsString()
  @Length(6, 64)
  currentPassword!: string;

  @IsString()
  @Length(6, 64)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE })
  newPassword!: string;
}
