import { Module } from '@nestjs/common';
import { UserOptionsController } from './user-options.controller';
import { UserOptionsService } from './user-options.service';

@Module({
  controllers: [UserOptionsController],
  providers: [UserOptionsService],
  exports: [UserOptionsService],
})
export class UserOptionsModule {}
