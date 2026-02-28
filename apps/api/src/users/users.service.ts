import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import { AuditAction, Prisma, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../constants/audit-event-type';
import { parseId } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { UserOptionsService } from '../user-options/user-options.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly userOptionsService: UserOptionsService,
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
    const nextRole = payload.role ?? Role.employee;
    const nextDepartment = String(payload.department ?? 'china_warehouse').trim();
    await Promise.all([
      this.userOptionsService.assertRoleEnabled(nextRole),
      this.userOptionsService.assertDepartmentEnabled(nextDepartment),
    ]);

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
          role: nextRole,
          department: nextDepartment,
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
      department?: string;
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
    if (payload.department) data.department = String(payload.department).trim();
    if (typeof payload.status === 'number') data.status = payload.status;

    if (data.role) {
      await this.userOptionsService.assertRoleEnabled(data.role);
    }
    if (data.department) {
      await this.userOptionsService.assertDepartmentEnabled(data.department);
    }

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

    if (id === operatorId) {
      throw new BadRequestException('不能删除当前登录用户，请使用其他管理员账号操作');
    }

    const check = await this.getDeleteCheck(id);
    if (!check.canDelete) {
      throw new BadRequestException(`用户无法删除：${check.reasons.join('；')}`);
    }

    try {
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
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new BadRequestException('用户存在关联历史记录，无法删除。建议改为禁用。');
      }
      throw error;
    }
    return { success: true };
  }

  private async getDeleteCheck(id: bigint): Promise<{ canDelete: boolean; reasons: string[] }> {
    const [
      inboundCount,
      outboundCount,
      stocktakeCount,
      adjustCount,
      batchInboundCount,
      productEditCount,
      fbaCreatedCount,
      fbaConfirmedCount,
      fbaOutboundCount,
      fbaDeletedCount,
      stockMovementCount,
      auditLogCount,
    ] = await Promise.all([
      this.prisma.inboundOrder.count({ where: { createdBy: id } }),
      this.prisma.outboundOrder.count({ where: { createdBy: id } }),
      this.prisma.stocktakeTask.count({ where: { createdBy: id } }),
      this.prisma.inventoryAdjustOrder.count({ where: { createdBy: id } }),
      this.prisma.batchInboundOrder.count({ where: { createdBy: id } }),
      this.prisma.productEditRequest.count({ where: { createdBy: id } }),
      this.prisma.fbaReplenishment.count({ where: { createdBy: id } }),
      this.prisma.fbaReplenishment.count({ where: { confirmedBy: id } }),
      this.prisma.fbaReplenishment.count({ where: { outboundBy: id } }),
      this.prisma.fbaReplenishment.count({ where: { deletedBy: id } }),
      this.prisma.stockMovement.count({ where: { operatorId: id } }),
      this.prisma.operationAuditLog.count({ where: { operatorId: id } }),
    ]);

    const reasons: string[] = [];
    const orderCount =
      inboundCount +
      outboundCount +
      stocktakeCount +
      adjustCount +
      batchInboundCount +
      productEditCount +
      fbaCreatedCount +
      fbaConfirmedCount +
      fbaOutboundCount +
      fbaDeletedCount;

    if (orderCount > 0) {
      reasons.push(`存在 ${orderCount} 条业务单据记录`);
    }
    if (stockMovementCount > 0) {
      reasons.push(`存在 ${stockMovementCount} 条库存流水记录`);
    }
    if (auditLogCount > 0) {
      reasons.push(`存在 ${auditLogCount} 条操作日志记录`);
    }

    return {
      canDelete: reasons.length === 0,
      reasons,
    };
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
