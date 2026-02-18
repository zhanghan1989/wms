import { IsString, Length } from 'class-validator';

export class LoginDto {
  @IsString()
  @Length(3, 64)
  username!: string;

  @IsString()
  @Length(6, 64)
  password!: string;
}
