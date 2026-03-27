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
        { plannedDate: 'asc' },
        { shelf: { shelfCode: 'asc' } },
      ],
    });
    return rows.map((item) => this.toTaskDto(item));
  }

  async generate(operatorId: bigint, requestId?: string): Promise<unknown[]> {
    const createdAt = new Date();
    const baseDate = this.getTodayStart();
    const shelves = await this.prisma.shelf.findMany({
      where: {
        status: 1,
        NOT: [
          { shelfCode: '00' },
          { shelfCode: { startsWith: 'S' } },
        ],
      },
      orderBy: { shelfCode: 'asc' },
      take: 10,
    });

    if (!shelves.length) {
      throw new BadRequestException('未找到可生成盘点任务的货架');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.stocktakePlannerTask.deleteMany();

      const rows: StocktakePlannerTask[] = [];
      for (const [index, shelf] of shelves.entries()) {
        const plannedDate = new Date(baseDate);
        plannedDate.setDate(baseDate.getDate() + index);
        const task = await tx.stocktakePlannerTask.create({
          data: {
            taskNo: this.buildTaskNo(shelf.shelfCode, plannedDate),
            plannedDate,
            shelfId: shelf.id,
            status: StocktakePlannerTaskStatus.pending,
            createdBy: operatorId,
            createdAt,
          },
        });
        rows.push(task);
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
      }
      return rows;
    });

    const createdIds = created.map((item) => item.id);
    const latest = await this.prisma.stocktakePlannerTask.findMany({
      where: { id: { in: createdIds } },
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
        { plannedDate: 'asc' },
        { shelf: { shelfCode: 'asc' } },
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

  private toTaskDto(
    item: StocktakePlannerTask & {
      shelf?: { id: bigint; shelfCode: string; name: string | null } | null;
      confirmer?: { id: bigint; username: string } | null;
    },
  ): Record<string, unknown> {
    return {
      id: item.id.toString(),
      taskNo: item.taskNo,
      plannedDate: item.plannedDate,
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
}
