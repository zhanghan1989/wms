import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { randomUUID } from 'crypto';
import { AuditAction, Prisma, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  private readonly protectedUsername = 'admin';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
  ) {}

  getDeploySessionVersion(): string {
    return String(
      process.env.DEPLOY_SESSION_VERSION ?? process.env.npm_package_version ?? 'local-dev',
    ).trim() || 'local-dev';
  }

  async login(username: string, password: string): Promise<{
    accessToken: string;
    deployVersion: string;
    user: Pick<User, 'id' | 'username' | 'role' | 'status' | 'department'> & {
    };
  }> {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        role: true,
        department: true,
        status: true,
        sessionVersion: true,
        passwordHash: true,
        passwordChangedAt: true,
      },
    });
    if (!user || user.status !== 1 || !user.passwordHash) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    const passwordMatch = await compare(password, user.passwordHash);
    if (!passwordMatch) {
      throw new UnauthorizedException('用户名或密码错误');
    }


    const accessToken = await this.issueAccessToken(user);

    return {
      accessToken,
      deployVersion: this.getDeploySessionVersion(),
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        department: user.username === this.protectedUsername ? '' : user.department,
        status: user.status,
      },
    };
  }

  async getMe(id: bigint): Promise<
    Pick<User, 'id' | 'username' | 'role' | 'status' | 'department'> & {
    }
  > {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        role: true,
        department: true,
        status: true,
        sessionVersion: true,
        passwordHash: true,
        passwordChangedAt: true,
      },
    });
    if (!user || user.status !== 1 || !user.passwordHash) {
      throw new UnauthorizedException('用户不存在');
    }
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      department: user.username === this.protectedUsername ? '' : user.department,
      status: user.status,
    };
  }

  async changePassword(
    id: bigint,
    currentPassword: string,
    newPassword: string,
    requestId?: string,
  ): Promise<{ success: true; accessToken: string; deployVersion: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        sessionVersion: true,
        passwordHash: true,
      },
    });
    if (!user || user.status !== 1 || !user.passwordHash) {
      throw new UnauthorizedException('用户不存在');
    }

    const currentMatched = await compare(currentPassword, user.passwordHash);
    if (!currentMatched) {
      throw new BadRequestException('当前密码错误');
    }
    const sameAsOld = await compare(newPassword, user.passwordHash);
    if (sameAsOld) {
      throw new BadRequestException('新密码不能与当前密码相同');
    }

    const passwordHash = await hash(newPassword, 10);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id, status: 1, sessionVersion: user.sessionVersion, passwordHash: user.passwordHash },
        data: { passwordHash, passwordChangedAt: new Date(), sessionVersion: { increment: 1 } },
      });
      if (updated.count !== 1) throw new UnauthorizedException('账号已变化，请重新登录');
      await this.auditService.create({
        db: tx,
        entityType: 'user',
        entityId: id,
        action: AuditAction.update,
        eventType: AuditEventType.USER_UPDATED,
        beforeData: {
          username: user.username,
          role: user.role,
          status: user.status,
          passwordChanged: false,
        },
        afterData: {
          username: user.username,
          role: user.role,
          status: user.status,
          passwordChanged: true,
        },
        operatorId: id,
        requestId,
        remark: 'self password updated',
      });
    });

    const accessToken = await this.issueAccessToken(
      { ...user, sessionVersion: user.sessionVersion + 1 },
    );
    return { success: true, accessToken, deployVersion: this.getDeploySessionVersion() };
  }

  async logout(userId: bigint, sessionId?: string): Promise<{ success: true }> {
    if (sessionId) await this.prisma.authSession.deleteMany({ where: { id: sessionId, userId } });
    return { success: true };
  }

  private async issueAccessToken(
    user: Pick<User, 'id' | 'username' | 'role' | 'sessionVersion'>,
  ): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`);
      const current = await tx.user.findUnique({ where: { id: user.id } });
      if (!current || current.status !== 1 || current.sessionVersion !== user.sessionVersion) {
        throw new UnauthorizedException('账号已变化，请重新登录');
      }
      const jti = randomUUID();
      const token = await this.jwtService.signAsync({
        sub: current.id.toString(), username: current.username, role: current.role,
        sessionVersion: current.sessionVersion, jti,
      });
      const decoded = this.jwtService.decode<{ exp: number }>(token);
      await tx.authSession.deleteMany({ where: { userId: current.id, expiresAt: { lte: new Date() } } });
      await tx.authSession.create({
        data: { id: jti, userId: current.id, expiresAt: new Date(decoded.exp * 1000) },
      });
      return token;
    });
  }

}
