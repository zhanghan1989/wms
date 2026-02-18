import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { AuditAction, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
  ) {}

  async login(username: string, password: string): Promise<{
    accessToken: string;
    user: Pick<User, 'id' | 'username' | 'role' | 'status'>;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        passwordHash: true,
      },
    });
    if (!user || user.status === 0) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const passwordMatch = await compare(password, user.passwordHash);
    if (!passwordMatch) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const accessToken = await this.jwtService.signAsync({
      sub: user.id.toString(),
      username: user.username,
      role: user.role,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
      },
    };
  }

  async getMe(id: bigint): Promise<Pick<User, 'id' | 'username' | 'role' | 'status'>> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return user;
  }

  async changePassword(
    id: bigint,
    currentPassword: string,
    newPassword: string,
    requestId?: string,
  ): Promise<{ success: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        passwordHash: true,
      },
    });
    if (!user || user.status === 0) {
      throw new UnauthorizedException('User not found');
    }

    const currentMatched = await compare(currentPassword, user.passwordHash);
    if (!currentMatched) {
      throw new BadRequestException('Current password is incorrect');
    }
    const sameAsOld = await compare(newPassword, user.passwordHash);
    if (sameAsOld) {
      throw new BadRequestException('New password must be different');
    }

    const passwordHash = await hash(newPassword, 10);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { passwordHash },
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

    return { success: true };
  }
}
