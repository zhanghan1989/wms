import { Role } from '@prisma/client';
import { IsEnum, Matches, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d*$/)
  companyId?: string;

  @IsOptional()
  @IsString()
  @Length(3, 64)
  username?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  department?: string;

  @IsOptional()
  @Min(0)
  @Max(1)
  status?: number;
}
