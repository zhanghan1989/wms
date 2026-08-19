import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsString, Length, Matches } from "class-validator";

export class IgnoreRakutenRmsConflictsDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  previewToken!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  itemKeys!: string[];
}
