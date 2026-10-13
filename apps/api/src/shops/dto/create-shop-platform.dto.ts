import { IsString, Length } from 'class-validator';

export class CreateShopPlatformDto {
  @IsString()
  @Length(1, 128)
  name!: string;
}
