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
      include: { user: { include: { company: true } } },
    });
    const user = session?.user;
    if (!session || session.expiresAt <= new Date() || !user || user.status !== 1
      || !user.passwordHash || (user.role !== 'system_admin' && user.department !== 'overseas_warehouse' && user.company?.status === 0) || user.id.toString() !== payload.sub
      || user.sessionVersion !== payload.sessionVersion) {
      throw new UnauthorizedException('登录已失效，请重新登录');
    }
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      companyId: user.companyId,
      department: user.department,
      sessionId: session.id,
    };
  }
}
