import { IsString, Length } from 'class-validator';

export class UpdateDomesticOrderNoDto {
  @IsString()
  @Length(1, 128)
  domesticOrderNo!: string;
}

export class UpdateSeaOrderNoDto {
  @IsString()
  @Length(1, 128)
  seaOrderNo!: string;
}
