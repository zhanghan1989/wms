import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
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

  @Put('departments/:code')
  async updateDepartment(
    @Param('code') code: string,
    @Body() payload: UpdateUserOptionDto,
  ): Promise<unknown> {
    return this.userOptionsService.updateDepartment(code, payload);
  }

  @Put('roles/:code')
  async updateRole(
    @Param('code') code: string,
    @Body() payload: UpdateUserOptionDto,
  ): Promise<unknown> {
    return this.userOptionsService.updateRole(code, payload);
  }
}
