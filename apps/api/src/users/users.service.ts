import { companyContext } from '../company-scope/company-context';
import {
  BadRequestException,
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import { AuditAction, Prisma, Role, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../constants/audit-event-type';
import { parseId } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { isValidPassword, PASSWORD_MESSAGE } from '../auth/password-policy';
import { UserOptionsService } from '../user-options/user-options.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  private readonly protectedUsername = 'admin';

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly userOptionsService: UserOptionsService,
  ) {}

  private async membership(
    payload: { role?: Role; department?: string; companyId?: string | null },
    current: Pick<User, 'role' | 'department' | 'companyId'> | undefined,
    operatorRole: Role,
  ): Promise<{ companyId: bigint | null; department: string }> {
    const scope = companyContext.getStore();
    const systemAdmin = operatorRole === Role.system_admin;
    const role = payload.role ?? current?.role ?? Role.employee;
    const department = payload.companyId === null ? 'overseas_warehouse'
      : payload.companyId !== undefined && payload.department === undefined
        ? (current?.department === 'china_warehouse' ? 'china_warehouse' : 'factory')
        : payload.department ?? current?.department ?? 'factory';
    if (role === Role.system_admin) {
      if (!systemAdmin) throw new ForbiddenException('只有系统管理员可以设置系统管理员角色');
      return { companyId: null, department: '' };
    }
    if (department === 'overseas_warehouse') {
      if (!systemAdmin) throw new ForbiddenException('只有系统管理员可以设置日本海外仓归属');
      return { companyId: null, department: 'overseas_warehouse' };
    }
    const companyId = payload.companyId ? BigInt(payload.companyId) : current?.companyId ?? scope?.companyId;
    if (!companyId) throw new BadRequestException('请选择所属公司');
    if (!systemAdmin && companyId !== (current?.companyId ?? scope?.companyId)) throw new ForbiddenException('只有系统管理员可以调整公司归属');
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company || company.status !== 1) throw new BadRequestException('公司不存在或已禁用');
    return { companyId, department: department === 'factory' ? 'factory' : 'china_warehouse' };
  }

  private async assertCanManage(
    tx: Prisma.TransactionClient,
    operatorId: bigint,
    targetId?: bigint,
    changes?: { role?: Role; department?: string; status?: number },
  ): Promise<Role> {
    const ids = [...new Set([operatorId, ...(targetId ? [targetId] : [])])].sort((a, b) => a < b ? -1 : 1);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
    const operator = await tx.user.findUnique({ where: { id: operatorId } });
    if (!operator || operator.status !== 1 || ![Role.admin, Role.system_admin].includes(operator.role as 'admin' | 'system_admin')) {
      throw new ForbiddenException('无权管理用户');
    }
    const target = targetId ? await tx.user.findUnique({ where: { id: targetId } }) : null;
    if (targetId && !target) throw new NotFoundException('用户不存在');
    if (target?.username === this.protectedUsername) throw new ForbiddenException('保留管理员账号不能通过用户管理修改');
    if (operator.role === Role.system_admin) return operator.role;
    if (changes?.role && changes.role !== Role.employee && !(targetId === operatorId && changes.role === operator.role)) {
      throw new ForbiddenException('只有系统管理员可以授予管理员权限');
    }
    if (target && target.role !== Role.employee) {
      if (target.id !== operatorId || target.role === Role.system_admin) {
        throw new ForbiddenException('只有系统管理员可以管理其他管理员');
      }
      if ((changes?.role !== undefined && changes.role !== target.role)
        || (changes?.department !== undefined && changes.department !== target.department)
        || (changes?.status !== undefined && changes.status !== target.status)) {
        throw new ForbiddenException('不能修改自己的角色、部门或启用状态');
      }
    }
    return operator.role;
  }

  async findAll(): Promise<unknown[]> {
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        username: true,
        role: true,
        department: true,
        companyId: true,
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
      companyId: user.companyId,
      department: user.username === this.protectedUsername ? '' : user.department,
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
    const nextDepartment = String(payload.department ?? (payload.companyId === null ? 'overseas_warehouse' : 'factory')).trim();
    const scope = companyContext.getStore();
    if (scope && !scope.systemAdmin && nextDepartment === 'overseas_warehouse') {
      throw new ForbiddenException('只有系统管理员可以授予跨公司权限');
    }
    await this.userOptionsService.assertRoleEnabled(nextRole);

    const exists = await this.prisma.user.findUnique({
      where: { username: payload.username },
    });
    if (exists) {
      throw new BadRequestException('用户名已存在');
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const operatorRole = await this.assertCanManage(tx, operatorId, undefined, { role: nextRole });
      const membership = await this.membership({ ...payload, role: nextRole }, undefined, operatorRole);
      const user = await tx.user.create({
        data: {
          username: payload.username,
          companyId: membership.companyId,
          passwordHash: null,
          role: nextRole,
          department: membership.department,
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
          companyId: user.companyId,
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
      companyId: created.companyId,
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

    if (user.username === this.protectedUsername) {
      throw new BadRequestException('\u7cfb\u7edf\u7ba1\u7406\u5458\u8d26\u53f7\u4e0d\u5141\u8bb8\u7f16\u8f91');
    }

    const data: {
      companyId?: bigint | null;
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
      const operatorRole = await this.assertCanManage(tx, operatorId, id, data);
      if (payload.companyId !== undefined || payload.department !== undefined || payload.role !== undefined) {
        const membership = await this.membership(payload, user, operatorRole);
        if (companyContext.getStore() && !companyContext.getStore()!.systemAdmin && membership.companyId !== user.companyId) {
          throw new ForbiddenException('只有系统管理员可以调整公司归属');
        }
        data.companyId = membership.companyId;
        data.department = membership.department;
      }
      const next = await tx.user.update({
        where: { id, sessionVersion: user.sessionVersion },
        data: { ...data, sessionVersion: { increment: 1 } },
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
          companyId: user.companyId,
          department: user.department,
          status: user.status,
        },
        afterData: {
          username: next.username,
          role: next.role,
          companyId: next.companyId,
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
      companyId: updated.companyId,
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
        await this.assertCanManage(tx, operatorId, id);
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
            companyId: user.companyId,
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

    if (user.username === this.protectedUsername) {
      throw new BadRequestException('\u7cfb\u7edf\u7ba1\u7406\u5458\u8d26\u53f7\u4e0d\u5141\u8bb8\u91cd\u7f6e\u5bc6\u7801');
    }

    const nextPassword = String(password || '').trim();
    if (!isValidPassword(nextPassword)) {
      throw new BadRequestException(PASSWORD_MESSAGE);
    }

    const passwordHash = await hash(nextPassword, 10);

    await this.prisma.$transaction(async (tx) => {
      await this.assertCanManage(tx, operatorId, id);
      await tx.user.update({
        where: { id },
        data: {
          passwordHash,
          sessionVersion: { increment: 1 },
          passwordChangedAt: new Date(),
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
          companyId: user.companyId,
          department: user.department,
          status: user.status,
          passwordReset: false,
        },
        afterData: {
          username: user.username,
          role: user.role,
          companyId: user.companyId,
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
