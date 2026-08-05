import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { AuditAction, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { AuthMfaService } from './auth-mfa.service';

@Injectable()
export class AuthService {
  private readonly protectedUsername = 'admin';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
    private readonly mfaService: AuthMfaService,
  ) {}

  getDeploySessionVersion(): string {
    return String(
      process.env.DEPLOY_SESSION_VERSION ?? process.env.npm_package_version ?? 'local-dev',
    ).trim() || 'local-dev';
  }

  async login(username: string, password: string, mfaCode?: string): Promise<{
    accessToken: string;
    deployVersion: string;
    mfaEnrollmentRequired: boolean;
    passwordChangeRequired: boolean;
    user: Pick<User, 'id' | 'username' | 'role' | 'status' | 'department'> & {
      mfaEnabled: boolean;
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
        passwordHash: true,
        mfaSecretEncrypted: true,
        mfaSecretIv: true,
        mfaSecretAuthTag: true,
        mfaEnabledAt: true,
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

    const mfaEnabled = Boolean(
      user.mfaEnabledAt
      && user.mfaSecretEncrypted
      && user.mfaSecretIv
      && user.mfaSecretAuthTag,
    );
    if (mfaEnabled) {
      const secret = this.mfaService.decrypt({
        encryptedValue: user.mfaSecretEncrypted!,
        iv: user.mfaSecretIv!,
        authTag: user.mfaSecretAuthTag!,
      });
      if (!this.mfaService.verify(secret, String(mfaCode ?? ''))) {
        throw new UnauthorizedException('用户名、密码或MFA验证码错误');
      }
    }
    const mfaEnrollmentRequired = this.isMfaRequired() && !mfaEnabled;
    const passwordChangeRequired = this.isPasswordChangeRequired(user.passwordChangedAt);

    const accessToken = await this.jwtService.signAsync({
      sub: user.id.toString(),
      username: user.username,
      role: user.role,
      mfaPending: mfaEnrollmentRequired,
      passwordChangeRequired,
    });

    return {
      accessToken,
      deployVersion: this.getDeploySessionVersion(),
      mfaEnrollmentRequired,
      passwordChangeRequired,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        department: user.username === this.protectedUsername ? '' : user.department,
        status: user.status,
        mfaEnabled,
      },
    };
  }

  async getMe(id: bigint): Promise<
    Pick<User, 'id' | 'username' | 'role' | 'status' | 'department'> & {
      mfaEnabled: boolean;
      mfaEnrollmentRequired: boolean;
      passwordChangeRequired: boolean;
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
        passwordHash: true,
        mfaEnabledAt: true,
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
      mfaEnabled: Boolean(user.mfaEnabledAt),
      mfaEnrollmentRequired: this.isMfaRequired() && !user.mfaEnabledAt,
      passwordChangeRequired: this.isPasswordChangeRequired(user.passwordChangedAt),
    };
  }

  async setupMfa(id: bigint): Promise<{ secret: string; otpAuthUri: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, status: true, mfaEnabledAt: true },
    });
    if (!user || user.status !== 1) throw new UnauthorizedException('用户不存在');
    if (user.mfaEnabledAt) throw new BadRequestException('MFA已经启用');

    const secret = this.mfaService.generateSecret();
    const encrypted = this.mfaService.encrypt(secret);
    await this.prisma.user.update({
      where: { id },
      data: {
        mfaSecretEncrypted: encrypted.encryptedValue,
        mfaSecretIv: encrypted.iv,
        mfaSecretAuthTag: encrypted.authTag,
        mfaEnabledAt: null,
      },
    });
    return {
      secret,
      otpAuthUri: this.mfaService.buildOtpAuthUri(user.username, secret),
    };
  }

  async enableMfa(id: bigint, code: string): Promise<{
    success: true;
    accessToken: string;
    deployVersion: string;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        mfaSecretEncrypted: true,
        mfaSecretIv: true,
        mfaSecretAuthTag: true,
        mfaEnabledAt: true,
        passwordChangedAt: true,
      },
    });
    if (!user || user.status !== 1) throw new UnauthorizedException('用户不存在');
    if (user.mfaEnabledAt) throw new BadRequestException('MFA已经启用');
    if (!user.mfaSecretEncrypted || !user.mfaSecretIv || !user.mfaSecretAuthTag) {
      throw new BadRequestException('请先生成MFA密钥');
    }
    const secret = this.mfaService.decrypt({
      encryptedValue: user.mfaSecretEncrypted,
      iv: user.mfaSecretIv,
      authTag: user.mfaSecretAuthTag,
    });
    if (!this.mfaService.verify(secret, code)) {
      throw new BadRequestException('MFA验证码无效，请确认手机时间后重试');
    }
    await this.prisma.user.update({ where: { id }, data: { mfaEnabledAt: new Date() } });
    const accessToken = await this.jwtService.signAsync({
      sub: user.id.toString(),
      username: user.username,
      role: user.role,
      mfaPending: false,
      passwordChangeRequired: this.isPasswordChangeRequired(user.passwordChangedAt),
    });
    return { success: true, accessToken, deployVersion: this.getDeploySessionVersion() };
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
        passwordHash: true,
        mfaEnabledAt: true,
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
      await tx.user.update({
        where: { id },
        data: { passwordHash, passwordChangedAt: new Date() },
      });
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

    const accessToken = await this.jwtService.signAsync({
      sub: user.id.toString(),
      username: user.username,
      role: user.role,
      mfaPending: this.isMfaRequired() && !user.mfaEnabledAt,
      passwordChangeRequired: false,
    });
    return { success: true, accessToken, deployVersion: this.getDeploySessionVersion() };
  }

  private isMfaRequired(): boolean {
    return String(process.env.AUTH_REQUIRE_MFA ?? 'false').toLowerCase() === 'true';
  }

  private isPasswordChangeRequired(passwordChangedAt: Date | null): boolean {
    if (String(process.env.AUTH_REQUIRE_PASSWORD_ROTATION ?? 'false').toLowerCase() !== 'true') {
      return false;
    }
    const expiresAt = passwordChangedAt
      ? passwordChangedAt.getTime() + 365 * 24 * 60 * 60 * 1000
      : 0;
    return expiresAt <= Date.now();
  }
}
