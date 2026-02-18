import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BoxesController } from './boxes.controller';
import { BoxesService } from './boxes.service';

@Module({
  imports: [AuditModule],
  controllers: [BoxesController],
  providers: [BoxesService],
})
export class BoxesModule {}
