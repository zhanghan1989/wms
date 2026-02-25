import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import { AuditAction, Department, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../constants/audit-event-type';
import { parseId } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async findAll(): Promise<unknown[]> {
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        username: true,
        role: true,
        department: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        passwordHash: true,
      },
      orderBy: {
        id: 'desc',
      },
    });

    return users.map((user) => ({
      id: user.id,
      username: user.username,
      role: user.role,
      department: user.department,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      passwordInitialized: Boolean(user.passwordHash),
    }));
  }

  async create(
    payload: CreateUserDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const exists = await this.prisma.user.findUnique({
      where: { username: payload.username },
    });
    if (exists) {
      throw new BadRequestException('用户名已存在');
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username: payload.username,
          passwordHash: null,
          role: payload.role ?? Role.employee,
          department: payload.department ?? Department.china_warehouse,
          status: 0,
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'user',
        entityId: user.id,
        action: AuditAction.create,
        eventType: AuditEventType.USER_CREATED,
        beforeData: null,
        afterData: {
          username: user.username,
          role: user.role,
          department: user.department,
          status: user.status,
        },
        operatorId,
        requestId,
      });
      return user;
    });

    return {
      id: created.id,
      username: created.username,
      role: created.role,
      department: created.department,
      status: created.status,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      passwordInitialized: false,
    };
  }

  async update(
    idParam: string,
    payload: UpdateUserDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const id = parseId(idParam, 'userId');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');

    const data: {
      username?: string;
      role?: Role;
      department?: Department;
      status?: number;
    } = {};

    const username = payload.username?.trim();
    if (username && username !== user.username) {
      const exists = await this.prisma.user.findUnique({
        where: { username },
      });
      if (exists && exists.id !== user.id) {
        throw new BadRequestException('用户名已存在');
      }
      data.username = username;
    }

    if (payload.role) data.role = payload.role;
    if (payload.department) data.department = payload.department;
    if (typeof payload.status === 'number') data.status = payload.status;

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.user.update({
        where: { id },
        data,
      });
      const eventType = next.status === 0 ? AuditEventType.USER_DISABLED : AuditEventType.USER_UPDATED;
      await this.auditService.create({
        db: tx,
        entityType: 'user',
        entityId: next.id,
        action: AuditAction.update,
        eventType,
        beforeData: {
          username: user.username,
          role: user.role,
          department: user.department,
          status: user.status,
        },
        afterData: {
          username: next.username,
          role: next.role,
          department: next.department,
          status: next.status,
        },
        operatorId,
        requestId,
      });
      return next;
    });

    return {
      id: updated.id,
      username: updated.username,
      role: updated.role,
      department: updated.department,
      status: updated.status,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      passwordInitialized: Boolean(updated.passwordHash),
    };
  }

  async remove(idParam: string, operatorId: bigint, requestId?: string): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'userId');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');

    await this.prisma.$transaction(async (tx) => {
      await tx.user.delete({
        where: { id },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'user',
        entityId: id,
        action: AuditAction.delete,
        eventType: AuditEventType.USER_DELETED,
        beforeData: {
          username: user.username,
          role: user.role,
          department: user.department,
          status: user.status,
        },
        afterData: null,
        operatorId,
        requestId,
      });
    });
    return { success: true };
  }

  async resetPassword(
    idParam: string,
    password: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'userId');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');

    const nextPassword = String(password || '').trim();
    if (!nextPassword || nextPassword.length < 6 || nextPassword.length > 64) {
      throw new BadRequestException('密码长度需为6到64位');
    }

    const passwordHash = await hash(nextPassword, 10);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          passwordHash,
          status: 1,
        },
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
          department: user.department,
          status: user.status,
          passwordReset: false,
        },
        afterData: {
          username: user.username,
          role: user.role,
          department: user.department,
          status: 1,
          passwordReset: true,
        },
        operatorId,
        requestId,
      });
    });

    return { success: true };
  }
}
