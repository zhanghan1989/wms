import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class UpdateUserOptionDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1)
  status?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;
}
