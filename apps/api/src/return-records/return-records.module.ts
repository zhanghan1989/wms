import { Module } from '@nestjs/common';
import { ReturnRecordsController } from './return-records.controller';
import { ReturnRecordsService } from './return-records.service';

@Module({
  controllers: [ReturnRecordsController],
  providers: [ReturnRecordsService],
})
export class ReturnRecordsModule {}
