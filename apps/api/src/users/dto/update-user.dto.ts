import { Role } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(6, 64)
  password?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @Min(0)
  @Max(1)
  status?: number;
}
