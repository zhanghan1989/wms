import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { StocktakePlannerController } from './stocktake-planner.controller';
import { StocktakePlannerService } from './stocktake-planner.service';

@Module({
  imports: [AuditModule],
  controllers: [StocktakePlannerController],
  providers: [StocktakePlannerService],
})
export class StocktakePlannerModule {}
