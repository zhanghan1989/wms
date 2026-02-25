import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { UserOptionsModule } from '../user-options/user-options.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuditModule, UserOptionsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
