import { IsObject } from 'class-validator';

export class UpdateAmazonAutomationSummaryDto {
  @IsObject()
  summary!: Record<string, unknown>;
}
