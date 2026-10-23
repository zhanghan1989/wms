import { IsString, Length, Matches } from 'class-validator';
import {
  PASSWORD_MESSAGE,
  PASSWORD_PATTERN,
} from '../../auth/password-policy';

export class ResetUserPasswordDto {
  @IsString()
  @Length(6, 64)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE })
  password!: string;
}
