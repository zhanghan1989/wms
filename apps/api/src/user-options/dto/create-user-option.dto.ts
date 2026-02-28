import { Department, Role } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateDepartmentOptionDto {
  @IsEnum(Department)
  code!: Department;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;
}

export class CreateRoleOptionDto {
  @IsOptional()
  @IsEnum(Role)
  code?: Role;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;
}
