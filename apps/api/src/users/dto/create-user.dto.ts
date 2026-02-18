import { Role } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @Length(3, 64)
  username!: string;

  @IsString()
  @Length(6, 64)
  password!: string;

  @IsOptional()
  @IsEnum(Role)
  role: Role = Role.employee;

  @IsOptional()
  status?: number;
}
