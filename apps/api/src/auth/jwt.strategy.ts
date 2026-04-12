import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Role } from '@prisma/client';
import { AuthUser } from '../common/types/auth-user.type';

interface JwtPayload {
  sub: string;
  username: string;
  role: Role;
  deployVersion: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly deploySessionVersion =
    String(process.env.DEPLOY_SESSION_VERSION ?? process.env.npm_package_version ?? 'local-dev').trim() ||
    'local-dev';

  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET ?? 'wms-dev-secret',
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (!payload.sub || !payload.username || !payload.role || !payload.deployVersion) {
      throw new UnauthorizedException('登录令牌无效，请重新登录');
    }
    if (payload.deployVersion !== this.deploySessionVersion) {
      throw new UnauthorizedException('系统已升级，请重新登录');
    }
    return {
      id: BigInt(payload.sub),
      username: payload.username,
      role: payload.role,
    };
  }
}
