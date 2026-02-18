import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ShelvesController } from './shelves.controller';
import { ShelvesService } from './shelves.service';

@Module({
  imports: [AuditModule],
  controllers: [ShelvesController],
  providers: [ShelvesService],
})
export class ShelvesModule {}
