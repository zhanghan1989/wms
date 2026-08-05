import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Role } from '@prisma/client';
import { AuthUser } from '../common/types/auth-user.type';
import { getJwtSecret } from './jwt-config';

interface JwtPayload {
  sub: string;
  username: string;
  role: Role;
  mfaPending?: boolean;
  passwordChangeRequired?: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (!payload.sub || !payload.username || !payload.role) {
      throw new UnauthorizedException('登录令牌无效');
    }
    return {
      id: BigInt(payload.sub),
      username: payload.username,
      role: payload.role,
      mfaPending: payload.mfaPending === true,
      passwordChangeRequired: payload.passwordChangeRequired === true,
    };
  }
}
