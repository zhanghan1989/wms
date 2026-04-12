import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { StringValue } from 'ms';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    AuditModule,
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'wms-dev-secret',
      signOptions: {
        expiresIn: (process.env.JWT_EXPIRES_IN ?? '30d') as StringValue,
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
