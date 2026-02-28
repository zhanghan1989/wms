import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDepartmentOptionDto } from './dto/create-user-option.dto';
import { UpdateUserOptionDto } from './dto/update-user-option.dto';

const DEPARTMENT_DEFAULTS: Array<{ code: string; name: string; sort: number }> = [
  { code: 'factory', name: '\u5de5\u5382', sort: 10 },
  { code: 'overseas_warehouse', name: '\u6d77\u5916\u4ed3', sort: 20 },
  { code: 'china_warehouse', name: '\u4e2d\u56fd\u4ed3', sort: 30 },
];

const ROLE_DEFAULTS: Array<{ code: Role; name: string; sort: number }> = [
  { code: Role.employee, name: '员工', sort: 10 },
  { code: Role.admin, name: '管理者', sort: 20 },
  { code: Role.system_admin, name: '系统管理员', sort: 30 },
];

@Injectable()
export class UserOptionsService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureSeeded(): Promise<void> {
    await this.ensureDefaults();
  }

  async assertDepartmentEnabled(code: string): Promise<void> {
    await this.ensureDefaults();
    const normalizedCode = this.normalizeDepartmentCode(code);
    const option = await this.prisma.departmentOption.findUnique({ where: { code: normalizedCode } });
    if (!option || option.status !== 1) {
      throw new BadRequestException('部门已禁用或不存在');
    }
  }

  async assertRoleEnabled(code: Role): Promise<void> {
    await this.ensureDefaults();
    const option = await this.prisma.roleOption.findUnique({ where: { code } });
    if (!option || option.status !== 1) {
      throw new BadRequestException('角色已禁用或不存在');
    }
  }

  async list(): Promise<{
    departments: Array<{ id: bigint; code: string; name: string; status: number; sort: number }>;
    roles: Array<{ id: bigint; code: Role; name: string; status: number; sort: number }>;
  }> {
    await this.ensureSeeded();
    const [departments, roles] = await Promise.all([
      this.prisma.departmentOption.findMany({
        orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.roleOption.findMany({
        orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      }),
    ]);

    return { departments, roles };
  }

  async createDepartment(payload: CreateDepartmentOptionDto): Promise<unknown> {
    await this.ensureSeeded();
    const nextName = this.normalizeOptionalName(payload.name);
    if (!nextName) {
      throw new BadRequestException('\u90e8\u95e8\u540d\u79f0\u4e0d\u80fd\u4e3a\u7a7a');
    }
    const requestedCode = payload.code ? this.normalizeDepartmentCode(payload.code) : undefined;
    const [optionByCode, optionByName] = await Promise.all([
      requestedCode ? this.prisma.departmentOption.findUnique({ where: { code: requestedCode } }) : Promise.resolve(null),
      this.prisma.departmentOption.findFirst({
        where: {
          name: nextName,
        },
      }),
    ]);

    if (optionByName && optionByName.status === 1) {
      throw new BadRequestException('\u90e8\u95e8\u5df2\u5b58\u5728');
    }

    if (optionByName) {
      return this.prisma.departmentOption.update({
        where: { code: optionByName.code },
        data: {
          status: 1,
          name: nextName,
          sort: payload.sort ?? optionByName.sort,
        },
      });
    }

    if (optionByCode) {
      if (optionByCode.status === 1) {
        throw new BadRequestException('\u90e8\u95e8\u5df2\u5b58\u5728');
      }
      return this.prisma.departmentOption.update({
        where: { code: optionByCode.code },
        data: {
          status: 1,
          name: nextName,
          sort: payload.sort ?? optionByCode.sort,
        },
      });
    }

    const defaultOption = requestedCode
      ? DEPARTMENT_DEFAULTS.find((item) => item.code === requestedCode)
      : undefined;
    const code = requestedCode ?? (await this.generateDepartmentCode());
    return this.prisma.departmentOption.create({
      data: {
        code,
        name: nextName,
        status: 1,
        sort: payload.sort ?? defaultOption?.sort ?? 0,
      },
    });
  }

  async updateDepartment(codeParam: string, payload: UpdateUserOptionDto): Promise<unknown> {
    await this.ensureSeeded();
    const code = this.normalizeDepartmentCode(codeParam);
    const option = await this.prisma.departmentOption.findUnique({ where: { code } });
    if (!option) {
      throw new NotFoundException('部门不存在');
    }

    const data = this.buildUpdateData(payload);
    return this.prisma.departmentOption.update({
      where: { code },
      data,
    });
  }

  private buildUpdateData(payload: UpdateUserOptionDto): { name?: string; status?: number; sort?: number } {
    const data: { name?: string; status?: number; sort?: number } = {};

    if (payload.name !== undefined) {
      const name = String(payload.name || '').trim();
      if (!name) {
        throw new BadRequestException('名称不能为空');
      }
      data.name = name;
    }

    if (payload.status !== undefined) {
      data.status = payload.status;
    }

    if (payload.sort !== undefined) {
      data.sort = payload.sort;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('没有可更新的字段');
    }

    return data;
  }

  private normalizeOptionalName(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const name = String(value || '').trim();
    if (!name) {
      throw new BadRequestException('\u540d\u79f0\u4e0d\u80fd\u4e3a\u7a7a');
    }
    return name;
  }

  private normalizeDepartmentCode(codeParam: string): string {
    const value = String(codeParam || '').trim();
    if (!value) {
      throw new BadRequestException('部门编码不合法');
    }
    return value;
  }

  private async generateDepartmentCode(): Promise<string> {
    for (let index = 0; index < 10; index += 1) {
      const code = `dept_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const exists = await this.prisma.departmentOption.findUnique({ where: { code } });
      if (!exists) {
        return code;
      }
    }
    throw new BadRequestException('\u90e8\u95e8\u521b\u5efa\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5');
  }

  private async ensureDefaults(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const option of DEPARTMENT_DEFAULTS) {
        await tx.departmentOption.upsert({
          where: { code: option.code },
          update: {},
          create: {
            code: option.code,
            name: option.name,
            sort: option.sort,
            status: 1,
          },
        });
      }

      for (const option of ROLE_DEFAULTS) {
        await tx.roleOption.upsert({
          where: { code: option.code },
          update: {},
          create: {
            code: option.code,
            name: option.name,
            sort: option.sort,
            status: 1,
          },
        });
      }
    });
  }
}

