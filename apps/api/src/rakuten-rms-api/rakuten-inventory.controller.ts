import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user.type';
import { ExecuteRakutenInventoryDto, SaveRakutenInventoryMappingDto, UpdateRakutenInventoryEnabledDto } from './dto/rakuten-inventory.dto';
import { RakutenInventoryService } from './rakuten-inventory.service';

@Controller('rakuten-rms-api/connections/:connectionId/inventory')
@UseGuards(JwtAuthGuard)
export class RakutenInventoryController {
  constructor(private readonly inventory: RakutenInventoryService) {}
  @Get() status(@Param('connectionId') id: string, @CurrentUser() user: AuthUser) { return this.inventory.status(id, user.id); }
  @Post('check') check(@Param('connectionId') id: string) { return this.inventory.checkConnection(id); }
  @Get('issues') issues(@Param('connectionId') id: string, @Query('page') page?: string) { return this.inventory.issues(id, page); }
  @Post('catalog/refresh') refreshCatalog(@Param('connectionId') id: string) { return this.inventory.refreshCatalog(id); }
  @Get('catalog') catalog(@Param('connectionId') id: string, @Query('page') page?: string, @Query('issuesOnly') issuesOnly?: string, @Query('search') search?: string, @Query('matchStatus') matchStatus?: string) { return this.inventory.catalogStatus(id, page, issuesOnly === 'true', search, matchStatus); }
  @Put('enabled') enabled(@Param('connectionId') id: string, @Body() payload: UpdateRakutenInventoryEnabledDto) { return this.inventory.setEnabled(id, payload.enabled); }
  @Put('mappings') mapping(@Param('connectionId') id: string, @Body() payload: SaveRakutenInventoryMappingDto) { return this.inventory.saveMapping(id, payload); }
  @Post('mappings/:mappingId/disable') disable(@Param('connectionId') id: string, @Param('mappingId') mappingId: string) { return this.inventory.disableMapping(id, mappingId); }
  @Get('jobs/:jobId') job(@Param('connectionId') id: string, @Param('jobId') jobId: string, @CurrentUser() user: AuthUser, @Query('page') page?: string, @Query('filter') filter?: string) { return this.inventory.jobStatus(id, jobId, user.id, page, filter); }
  @Post('preview') preview(@Param('connectionId') id: string, @CurrentUser() user: AuthUser) { return this.inventory.queuePreview(id, user.id); }
  @Post('execute') execute(@Param('connectionId') id: string, @Body() payload: ExecuteRakutenInventoryDto, @CurrentUser() user: AuthUser) { return this.inventory.queueExecute(id, payload.previewId, user.id); }
}
