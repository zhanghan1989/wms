import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Department, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDepartmentOptionDto, CreateRoleOptionDto } from './dto/create-user-option.dto';
import { UpdateUserOptionDto } from './dto/update-user-option.dto';

const DEPARTMENT_DEFAULTS: Array<{ code: Department; name: string; sort: number }> = [
  { code: Department.factory, name: '工厂', sort: 10 },
  { code: Department.overseas_warehouse, name: '海外仓', sort: 20 },
  { code: Department.china_warehouse, name: '中国仓', sort: 30 },
];

const ROLE_DEFAULTS: Array<{ code: Role; name: string; sort: number }> = [
  { code: Role.employee, name: '员工', sort: 10 },
  { code: Role.admin, name: '管理者', sort: 20 },
];

@Injectable()
export class UserOptionsService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureSeeded(): Promise<void> {
    await this.ensureDefaults();
  }

  async assertDepartmentEnabled(code: Department): Promise<void> {
    await this.ensureDefaults();
    const option = await this.prisma.departmentOption.findUnique({ where: { code } });
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
    departments: Array<{ id: bigint; code: Department; name: string; status: number; sort: number }>;
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
    const code = this.parseDepartmentCode(payload.code);
    const option = await this.prisma.departmentOption.findUnique({ where: { code } });
    const nextName = this.normalizeOptionalName(payload.name);
    const defaultOption = DEPARTMENT_DEFAULTS.find((item) => item.code === code);

    if (option && option.status === 1) {
      throw new BadRequestException('\u90e8\u95e8\u5df2\u5b58\u5728');
    }

    if (option) {
      return this.prisma.departmentOption.update({
        where: { code },
        data: {
          status: 1,
          name: nextName ?? option.name,
          sort: payload.sort ?? option.sort,
        },
      });
    }

    return this.prisma.departmentOption.create({
      data: {
        code,
        name: nextName ?? defaultOption?.name ?? code,
        status: 1,
        sort: payload.sort ?? defaultOption?.sort ?? 0,
      },
    });
  }

  async createRole(payload: CreateRoleOptionDto): Promise<unknown> {
    await this.ensureSeeded();
    const code = payload.code ? this.parseRoleCode(payload.code) : await this.pickAvailableRoleCode();
    const option = await this.prisma.roleOption.findUnique({ where: { code } });
    const nextName = this.normalizeOptionalName(payload.name);
    const defaultOption = ROLE_DEFAULTS.find((item) => item.code === code);

    if (option && option.status === 1) {
      throw new BadRequestException('\u89d2\u8272\u5df2\u5b58\u5728');
    }

    if (option) {
      return this.prisma.roleOption.update({
        where: { code },
        data: {
          status: 1,
          name: nextName ?? option.name,
          sort: payload.sort ?? option.sort,
        },
      });
    }

    return this.prisma.roleOption.create({
      data: {
        code,
        name: nextName ?? defaultOption?.name ?? code,
        status: 1,
        sort: payload.sort ?? defaultOption?.sort ?? 0,
      },
    });
  }

  async updateDepartment(codeParam: string, payload: UpdateUserOptionDto): Promise<unknown> {
    await this.ensureSeeded();
    const code = this.parseDepartmentCode(codeParam);
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

  async updateRole(codeParam: string, payload: UpdateUserOptionDto): Promise<unknown> {
    await this.ensureSeeded();
    const code = this.parseRoleCode(codeParam);
    const option = await this.prisma.roleOption.findUnique({ where: { code } });
    if (!option) {
      throw new NotFoundException('角色不存在');
    }

    const data = this.buildUpdateData(payload);
    return this.prisma.roleOption.update({
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

  private parseDepartmentCode(codeParam: string): Department {
    const value = String(codeParam || '').trim() as Department;
    if (!Object.values(Department).includes(value)) {
      throw new BadRequestException('部门编码不合法');
    }
    return value;
  }

  private parseRoleCode(codeParam: string): Role {
    const value = String(codeParam || '').trim() as Role;
    if (!Object.values(Role).includes(value)) {
      throw new BadRequestException('角色编码不合法');
    }
    return value;
  }

  private async pickAvailableRoleCode(): Promise<Role> {
    const options = await this.prisma.roleOption.findMany({
      select: {
        code: true,
        status: true,
      },
    });
    const disabledCodeSet = new Set(
      options
        .filter((item) => Number(item.status) !== 1)
        .map((item) => String(item.code)),
    );
    const next = ROLE_DEFAULTS.find((item) => disabledCodeSet.has(String(item.code)));
    if (!next) {
      throw new BadRequestException('\u89d2\u8272\u5df2\u5b58\u5728');
    }
    return next.code;
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
