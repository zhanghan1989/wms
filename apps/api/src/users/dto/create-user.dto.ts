import { Role } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @Length(3, 64)
  username!: string;

  @IsOptional()
  @IsEnum(Role)
  role: Role = Role.employee;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  department = 'china_warehouse';

  @IsOptional()
  @Min(0)
  @Max(1)
  status?: number;
}
