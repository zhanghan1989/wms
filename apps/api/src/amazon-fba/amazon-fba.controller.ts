import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { AmazonFbaService } from './amazon-fba.service';
import { ConfirmTransportationOptionsDto } from './dto/confirm-transportation-options.dto';
import { CreateAmazonConnectionDto } from './dto/create-amazon-connection.dto';
import { CreateAmazonInboundJobDto } from './dto/create-amazon-inbound-job.dto';
import { GenerateTransportationOptionsDto } from './dto/generate-transportation-options.dto';
import { GetAmazonShipmentLabelsDto } from './dto/get-amazon-shipment-labels.dto';
import { PushAmazonInboundJobDto } from './dto/push-amazon-inbound-job.dto';
import { SetPackingInformationDto } from './dto/set-packing-information.dto';
import { StartAmazonConnectionOauthDto } from './dto/start-amazon-connection-oauth.dto';
import { CompleteAmazonConnectionOauthDto } from './dto/complete-amazon-connection-oauth.dto';
import { UpdateAmazonAutomationSummaryDto } from './dto/update-amazon-automation-summary.dto';
import { UpdateAmazonShipmentTrackingDto } from './dto/update-amazon-shipment-tracking.dto';
import { UpdateAmazonConnectionDto } from './dto/update-amazon-connection.dto';

@Controller('amazon-fba')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.admin)
export class AmazonFbaController {
  constructor(private readonly amazonFbaService: AmazonFbaService) {}

  @Get('connections')
  async listConnections(): Promise<unknown[]> {
    return this.amazonFbaService.listConnections();
  }

  @Post('connections')
  async createConnection(
    @Body() payload: CreateAmazonConnectionDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.createConnection(payload, user.id, req.requestId);
  }

  @Put('connections/:id')
  async updateConnection(
    @Param('id') id: string,
    @Body() payload: UpdateAmazonConnectionDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.updateConnection(id, payload, user.id, req.requestId);
  }

  @Post('connections/:id/oauth/start')
  async startConnectionAuthorization(
    @Param('id') id: string,
    @Body() payload: StartAmazonConnectionOauthDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.startConnectionAuthorization(id, payload, user.id, req.requestId);
  }

  @Post('connections/:id/oauth/complete')
  async completeConnectionAuthorization(
    @Param('id') id: string,
    @Body() payload: CompleteAmazonConnectionOauthDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.completeConnectionAuthorization(id, payload, user.id, req.requestId);
  }

  @Get('jobs')
  async listJobs(): Promise<unknown[]> {
    return this.amazonFbaService.listJobs();
  }

  @Get('jobs/:id')
  async getJobDetail(@Param('id') id: string): Promise<unknown> {
    return this.amazonFbaService.getJobDetail(id);
  }

  @Post('jobs')
  async createJob(
    @Body() payload: CreateAmazonInboundJobDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.createJob(payload, user.id, req.requestId);
  }

  @Post('jobs/:id/build-payload')
  async buildPayload(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.buildPayload(id, user.id, req.requestId);
  }

  @Post('jobs/:id/push')
  async pushJob(
    @Param('id') id: string,
    @Body() payload: PushAmazonInboundJobDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.pushJob(id, payload, user.id, req.requestId);
  }

  @Post('jobs/:id/sync')
  async syncJob(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.syncJob(id, user.id, req.requestId);
  }

  @Post('jobs/:id/packing-options/generate')
  async generatePackingOptions(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.generatePackingOptions(id, user.id, req.requestId);
  }

  @Get('jobs/:id/packing-options')
  async listPackingOptions(@Param('id') id: string): Promise<unknown> {
    return this.amazonFbaService.listPackingOptions(id);
  }

  @Post('jobs/:id/packing-options/:packingOptionId/confirm')
  async confirmPackingOption(
    @Param('id') id: string,
    @Param('packingOptionId') packingOptionId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.confirmPackingOption(id, packingOptionId, user.id, req.requestId);
  }

  @Post('jobs/:id/packing-information')
  async setPackingInformation(
    @Param('id') id: string,
    @Body() payload: SetPackingInformationDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.setPackingInformation(id, payload, user.id, req.requestId);
  }

  @Post('jobs/:id/placement-options/generate')
  async generatePlacementOptions(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.generatePlacementOptions(id, user.id, req.requestId);
  }

  @Get('jobs/:id/placement-options')
  async listPlacementOptions(@Param('id') id: string): Promise<unknown> {
    return this.amazonFbaService.listPlacementOptions(id);
  }

  @Post('jobs/:id/placement-split-detected')
  async markPlacementSplitDetected(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.markPlacementSplitDetected(id, user.id, req.requestId);
  }

  @Post('jobs/:id/placement-options/:placementOptionId/confirm')
  async confirmPlacementOption(
    @Param('id') id: string,
    @Param('placementOptionId') placementOptionId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.confirmPlacementOption(id, placementOptionId, user.id, req.requestId);
  }

  @Post('jobs/:id/transportation-options/generate')
  async generateTransportationOptions(
    @Param('id') id: string,
    @Body() payload: GenerateTransportationOptionsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.generateTransportationOptions(id, payload, user.id, req.requestId);
  }

  @Get('jobs/:id/transportation-options')
  async listTransportationOptions(
    @Param('id') id: string,
    @Query('placementOptionId') placementOptionId?: string,
  ): Promise<unknown> {
    return this.amazonFbaService.listTransportationOptions(id, placementOptionId);
  }

  @Post('jobs/:id/transportation-options/confirm')
  async confirmTransportationOptions(
    @Param('id') id: string,
    @Body() payload: ConfirmTransportationOptionsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.confirmTransportationOptions(id, payload, user.id, req.requestId);
  }

  @Post('jobs/:id/shipments/:shipmentId/labels')
  async getShipmentLabels(
    @Param('id') id: string,
    @Param('shipmentId') shipmentId: string,
    @Body() payload: GetAmazonShipmentLabelsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.getShipmentLabels(id, shipmentId, payload, user.id, req.requestId);
  }

  @Post('jobs/:id/shipments/:shipmentId/tracking')
  async updateShipmentTracking(
    @Param('id') id: string,
    @Param('shipmentId') shipmentId: string,
    @Body() payload: UpdateAmazonShipmentTrackingDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.updateShipmentTracking(id, shipmentId, payload, user.id, req.requestId);
  }

  @Post('jobs/:id/automation-summary')
  async updateAutomationSummary(
    @Param('id') id: string,
    @Body() payload: UpdateAmazonAutomationSummaryDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.amazonFbaService.updateAutomationSummary(id, payload, user.id, req.requestId);
  }
}
