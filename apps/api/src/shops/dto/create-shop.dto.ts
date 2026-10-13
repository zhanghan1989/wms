import { IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateShopDto {
  @IsString()
  @Length(1, 128)
  name!: string;

  @IsString()
  @Length(1, 64)
  platform!: string;

  @IsOptional()
  @Min(0)
  @Max(1)
  status?: number;
}
