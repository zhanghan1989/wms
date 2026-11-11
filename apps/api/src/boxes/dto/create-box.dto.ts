import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateBoxDto {
  @IsString()
  @Length(1, 128)
  boxCode!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  shelfId!: number;

  @IsOptional()
  @Min(0)
  @Max(1)
  status?: number;
}
