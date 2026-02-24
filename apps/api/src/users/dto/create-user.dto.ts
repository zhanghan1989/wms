import { Role } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length, Max, Min } from 'class-validator';

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
  @Min(0)
  @Max(1)
  status?: number;
}
