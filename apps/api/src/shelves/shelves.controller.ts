import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { CreateShelfDto } from './dto/create-shelf.dto';
import { UpdateShelfDto } from './dto/update-shelf.dto';
import { ShelvesService } from './shelves.service';

@Controller('shelves')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShelvesController {
  constructor(private readonly shelvesService: ShelvesService) {}

  @Get()
  async list(@Query('q') q?: string): Promise<unknown[]> {
    return this.shelvesService.list(q);
  }

  @Post()
  async create(
    @Body() payload: CreateShelfDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.shelvesService.create(payload, user.id, req.requestId);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() payload: UpdateShelfDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.shelvesService.update(id, payload, user.id, req.requestId);
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<{ success: boolean }> {
    return this.shelvesService.remove(id, user.id, req.requestId);
  }
}
