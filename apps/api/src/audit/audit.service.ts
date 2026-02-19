import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueryAuditDto } from './dto/query-audit.dto';
import { AuditEventTypeValue } from '../constants/audit-event-type';

export interface AuditLogPayload {
  entityType: string;
  entityId: bigint;
  action: AuditAction;
  eventType: AuditEventTypeValue;
  beforeData?: Record<string, unknown> | null;
  afterData?: Record<string, unknown> | null;
  operatorId: bigint;
  requestId?: string;
  remark?: string;
  db?: Prisma.TransactionClient;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async create(payload: AuditLogPayload): Promise<void> {
    const db = payload.db ?? this.prisma;
    const normalizedBeforeData = payload.beforeData
      ? (this.normalizeForJson(payload.beforeData) as Record<string, unknown>)
      : undefined;
    const normalizedAfterData = payload.afterData
      ? (this.normalizeForJson(payload.afterData) as Record<string, unknown>)
      : undefined;
    const changedFields = this.buildChangedFields(
      normalizedBeforeData ?? null,
      normalizedAfterData ?? null,
    );
    const beforeData =
      payload.beforeData === null
        ? Prisma.JsonNull
        : normalizedBeforeData
          ? (normalizedBeforeData as Prisma.InputJsonValue)
          : undefined;
    const afterData =
      payload.afterData === null
        ? Prisma.JsonNull
        : normalizedAfterData
          ? (normalizedAfterData as Prisma.InputJsonValue)
          : undefined;
    const changedFieldsData = changedFields.length
      ? (this.normalizeForJson(changedFields) as Prisma.InputJsonValue)
      : undefined;

    await db.operationAuditLog.create({
      data: {
        entityType: payload.entityType,
        entityId: payload.entityId,
        action: payload.action,
        eventType: payload.eventType,
        beforeData,
        afterData,
        changedFields: changedFieldsData,
        operatorId: payload.operatorId,
        requestId: payload.requestId ?? null,
        remark: payload.remark ?? null,
      },
    });
  }

  async query(query: QueryAuditDto): Promise<{ total: number; items: unknown[] }> {
    const where: Prisma.OperationAuditLogWhereInput = {};
    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = BigInt(query.entityId);
    if (query.operatorId) where.operatorId = BigInt(query.operatorId);
    if (query.eventType) where.eventType = query.eventType as any;
    if (query.action) where.action = query.action;
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.createdAt.lte = new Date(query.dateTo);
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.operationAuditLog.count({ where }),
      this.prisma.operationAuditLog.findMany({
        where,
        include: {
          operator: {
            select: {
              id: true,
              username: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      total,
      items,
    };
  }

  async queryByEntity(entityType: 'box' | 'sku', entityId: bigint): Promise<unknown[]> {
    return this.prisma.operationAuditLog.findMany({
      where: {
        entityType,
        entityId,
      },
      include: {
        operator: {
          select: {
            id: true,
            username: true,
            role: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  buildChangedFields(
    beforeData?: Record<string, unknown> | null,
    afterData?: Record<string, unknown> | null,
  ): Array<{ field: string; before: unknown; after: unknown }> {
    if (!beforeData || !afterData) {
      return [];
    }
    const keys = new Set([...Object.keys(beforeData), ...Object.keys(afterData)]);
    const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
    keys.forEach((key) => {
      const before = beforeData[key];
      const after = afterData[key];
      if (this.toComparableJson(before) !== this.toComparableJson(after)) {
        changes.push({ field: key, before, after });
      }
    });
    return changes;
  }

  private normalizeForJson(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeForJson(item));
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, this.normalizeForJson(item)]);
      return Object.fromEntries(entries);
    }
    return value;
  }

  private toComparableJson(value: unknown): string {
    const normalized = this.normalizeForJson(value);
    return JSON.stringify(normalized ?? null);
  }
}
