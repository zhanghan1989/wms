import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { CreateBoxDto } from './dto/create-box.dto';
import { UpdateBoxDto } from './dto/update-box.dto';
import { BoxesService } from './boxes.service';

@Controller('boxes')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BoxesController {
  constructor(private readonly boxesService: BoxesService) {}

  @Get()
  async list(@Query('q') q?: string): Promise<unknown[]> {
    return this.boxesService.list(q);
  }

  @Post()
  async create(
    @Body() payload: CreateBoxDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.boxesService.create(payload, user.id, req.requestId);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() payload: UpdateBoxDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.boxesService.update(id, payload, user.id, req.requestId);
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<{ success: boolean }> {
    return this.boxesService.remove(id, user.id, req.requestId);
  }
}
