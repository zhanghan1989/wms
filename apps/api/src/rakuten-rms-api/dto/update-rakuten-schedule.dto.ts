import { IsBoolean } from 'class-validator';

export class UpdateRakutenScheduleDto {
  @IsBoolean()
  enabled!: boolean;
}
