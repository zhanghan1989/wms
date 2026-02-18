import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import { AuditAction, Role } from '@prisma/client';
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
    return this.prisma.user.findMany({
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        id: 'desc',
      },
    });
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
      throw new BadRequestException('username already exists');
    }
    const passwordHash = await hash(payload.password, 10);
    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username: payload.username,
          passwordHash,
          role: payload.role ?? Role.employee,
          status: payload.status ?? 1,
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
      status: created.status,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
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
    if (!user) throw new NotFoundException('user not found');

    const data: {
      passwordHash?: string;
      role?: Role;
      status?: number;
    } = {};
    if (payload.password) {
      data.passwordHash = await hash(payload.password, 10);
    }
    if (payload.role) data.role = payload.role;
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
          status: user.status,
        },
        afterData: {
          username: next.username,
          role: next.role,
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
      status: updated.status,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  async remove(idParam: string, operatorId: bigint, requestId?: string): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'userId');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('user not found');

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
          status: user.status,
        },
        afterData: null,
        operatorId,
        requestId,
      });
    });
    return { success: true };
  }
}
