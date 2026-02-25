import { Department, Role } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(3, 64)
  username?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsEnum(Department)
  department?: Department;

  @IsOptional()
  @Min(0)
  @Max(1)
  status?: number;
}
