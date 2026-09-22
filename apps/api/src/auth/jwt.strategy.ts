import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user.type';
import { getJwtSecret } from './jwt-config';

interface JwtPayload {
  sub?: string;
  jti?: string;
  sessionVersion?: number;
  mfaPending?: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (!payload.sub || !/^\d+$/.test(payload.sub) || !payload.jti
      || !Number.isInteger(payload.sessionVersion)) {
      throw new UnauthorizedException('登录已失效，请重新登录');
    }
    const session = await this.prisma.authSession.findUnique({
      where: { id: payload.jti },
      include: { user: true },
    });
    const user = session?.user;
    if (!session || session.expiresAt <= new Date() || !user || user.status !== 1
      || !user.passwordHash || user.id.toString() !== payload.sub
      || user.sessionVersion !== payload.sessionVersion) {
      throw new UnauthorizedException('登录已失效，请重新登录');
    }
    const requireMfa = String(process.env.AUTH_REQUIRE_MFA ?? 'false').toLowerCase() === 'true';
    const requireRotation = String(process.env.AUTH_REQUIRE_PASSWORD_ROTATION ?? 'false').toLowerCase() === 'true';
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      sessionId: session.id,
      mfaPending: payload.mfaPending === true || (requireMfa && !user.mfaEnabledAt),
      passwordChangeRequired: requireRotation && (!user.passwordChangedAt
        || user.passwordChangedAt.getTime() + 365 * 86400000 <= Date.now()),
    };
  }
}
