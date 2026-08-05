import { IsString, Length, Matches } from 'class-validator';
import {
  STRONG_PASSWORD_MESSAGE,
  STRONG_PASSWORD_PATTERN,
} from '../../auth/password-policy';

export class ResetUserPasswordDto {
  @IsString()
  @Length(12, 64)
  @Matches(STRONG_PASSWORD_PATTERN, { message: STRONG_PASSWORD_MESSAGE })
  password!: string;
}
