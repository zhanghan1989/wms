import { IsString, Length, Matches } from 'class-validator';

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

export class UpdateExpectedArrivalDateDto {
  @IsString()
  @Matches(/^(?:\d{4}-\d{2}-\d{2})?$/)
  expectedArrivalDate!: string;
}
