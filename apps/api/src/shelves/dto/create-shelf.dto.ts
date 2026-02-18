import { IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateShelfDto {
  @IsString()
  @Length(1, 64)
  shelfCode!: string;

  @IsOptional()
  @IsString()
  @Length(1, 128)
  name?: string;

  @IsOptional()
  @Min(0)
  @Max(1)
  status?: number;
}
