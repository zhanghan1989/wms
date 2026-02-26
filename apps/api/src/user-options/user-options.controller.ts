import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateDepartmentOptionDto, CreateRoleOptionDto } from './dto/create-user-option.dto';
import { UpdateUserOptionDto } from './dto/update-user-option.dto';
import { UserOptionsService } from './user-options.service';

@Controller('user-options')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.admin)
export class UserOptionsController {
  constructor(private readonly userOptionsService: UserOptionsService) {}

  @Get()
  async list(): Promise<unknown> {
    return this.userOptionsService.list();
  }

  @Post('departments')
  async createDepartment(@Body() payload: CreateDepartmentOptionDto): Promise<unknown> {
    return this.userOptionsService.createDepartment(payload);
  }

  @Put('departments/:code')
  async updateDepartment(
    @Param('code') code: string,
    @Body() payload: UpdateUserOptionDto,
  ): Promise<unknown> {
    return this.userOptionsService.updateDepartment(code, payload);
  }

  @Post('roles')
  async createRole(@Body() payload: CreateRoleOptionDto): Promise<unknown> {
    return this.userOptionsService.createRole(payload);
  }

  @Put('roles/:code')
  async updateRole(
    @Param('code') code: string,
    @Body() payload: UpdateUserOptionDto,
  ): Promise<unknown> {
    return this.userOptionsService.updateRole(code, payload);
  }
}
