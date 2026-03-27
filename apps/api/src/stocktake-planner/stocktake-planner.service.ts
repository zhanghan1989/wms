import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, StocktakePlannerTask, StocktakePlannerTaskStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { APP_TIMEZONE, getZonedDateParts, parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StocktakePlannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(): Promise<unknown[]> {
    const rows = await this.prisma.stocktakePlannerTask.findMany({
      include: {
        shelf: {
          select: {
            id: true,
            shelfCode: true,
            name: true,
          },
        },
        confirmer: {
          select: {
            id: true,
            username: true,
          },
        },
      },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
    });
    return rows.map((item) => this.toTaskDto(item));
  }

  async generate(operatorId: bigint, requestId?: string): Promise<unknown[]> {
    const createdAt = new Date();
    const shelves = await this.prisma.shelf.findMany({
      where: {
        status: 1,
        NOT: [
          { shelfCode: '00' },
          { shelfCode: { startsWith: 'S' } },
        ],
      },
      orderBy: { shelfCode: 'asc' },
    });

    if (!shelves.length) {
      throw new BadRequestException('未找到可生成盘点任务的货架');
    }

    const lastTask = await this.prisma.stocktakePlannerTask.findFirst({
      orderBy: [
        { plannedDate: 'desc' },
        { id: 'desc' },
      ],
      include: {
        shelf: {
          select: {
            shelfCode: true,
          },
        },
      },
    });

    const lastShelfCode = lastTask?.shelf?.shelfCode ?? null;
    const lastShelfIndex = lastShelfCode
      ? shelves.findIndex((item) => item.shelfCode === lastShelfCode)
      : -1;
    const plannedDate = this.getTodayStart();
    const shelf = shelves[(lastShelfIndex + 1 + shelves.length) % shelves.length];

    await this.prisma.$transaction(async (tx) => {
      const baseTaskNo = this.buildTaskNo(shelf.shelfCode, plannedDate);
      let taskNo = baseTaskNo;
      let suffix = 2;
      while (await tx.stocktakePlannerTask.findUnique({ where: { taskNo } })) {
        taskNo = `${baseTaskNo}-${suffix}`;
        suffix += 1;
      }
      const task = await tx.stocktakePlannerTask.create({
        data: {
          taskNo,
          plannedDate,
          shelfId: shelf.id,
          status: StocktakePlannerTaskStatus.pending,
          createdBy: operatorId,
          createdAt,
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'stocktake_task',
        entityId: task.id,
        action: AuditAction.create,
        eventType: AuditEventType.STOCKTAKE_TASK_CREATED,
        beforeData: null,
        afterData: task as unknown as Record<string, unknown>,
        operatorId,
        requestId,
      });
    });

    const latest = await this.prisma.stocktakePlannerTask.findMany({
      include: {
        shelf: {
          select: {
            id: true,
            shelfCode: true,
            name: true,
          },
        },
        confirmer: {
          select: {
            id: true,
            username: true,
          },
        },
      },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
    });
    return latest.map((item) => this.toTaskDto(item));
  }

  async confirm(idParam: string, operatorId: bigint, requestId?: string): Promise<unknown> {
    const id = parseId(idParam, 'stocktakePlannerTaskId');
    const current = await this.prisma.stocktakePlannerTask.findUnique({
      where: { id },
      include: {
        shelf: {
          select: {
            id: true,
            shelfCode: true,
            name: true,
          },
        },
        confirmer: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    });
    if (!current) {
      throw new NotFoundException('盘点任务不存在');
    }
    if (current.status === StocktakePlannerTaskStatus.confirmed) {
      return this.toTaskDto(current);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.stocktakePlannerTask.update({
        where: { id },
        data: {
          status: StocktakePlannerTaskStatus.confirmed,
          confirmedAt: new Date(),
          confirmedBy: operatorId,
        },
        include: {
          shelf: {
            select: {
              id: true,
              shelfCode: true,
              name: true,
            },
          },
          confirmer: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'stocktake_task',
        entityId: next.id,
        action: AuditAction.update,
        eventType: AuditEventType.STOCKTAKE_TASK_FINISHED,
        beforeData: current as unknown as Record<string, unknown>,
        afterData: next as unknown as Record<string, unknown>,
        operatorId,
        requestId,
      });
      return next;
    });

    return this.toTaskDto(updated);
  }

  async cancel(idParam: string, operatorId: bigint, requestId?: string): Promise<unknown> {
    const id = parseId(idParam, 'stocktakePlannerTaskId');
    const current = await this.prisma.stocktakePlannerTask.findUnique({
      where: { id },
      include: {
        shelf: {
          select: {
            id: true,
            shelfCode: true,
            name: true,
          },
        },
        confirmer: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    });
    if (!current) {
      throw new NotFoundException('盘点任务不存在');
    }
    if (current.status === StocktakePlannerTaskStatus.canceled) {
      return this.toTaskDto(current);
    }
    if (current.status === StocktakePlannerTaskStatus.confirmed) {
      throw new BadRequestException('已确认的盘点任务不可删除');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.stocktakePlannerTask.update({
        where: { id },
        data: {
          status: StocktakePlannerTaskStatus.canceled,
          confirmedAt: null,
          confirmedBy: null,
        },
        include: {
          shelf: {
            select: {
              id: true,
              shelfCode: true,
              name: true,
            },
          },
          confirmer: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'stocktake_task',
        entityId: next.id,
        action: AuditAction.update,
        eventType: AuditEventType.STOCKTAKE_TASK_VOIDED,
        beforeData: current as unknown as Record<string, unknown>,
        afterData: next as unknown as Record<string, unknown>,
        operatorId,
        requestId,
      });
      return next;
    });

    return this.toTaskDto(updated);
  }

  private toTaskDto(
    item: StocktakePlannerTask & {
      shelf?: { id: bigint; shelfCode: string; name: string | null } | null;
      confirmer?: { id: bigint; username: string } | null;
    },
  ): Record<string, unknown> {
    const taskNoDate = this.extractTaskNoDate(item.taskNo);
    return {
      id: item.id.toString(),
      taskNo: item.taskNo,
      plannedDate: item.plannedDate,
      plannedDateText: taskNoDate?.dateText ?? this.formatDateOnly(item.plannedDate),
      plannedDateWithWeekday: taskNoDate?.dateWithWeekday ?? this.formatDateOnlyWithWeekday(item.plannedDate),
      shelfId: item.shelfId.toString(),
      shelfCode: item.shelf?.shelfCode ?? '',
      shelfName: item.shelf?.name ?? null,
      status: item.status,
      createdBy: item.createdBy.toString(),
      confirmedBy: item.confirmedBy?.toString() ?? null,
      confirmedByName: item.confirmer?.username ?? null,
      confirmedAt: item.confirmedAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  private getTodayStart(): Date {
    const parts = getZonedDateParts(new Date(), APP_TIMEZONE);
    return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`);
  }

  private buildTaskNo(shelfCode: string, plannedDate: Date): string {
    const parts = getZonedDateParts(plannedDate, APP_TIMEZONE);
    return `STK-${parts.year}${parts.month}${parts.day}-${shelfCode}`;
  }

  private formatDateOnly(date: Date | null | undefined): string | null {
    if (!date) return null;
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}/${parts.month}/${parts.day}`;
  }

  private formatDateOnlyWithWeekday(date: Date | null | undefined): string | null {
    if (!date) return null;
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: APP_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
    }).formatToParts(date);
    const mapped = Object.fromEntries(
      parts.filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]),
    );
    return `${mapped.year || '0000'}/${mapped.month || '00'}/${mapped.day || '00'}(${mapped.weekday || '-'})`;
  }

  private extractTaskNoDate(
    taskNo: string | null | undefined,
  ): { dateText: string; dateWithWeekday: string } | null {
    const matched = String(taskNo || '').match(/^STK-(\d{4})(\d{2})(\d{2})-/);
    if (!matched) return null;
    const [, year, month, day] = matched;
    const date = new Date(`${year}-${month}-${day}T00:00:00+08:00`);
    if (Number.isNaN(date.getTime())) return null;
    return {
      dateText: `${year}/${month}/${day}`,
      dateWithWeekday: this.formatDateOnlyWithWeekday(date) || `${year}/${month}/${day}`,
    };
  }
}
