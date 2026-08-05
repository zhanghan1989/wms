import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { StringValue } from 'ms';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthMfaService } from './auth-mfa.service';
import { JwtStrategy } from './jwt.strategy';
import { getJwtSecret } from './jwt-config';

@Module({
  imports: [
    AuditModule,
    PassportModule,
    JwtModule.register({
      secret: getJwtSecret(),
      signOptions: {
        expiresIn: (process.env.JWT_EXPIRES_IN ?? '12h') as StringValue,
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthMfaService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
