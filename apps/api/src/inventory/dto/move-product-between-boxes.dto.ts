import { IsString, Length } from 'class-validator';

export class MoveProductBetweenBoxesDto {
  @IsString()
  @Length(1, 128)
  productId!: string;

  @IsString()
  @Length(1, 128)
  fromBoxCode!: string;

  @IsString()
  @Length(1, 128)
  toBoxCode!: string;
}
