import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AmazonApiLogStatus,
  AmazonInboundJobStatus,
  AuditAction,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { generateOrderNo, parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import {
  AmazonSpApiRequestError,
  AmazonSpApiService,
  type AmazonConnectionAuthConfig,
} from './amazon-sp-api.service';
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
import { UpdateAmazonConnectionDto } from './dto/update-amazon-connection.dto';
import { UpdateAmazonShipmentTrackingDto } from './dto/update-amazon-shipment-tracking.dto';

type AmazonJobDetail = Prisma.AmazonInboundJobGetPayload<{
  include: {
    connection: true;
    creator: { select: { id: true; username: true } };
    pusher: { select: { id: true; username: true } };
    items: {
      include: {
        sku: { select: { id: true; sku: true; rbSku: true; asin: true; fnsku: true; fbmSku: true; model: true; brand: true; type: true; color: true; shop: true } };
        sourceInventoryBox: { select: { id: true; boxCode: true; shelf: { select: { shelfCode: true; name: true } } } };
        fbaReplenishment: { select: { id: true; requestNo: true; status: true; requestedQty: true; actualQty: true; expressNo: true; remark: true; createdAt: true } };
      };
    };
    shipments: true;
  };
}> & {
  shipments: Array<
    Prisma.AmazonInboundShipmentGetPayload<{
      include: { boxes: true };
    }>
    & {
      boxes: Array<
        Prisma.AmazonInboundBoxGetPayload<{}> & {
          items: Array<Record<string, unknown>>;
        }
      >;
    }
  >;
};

type AmazonSpApiFailure = {
  error: BadRequestException;
  message: string;
  responseStatus: number | null;
  responseBody: unknown;
};

@Injectable()
export class AmazonFbaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly amazonSpApiService: AmazonSpApiService,
  ) {}

  async listConnections(): Promise<unknown[]> {
    return this.prisma.amazonShopConnection.findMany({
      include: { creator: { select: { id: true, username: true } } },
      orderBy: [{ status: 'desc' }, { id: 'desc' }],
    });
  }

  async createConnection(payload: CreateAmazonConnectionDto, operatorId: bigint, requestId?: string): Promise<unknown> {
    const name = payload.name.trim();
    const marketplaceId = payload.marketplaceId.trim().toUpperCase();
    const region = this.normalizeRegion(payload.region);
    const authConfig = this.normalizeAuthConfig(payload.authConfig, marketplaceId, { requireRefreshToken: false });

    const exists = await this.prisma.amazonShopConnection.findUnique({ where: { name }, select: { id: true } });
    if (exists) throw new BadRequestException('Amazon shop connection already exists');

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.amazonShopConnection.create({
        data: {
          name,
          marketplaceId,
          region,
          sellerId: payload.sellerId?.trim() || null,
          authConfig: this.buildStoredAuthConfig(authConfig) as Prisma.InputJsonValue,
          remark: payload.remark?.trim() || null,
          createdBy: operatorId,
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'amazon_shop_connection',
        entityId: created.id,
        action: AuditAction.create,
        eventType: AuditEventType.AMAZON_CONNECTION_CREATED,
        beforeData: null,
        afterData: created as unknown as Record<string, unknown>,
        operatorId,
        requestId,
      });
      return tx.amazonShopConnection.findUnique({
        where: { id: created.id },
        include: { creator: { select: { id: true, username: true } } },
      });
    });
  }

  async updateConnection(idParam: string, payload: UpdateAmazonConnectionDto, operatorId: bigint, requestId?: string): Promise<unknown> {
    const id = parseId(idParam, 'amazonConnectionId');
    const row = await this.prisma.amazonShopConnection.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Amazon shop connection not found');

    const nextName = payload.name?.trim();
    if (nextName && nextName !== row.name) {
      const duplicate = await this.prisma.amazonShopConnection.findUnique({ where: { name: nextName }, select: { id: true } });
      if (duplicate) throw new BadRequestException('Amazon shop connection already exists');
    }

    const marketplaceId = payload.marketplaceId?.trim().toUpperCase() || row.marketplaceId;
    const nextAuthConfig = this.normalizeAuthConfig(
      (payload.authConfig ?? row.authConfig) as Prisma.JsonValue,
      marketplaceId,
      { requireRefreshToken: false },
    );

    const data: Prisma.AmazonShopConnectionUpdateInput = {};
    if (nextName) data.name = nextName;
    if (payload.marketplaceId !== undefined) data.marketplaceId = marketplaceId;
    if (payload.region !== undefined) data.region = this.normalizeRegion(payload.region);
    if (payload.sellerId !== undefined) data.sellerId = payload.sellerId.trim() || null;
    if (payload.status !== undefined) data.status = payload.status;
    if (payload.authConfig !== undefined) data.authConfig = this.buildStoredAuthConfig(nextAuthConfig) as Prisma.InputJsonValue;
    if (payload.remark !== undefined) data.remark = payload.remark.trim() || null;
    if (Object.keys(data).length === 0) throw new BadRequestException('No fields to update');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.amazonShopConnection.update({
        where: { id },
        data,
        include: { creator: { select: { id: true, username: true } } },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'amazon_shop_connection',
        entityId: updated.id,
        action: AuditAction.update,
        eventType: AuditEventType.AMAZON_CONNECTION_UPDATED,
        beforeData: row as unknown as Record<string, unknown>,
        afterData: updated as unknown as Record<string, unknown>,
        operatorId,
        requestId,
      });
      return updated;
      });
  }

  async startConnectionAuthorization(
    idParam: string,
    payload: StartAmazonConnectionOauthDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const id = parseId(idParam, 'amazonConnectionId');
    const row = await this.prisma.amazonShopConnection.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Amazon shop connection not found');

    const authConfig = this.normalizeAuthConfig(row.authConfig, row.marketplaceId, { requireRefreshToken: false });
    if (!authConfig.applicationId) {
      throw new BadRequestException('Amazon authConfig.applicationId is required to start authorization');
    }
    const origin = this.normalizePublicOrigin(payload.origin);
    const oauthUris = this.buildAmazonOauthUris(origin);
    const state = randomUUID().replaceAll('-', '');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const authorizationUrl = this.buildAmazonAuthorizationUrl(row.region, authConfig, state);
    const nextAuthConfig = this.buildStoredAuthConfig({
      ...authConfig,
      oauthState: state,
      oauthStateExpiresAt: expiresAt,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.amazonShopConnection.update({
        where: { id: row.id },
        data: {
          authConfig: nextAuthConfig as Prisma.InputJsonValue,
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'amazon_shop_connection',
        entityId: row.id,
        action: AuditAction.update,
        eventType: AuditEventType.AMAZON_CONNECTION_AUTHORIZATION_STARTED,
        beforeData: {
          oauthState: this.asRecord(row.authConfig)?.oauthState ?? null,
          oauthStateExpiresAt: this.asRecord(row.authConfig)?.oauthStateExpiresAt ?? null,
        },
        afterData: {
          oauthState: state,
          oauthStateExpiresAt: expiresAt,
        },
        operatorId,
        requestId,
      });
    });

    return {
      connectionId: row.id.toString(),
      authorizationUrl,
      loginUri: oauthUris.loginUri,
      redirectUri: oauthUris.redirectUri,
      state,
      expiresAt,
      authorizationVersion: authConfig.authorizationVersion ?? 'published',
    };
  }

  async completeConnectionAuthorization(
    idParam: string,
    payload: CompleteAmazonConnectionOauthDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const id = parseId(idParam, 'amazonConnectionId');
    const row = await this.prisma.amazonShopConnection.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Amazon shop connection not found');

    const authConfig = this.normalizeAuthConfig(row.authConfig, row.marketplaceId, { requireRefreshToken: false });
    const oauthState = String(authConfig.oauthState || '').trim();
    const expectedState = String(payload.state || '').trim();
    if (!oauthState || oauthState !== expectedState) {
      throw new BadRequestException('Amazon authorization state is invalid or expired');
    }
    if (authConfig.oauthStateExpiresAt) {
      const expiresAt = new Date(authConfig.oauthStateExpiresAt);
      if (Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() < Date.now()) {
        throw new BadRequestException('Amazon authorization state has expired, please retry authorization');
      }
    }
    const origin = this.normalizePublicOrigin(payload.origin);
    const { redirectUri } = this.buildAmazonOauthUris(origin);
    const result = await this.amazonSpApiService.exchangeAuthorizationCode(
      authConfig.clientId,
      authConfig.clientSecret,
      payload.spapiOauthCode.trim(),
      redirectUri,
    );

    const nextAuthConfig = this.buildStoredAuthConfig({
      ...authConfig,
      refreshToken: result.refreshToken,
      oauthState: undefined,
      oauthStateExpiresAt: undefined,
      oauthLastAuthorizedAt: new Date().toISOString(),
      oauthLastError: undefined,
      oauthSellingPartnerId: payload.sellingPartnerId.trim(),
    });

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.amazonShopConnection.update({
        where: { id: row.id },
        data: {
          sellerId: payload.sellingPartnerId.trim(),
          authConfig: nextAuthConfig as Prisma.InputJsonValue,
        },
        include: { creator: { select: { id: true, username: true } } },
      });
      await tx.amazonApiLog.create({
        data: {
          connectionId: row.id,
          action: 'oauth_complete',
          requestMethod: 'POST',
          requestUrl: 'https://api.amazon.com/auth/o2/token',
          requestBody: this.normalizeJsonValue({
            grantType: 'authorization_code',
            redirectUri,
            sellingPartnerId: payload.sellingPartnerId.trim(),
          }) as Prisma.InputJsonValue,
          responseStatus: 200,
          responseBody: this.normalizeJsonValue({
            expiresIn: result.expiresIn ?? null,
            accessTokenReceived: Boolean(result.accessToken),
            refreshTokenStored: true,
          }) as Prisma.InputJsonValue,
          status: AmazonApiLogStatus.success,
          createdBy: operatorId,
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'amazon_shop_connection',
        entityId: updated.id,
        action: AuditAction.update,
        eventType: AuditEventType.AMAZON_CONNECTION_AUTHORIZATION_COMPLETED,
        beforeData: {
          sellerId: row.sellerId,
          oauthState,
        },
        afterData: {
          sellerId: updated.sellerId,
          oauthLastAuthorizedAt: this.asRecord(updated.authConfig)?.oauthLastAuthorizedAt ?? null,
          oauthSellingPartnerId: this.asRecord(updated.authConfig)?.oauthSellingPartnerId ?? null,
        },
        operatorId,
        requestId,
      });
      return updated;
    });
  }

  async listJobs(): Promise<unknown[]> {
    return this.prisma.amazonInboundJob.findMany({
      include: {
        connection: { select: { id: true, name: true, marketplaceId: true, region: true } },
        creator: { select: { id: true, username: true } },
        _count: { select: { items: true, shipments: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async getJobDetail(idParam: string): Promise<unknown> {
    return this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
  }

  async createJob(payload: CreateAmazonInboundJobDto, operatorId: bigint, requestId?: string): Promise<unknown> {
    const connectionId = BigInt(payload.connectionId);
    const replenishmentIds = Array.from(new Set(payload.fbaReplenishmentIds.map((id) => BigInt(id))));
    const connection = await this.prisma.amazonShopConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.status !== 1) {
      throw new NotFoundException('Amazon shop connection not found or disabled');
    }

    const replenishments = await this.prisma.fbaReplenishment.findMany({
      where: { id: { in: replenishmentIds } },
      orderBy: { id: 'asc' },
    });
    if (replenishments.length !== replenishmentIds.length) throw new NotFoundException('Some FBA replenishments were not found');
    if (replenishments.some((row) => !['pending_outbound', 'outbound'].includes(String(row.status)))) {
      throw new UnprocessableEntityException(
        'Only pending_outbound or outbound FBA replenishments can be added into an Amazon inbound job',
      );
    }

    const occupied = await this.prisma.amazonInboundJobItem.findFirst({
      where: {
        fbaReplenishmentId: { in: replenishmentIds },
        job: { status: { in: [AmazonInboundJobStatus.draft, AmazonInboundJobStatus.payload_ready, AmazonInboundJobStatus.pushed] } },
      },
      include: { job: { select: { jobNo: true } } },
    });
    if (occupied) throw new BadRequestException(`FBA replenishment already belongs to Amazon job ${occupied.job.jobNo}`);

    return this.prisma.$transaction(async (tx) => {
      const job = await tx.amazonInboundJob.create({
        data: {
          jobNo: generateOrderNo('AFBA'),
          connectionId: connection.id,
          status: AmazonInboundJobStatus.draft,
          sourceType: 'fba_replenishment',
          createdBy: operatorId,
        },
      });
      const defaultCartonRef = `${job.jobNo}-BOX-1`;
      await tx.amazonInboundJobItem.createMany({
        data: replenishments.map((row) => ({
          jobId: job.id,
          fbaReplenishmentId: row.id,
          skuId: row.skuId,
          sourceInventoryBoxId: row.boxId,
          fbaCartonRef: defaultCartonRef,
          requestedQty: row.requestedQty,
          actualQty: row.actualQty,
          status: 'draft',
        })) as Prisma.AmazonInboundJobItemCreateManyInput[],
      });
      await this.auditService.create({
        db: tx,
        entityType: 'amazon_inbound_job',
        entityId: job.id,
        action: AuditAction.create,
        eventType: AuditEventType.AMAZON_INBOUND_JOB_CREATED,
        beforeData: null,
        afterData: { jobNo: job.jobNo, connectionId: connection.id, itemCount: replenishments.length },
        operatorId,
        requestId,
      });
      return this.loadJobDetailOrThrow(job.id);
    });
  }

  async buildPayload(idParam: string, operatorId: bigint, requestId?: string): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);
    const requestPayload = this.buildCreateInboundPlanPayload(job, authConfig);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.amazonInboundJob.update({
        where: { id: job.id },
        data: {
          status: AmazonInboundJobStatus.payload_ready,
          requestPayload: requestPayload as Prisma.InputJsonValue,
          lastError: null,
          lastSyncAt: new Date(),
        },
      });
      await tx.amazonApiLog.create({
        data: {
          connectionId: job.connectionId,
          jobId: job.id,
          action: 'build_payload',
          requestMethod: 'LOCAL',
          requestUrl: 'amazon-fba://build-payload',
          requestBody: requestPayload as Prisma.InputJsonValue,
          responseStatus: 200,
          responseBody: { previewOnly: true, itemCount: job.items.length } as Prisma.InputJsonValue,
          status: AmazonApiLogStatus.success,
          createdBy: operatorId,
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'amazon_inbound_job',
        entityId: updated.id,
        action: AuditAction.update,
        eventType: AuditEventType.AMAZON_INBOUND_JOB_PAYLOAD_BUILT,
        beforeData: { status: job.status, hasRequestPayload: Boolean(job.requestPayload) },
        afterData: { status: updated.status, hasRequestPayload: true, itemCount: job.items.length },
        operatorId,
        requestId,
      });
      return { jobId: updated.id, jobNo: updated.jobNo, status: updated.status, requestPayload };
    });
  }

  async pushJob(idParam: string, payload: PushAmazonInboundJobDto, operatorId: bigint, requestId?: string): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const canPush =
      job.status === AmazonInboundJobStatus.draft ||
      job.status === AmazonInboundJobStatus.payload_ready ||
      job.status === AmazonInboundJobStatus.failed;
    if (!canPush) {
      throw new UnprocessableEntityException('Current Amazon job status does not allow push');
    }

    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);
    const requestPayload = this.buildCreateInboundPlanPayload(job, authConfig);

    try {
      const result = await this.amazonSpApiService.createInboundPlan(
        job.connection.region,
        authConfig,
        requestPayload.amazonRequest,
        payload.idempotencyKey?.trim(),
      );
      const external = this.extractPlanResponse(result.body);
      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: {
            status: AmazonInboundJobStatus.pushed,
            requestPayload: requestPayload as Prisma.InputJsonValue,
            responsePayload: { createInboundPlan: this.normalizeJsonValue(result.body) } as Prisma.InputJsonValue,
            amazonInboundPlanId: external.amazonInboundPlanId,
            lastOperationId: external.operationId,
            lastError: null,
            lastSyncAt: new Date(),
            pushedBy: operatorId,
          },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'create_inbound_plan',
            requestMethod: 'POST',
            requestUrl: '/inbound/fba/2024-03-20/inboundPlans',
            requestBody: requestPayload.amazonRequest as Prisma.InputJsonValue,
            responseStatus: result.status,
            responseBody: this.normalizeJsonValue(result.body) as Prisma.InputJsonValue,
            status: AmazonApiLogStatus.success,
            createdBy: operatorId,
          },
        });
        await this.auditService.create({
          db: tx,
          entityType: 'amazon_inbound_job',
          entityId: job.id,
          action: AuditAction.update,
          eventType: AuditEventType.AMAZON_INBOUND_JOB_PUSHED,
          beforeData: { status: job.status, amazonInboundPlanId: job.amazonInboundPlanId, lastOperationId: job.lastOperationId },
          afterData: { status: AmazonInboundJobStatus.pushed, amazonInboundPlanId: external.amazonInboundPlanId, lastOperationId: external.operationId },
          operatorId,
          requestId,
        });
      });
    } catch (error) {
      const failure = this.normalizePushError(error);
      await this.persistPushFailure(job, requestPayload.amazonRequest, failure, operatorId, requestId);
      throw failure.error;
    }

    return this.loadJobDetailOrThrow(job.id);
  }

  async syncJob(idParam: string, operatorId: bigint, requestId?: string): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    if (!job.lastOperationId) throw new BadRequestException('Amazon operation id is missing, push the job first');

    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);

    try {
      const result = await this.amazonSpApiService.getInboundOperation(job.connection.region, authConfig, job.lastOperationId);
      const operationStatus = this.extractOperationStatus(result.body);
      const nextStatus = operationStatus === 'FAILED' ? AmazonInboundJobStatus.failed : AmazonInboundJobStatus.pushed;
      const shipmentSnapshots =
        operationStatus === 'FAILED' ? [] : await this.fetchShipmentSnapshotsForJob(job, authConfig);

      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: {
            status: nextStatus,
            responsePayload: {
              ...(this.asRecord(job.responsePayload) || {}),
              lastOperationStatus: this.normalizeJsonValue(result.body),
              shipments: shipmentSnapshots.length
                ? {
                    selectedPlacementOptionId: this.extractSelectedPlacementOptionId(job.responsePayload),
                    lastSyncedAt: new Date().toISOString(),
                    items: shipmentSnapshots.map((item) =>
                      this.normalizeJsonValue({
                        shipment: item.body,
                        boxes: item.boxes.map((box) => box.body),
                      }),
                    ),
                  }
                : (this.asRecord(job.responsePayload)?.shipments as Prisma.JsonValue | undefined),
            } as Prisma.InputJsonValue,
            lastError: operationStatus === 'FAILED' ? 'Amazon operation reported FAILED' : null,
            lastSyncAt: new Date(),
          },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'get_inbound_operation',
            requestMethod: 'GET',
            requestUrl: `/inbound/fba/2024-03-20/operations/${job.lastOperationId}`,
            responseStatus: result.status,
            responseBody: this.normalizeJsonValue(result.body) as Prisma.InputJsonValue,
            status: operationStatus === 'FAILED' ? AmazonApiLogStatus.failed : AmazonApiLogStatus.success,
            errorMessage: operationStatus === 'FAILED' ? 'Amazon operation reported FAILED' : null,
            createdBy: operatorId,
          },
        });
        for (const snapshot of shipmentSnapshots) {
          const persistedShipment = await (tx as Prisma.TransactionClient & { amazonInboundShipment: any }).amazonInboundShipment.upsert({
            where: { amazonShipmentId: snapshot.amazonShipmentId },
            update: {
              shipmentConfirmationId: snapshot.shipmentConfirmationId,
              amazonPlanId: job.amazonInboundPlanId,
              shipmentName: snapshot.shipmentName,
              destinationCode: snapshot.destinationCode,
              status: snapshot.status,
              payload: this.normalizeJsonValue(snapshot.body) as Prisma.InputJsonValue,
            },
            create: {
              jobId: job.id,
              amazonShipmentId: snapshot.amazonShipmentId,
              shipmentConfirmationId: snapshot.shipmentConfirmationId,
              amazonPlanId: job.amazonInboundPlanId,
              shipmentName: snapshot.shipmentName,
              destinationCode: snapshot.destinationCode,
              status: snapshot.status,
              payload: this.normalizeJsonValue(snapshot.body) as Prisma.InputJsonValue,
            },
          });
          await (tx as Prisma.TransactionClient & { amazonInboundBoxItem: any }).amazonInboundBoxItem.deleteMany({
            where: {
              shipmentId: persistedShipment.id,
              amazonBoxId: { notIn: snapshot.boxes.map((item) => item.amazonBoxId) },
            },
          });
          await (tx as Prisma.TransactionClient & { amazonInboundBox: any }).amazonInboundBox.deleteMany({
            where: {
              shipmentId: persistedShipment.id,
              amazonBoxId: { notIn: snapshot.boxes.map((item) => item.amazonBoxId) },
            },
          });
          for (const box of snapshot.boxes) {
            const persistedBox = await (tx as Prisma.TransactionClient & {
              amazonInboundBox: any;
              amazonInboundBoxItem: any;
            }).amazonInboundBox.upsert({
              where: {
                shipmentId_amazonBoxId: {
                  shipmentId: persistedShipment.id,
                  amazonBoxId: box.amazonBoxId,
                },
              },
              update: {
                amazonShipmentId: snapshot.amazonShipmentId,
                boxSequence: box.boxSequence,
                templateName: box.templateName,
                contentSource: box.contentSource,
                quantity: box.quantity,
                status: box.status,
                payload: this.normalizeJsonValue(box.body) as Prisma.InputJsonValue,
              },
              create: {
                jobId: job.id,
                shipmentId: persistedShipment.id,
                amazonShipmentId: snapshot.amazonShipmentId,
                amazonBoxId: box.amazonBoxId,
                boxSequence: box.boxSequence,
                templateName: box.templateName,
                contentSource: box.contentSource,
                quantity: box.quantity,
                status: box.status,
                payload: this.normalizeJsonValue(box.body) as Prisma.InputJsonValue,
              },
            });
            await (tx as Prisma.TransactionClient & {
              amazonInboundBoxItem: any;
            }).amazonInboundBoxItem.deleteMany({
              where: { boxId: persistedBox.id },
            });
            if (box.items.length) {
              await (tx as Prisma.TransactionClient & {
                amazonInboundBoxItem: any;
              }).amazonInboundBoxItem.createMany({
                data: box.items.map((item) => ({
                  jobId: job.id,
                  shipmentId: persistedShipment.id,
                  boxId: persistedBox.id,
                  amazonShipmentId: snapshot.amazonShipmentId,
                  amazonBoxId: box.amazonBoxId,
                  msku: item.msku,
                  fnsku: item.fnsku,
                  asin: item.asin,
                  quantity: item.quantity,
                  payload: this.normalizeJsonValue(item.body) as Prisma.InputJsonValue,
                })),
              });
            }
          }
          await tx.amazonApiLog.create({
            data: {
              connectionId: job.connectionId,
              jobId: job.id,
              action: 'get_shipment',
              requestMethod: 'GET',
              requestUrl: `/inbound/fba/2024-03-20/inboundPlans/${job.amazonInboundPlanId}/shipments/${snapshot.amazonShipmentId}`,
              responseStatus: snapshot.responseStatus,
              responseBody: this.normalizeJsonValue(snapshot.body) as Prisma.InputJsonValue,
              status: AmazonApiLogStatus.success,
              createdBy: operatorId,
            },
          });
          await tx.amazonApiLog.create({
            data: {
              connectionId: job.connectionId,
              jobId: job.id,
              action: 'list_shipment_boxes',
              requestMethod: 'GET',
              requestUrl: `/inbound/fba/2024-03-20/inboundPlans/${job.amazonInboundPlanId}/shipments/${snapshot.amazonShipmentId}/boxes`,
              responseStatus: snapshot.boxesResponseStatus,
              responseBody: this.normalizeJsonValue(snapshot.boxes.map((item) => item.body)) as Prisma.InputJsonValue,
              status: AmazonApiLogStatus.success,
              createdBy: operatorId,
            },
          });
        }
        await this.auditService.create({
          db: tx,
          entityType: 'amazon_inbound_job',
          entityId: job.id,
          action: AuditAction.update,
          eventType: operationStatus === 'FAILED' ? AuditEventType.AMAZON_INBOUND_JOB_SYNC_FAILED : AuditEventType.AMAZON_INBOUND_JOB_SYNCED,
          beforeData: { status: job.status, lastOperationId: job.lastOperationId },
          afterData: { status: nextStatus, lastOperationId: job.lastOperationId, operationStatus },
          operatorId,
          requestId,
        });
        if (shipmentSnapshots.length) {
          await this.auditService.create({
            db: tx,
            entityType: 'amazon_inbound_job',
            entityId: job.id,
            action: AuditAction.update,
            eventType: AuditEventType.AMAZON_INBOUND_JOB_SHIPMENTS_SYNCED,
            beforeData: { shipmentCount: job.shipments.length },
            afterData: {
              shipmentCount: shipmentSnapshots.length,
              shipmentIds: shipmentSnapshots.map((item) => item.amazonShipmentId),
              boxCount: shipmentSnapshots.reduce((sum, item) => sum + item.boxes.length, 0),
            },
            operatorId,
            requestId,
          });
        }
      });
    } catch (error) {
      const failure = this.normalizePushError(error);
      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: { status: AmazonInboundJobStatus.failed, lastError: failure.message, lastSyncAt: new Date() },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'get_inbound_operation',
            requestMethod: 'GET',
            requestUrl: `/inbound/fba/2024-03-20/operations/${job.lastOperationId}`,
            responseStatus: failure.responseStatus,
            responseBody: this.normalizeJsonValue(failure.responseBody) as Prisma.InputJsonValue,
            status: AmazonApiLogStatus.failed,
            errorMessage: failure.message,
            createdBy: operatorId,
          },
        });
        await this.auditService.create({
          db: tx,
          entityType: 'amazon_inbound_job',
          entityId: job.id,
          action: AuditAction.update,
          eventType: AuditEventType.AMAZON_INBOUND_JOB_SYNC_FAILED,
          beforeData: { status: job.status, lastOperationId: job.lastOperationId },
          afterData: { status: AmazonInboundJobStatus.failed, lastOperationId: job.lastOperationId, errorMessage: failure.message },
          operatorId,
          requestId,
        });
      });
      throw failure.error;
    }

    return this.loadJobDetailOrThrow(job.id);
  }

  async generatePackingOptions(idParam: string, operatorId: bigint, requestId?: string): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const inboundPlanId = this.requireInboundPlanId(job);
    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);

    try {
      const result = await this.amazonSpApiService.generatePackingOptions(
        job.connection.region,
        authConfig,
        inboundPlanId,
        `${job.jobNo}-packing-${Date.now()}`,
      );
      const operationId = this.extractOperationId(result.body);
      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: {
            responsePayload: this.buildPackingResponsePayload(job.responsePayload, {
              generateResponse: result.body,
            }) as Prisma.InputJsonValue,
            lastOperationId: operationId,
            lastError: null,
            lastSyncAt: new Date(),
          },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'generate_packing_options',
            requestMethod: 'POST',
            requestUrl: `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/packingOptions`,
            responseStatus: result.status,
            responseBody: this.normalizeJsonValue(result.body) as Prisma.InputJsonValue,
            status: AmazonApiLogStatus.success,
            createdBy: operatorId,
          },
        });
        await this.auditService.create({
          db: tx,
          entityType: 'amazon_inbound_job',
          entityId: job.id,
          action: AuditAction.update,
          eventType: AuditEventType.AMAZON_INBOUND_JOB_PACKING_UPDATED,
          beforeData: { lastOperationId: job.lastOperationId },
          afterData: { step: 'generate_packing_options', lastOperationId: operationId },
          operatorId,
          requestId,
        });
      });
    } catch (error) {
      const failure = this.normalizePushError(error);
      await this.persistAmazonActionFailure(
        job,
        'generate_packing_options',
        'POST',
        `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/packingOptions`,
        failure,
        operatorId,
        requestId,
      );
      throw failure.error;
    }

    return this.loadJobDetailOrThrow(job.id);
  }

  async listPackingOptions(idParam: string): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const inboundPlanId = this.requireInboundPlanId(job);
    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);
    const result = await this.amazonSpApiService.listPackingOptions(job.connection.region, authConfig, inboundPlanId);
    const options = this.extractPackingOptions(result.body);

    await this.prisma.amazonInboundJob.update({
      where: { id: job.id },
      data: {
        responsePayload: this.buildPackingResponsePayload(job.responsePayload, {
          listResponse: result.body,
          options,
        }) as Prisma.InputJsonValue,
        lastError: null,
        lastSyncAt: new Date(),
      },
    });

    return this.loadJobDetailOrThrow(job.id);
  }

  async confirmPackingOption(
    idParam: string,
    packingOptionId: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const inboundPlanId = this.requireInboundPlanId(job);
    const normalizedPackingOptionId = String(packingOptionId || '').trim();
    if (!normalizedPackingOptionId) {
      throw new BadRequestException('packingOptionId is required');
    }
    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);

    try {
      const result = await this.amazonSpApiService.confirmPackingOption(
        job.connection.region,
        authConfig,
        inboundPlanId,
        normalizedPackingOptionId,
        `${job.jobNo}-packing-confirm-${Date.now()}`,
      );
      const operationId = this.extractOperationId(result.body);
      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: {
            responsePayload: this.buildPackingResponsePayload(job.responsePayload, {
              selectedPackingOptionId: normalizedPackingOptionId,
              confirmationResponse: result.body,
            }) as Prisma.InputJsonValue,
            lastOperationId: operationId,
            lastError: null,
            lastSyncAt: new Date(),
          },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'confirm_packing_option',
            requestMethod: 'POST',
            requestUrl: `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/packingOptions/${normalizedPackingOptionId}/confirmation`,
            responseStatus: result.status,
            responseBody: this.normalizeJsonValue(result.body) as Prisma.InputJsonValue,
            status: AmazonApiLogStatus.success,
            createdBy: operatorId,
          },
        });
        await this.auditService.create({
          db: tx,
          entityType: 'amazon_inbound_job',
          entityId: job.id,
          action: AuditAction.update,
          eventType: AuditEventType.AMAZON_INBOUND_JOB_PACKING_UPDATED,
          beforeData: { selectedPackingOptionId: this.extractSelectedPackingOptionId(job.responsePayload) },
          afterData: {
            step: 'confirm_packing_option',
            selectedPackingOptionId: normalizedPackingOptionId,
            lastOperationId: operationId,
          },
          operatorId,
          requestId,
        });
      });
    } catch (error) {
      const failure = this.normalizePushError(error);
      await this.persistAmazonActionFailure(
        job,
        'confirm_packing_option',
        'POST',
        `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/packingOptions/${normalizedPackingOptionId}/confirmation`,
        failure,
        operatorId,
        requestId,
      );
      throw failure.error;
    }

    return this.loadJobDetailOrThrow(job.id);
  }

  async setPackingInformation(
    idParam: string,
    payload: SetPackingInformationDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const inboundPlanId = this.requireInboundPlanId(job);
    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);
    const requestBody = this.normalizePackingInformationPayload(job, payload.packingInformation);

    try {
      const result = await this.amazonSpApiService.setPackingInformation(
        job.connection.region,
        authConfig,
        inboundPlanId,
        requestBody,
        `${job.jobNo}-packing-information-${Date.now()}`,
      );
      const operationId = this.extractOperationId(result.body);
      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: {
            responsePayload: this.buildPackingResponsePayload(job.responsePayload, {
              packingInformationRequest: requestBody,
              packingInformationResponse: result.body,
            }) as Prisma.InputJsonValue,
            lastOperationId: operationId,
            lastError: null,
            lastSyncAt: new Date(),
          },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'set_packing_information',
            requestMethod: 'POST',
            requestUrl: `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/packingInformation`,
            requestBody: requestBody as Prisma.InputJsonValue,
            responseStatus: result.status,
            responseBody: this.normalizeJsonValue(result.body) as Prisma.InputJsonValue,
            status: AmazonApiLogStatus.success,
            createdBy: operatorId,
          },
        });
        await this.auditService.create({
          db: tx,
          entityType: 'amazon_inbound_job',
          entityId: job.id,
          action: AuditAction.update,
          eventType: AuditEventType.AMAZON_INBOUND_JOB_PACKING_INFORMATION_UPDATED,
          beforeData: null,
          afterData: {
            step: 'set_packing_information',
            lastOperationId: operationId,
            hasPackingInformation: true,
          },
          operatorId,
          requestId,
        });
      });
    } catch (error) {
      const failure = this.normalizePushError(error);
      await this.persistAmazonActionFailure(
        job,
        'set_packing_information',
        'POST',
        `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/packingInformation`,
        failure,
        operatorId,
        requestId,
        requestBody,
      );
      throw failure.error;
    }

    return this.loadJobDetailOrThrow(job.id);
  }

  async generatePlacementOptions(idParam: string, operatorId: bigint, requestId?: string): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const inboundPlanId = this.requireInboundPlanId(job);
    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);

    try {
      const result = await this.amazonSpApiService.generatePlacementOptions(
        job.connection.region,
        authConfig,
        inboundPlanId,
        `${job.jobNo}-placement-${Date.now()}`,
      );
      const operationId = this.extractOperationId(result.body);
      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: {
            responsePayload: this.buildPlacementResponsePayload(job.responsePayload, {
              generatedResponse: result.body,
            }) as Prisma.InputJsonValue,
            lastOperationId: operationId,
            lastError: null,
            lastSyncAt: new Date(),
          },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'generate_placement_options',
            requestMethod: 'POST',
            requestUrl: `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/placementOptions`,
            responseStatus: result.status,
            responseBody: this.normalizeJsonValue(result.body) as Prisma.InputJsonValue,
            status: AmazonApiLogStatus.success,
            createdBy: operatorId,
          },
        });
        await this.auditService.create({
          db: tx,
          entityType: 'amazon_inbound_job',
          entityId: job.id,
          action: AuditAction.update,
          eventType: AuditEventType.AMAZON_INBOUND_JOB_PLACEMENT_UPDATED,
          beforeData: { lastOperationId: job.lastOperationId },
          afterData: { step: 'generate_placement_options', lastOperationId: operationId },
          operatorId,
          requestId,
        });
      });
    } catch (error) {
      const failure = this.normalizePushError(error);
      await this.persistAmazonActionFailure(
        job,
        'generate_placement_options',
        'POST',
        `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/placementOptions`,
        failure,
        operatorId,
        requestId,
      );
      throw failure.error;
    }

    return this.loadJobDetailOrThrow(job.id);
  }

  async listPlacementOptions(idParam: string): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const inboundPlanId = this.requireInboundPlanId(job);
    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);
    const result = await this.amazonSpApiService.listPlacementOptions(job.connection.region, authConfig, inboundPlanId);
    const options = this.extractPlacementOptions(result.body);

    await this.prisma.amazonInboundJob.update({
      where: { id: job.id },
      data: {
        responsePayload: this.buildPlacementResponsePayload(job.responsePayload, {
          listResponse: result.body,
          options,
        }) as Prisma.InputJsonValue,
        lastError: null,
        lastSyncAt: new Date(),
      },
    });

    return this.loadJobDetailOrThrow(job.id);
  }

  async markPlacementSplitDetected(idParam: string, operatorId: bigint, requestId?: string): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const errorMessage = 'Amazon 检测到分仓，请减少本次勾选的 FBA 补货申请单号后重新执行出库。';

    await this.prisma.$transaction(async (tx) => {
      await tx.amazonInboundJob.update({
        where: { id: job.id },
        data: {
          status: AmazonInboundJobStatus.failed,
          lastError: errorMessage,
          lastSyncAt: new Date(),
        },
      });
      await tx.amazonApiLog.create({
        data: {
          connectionId: job.connectionId,
          jobId: job.id,
          action: 'placement_split_detected',
          requestMethod: 'LOCAL',
          requestUrl: 'amazon-fba://placement-split-detected',
          responseBody: {
            reason: 'placement_split_detected',
            message: errorMessage,
          } as Prisma.InputJsonValue,
          status: AmazonApiLogStatus.failed,
          errorMessage,
          createdBy: operatorId,
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'amazon_inbound_job',
        entityId: job.id,
        action: AuditAction.update,
        eventType: AuditEventType.AMAZON_INBOUND_JOB_PLACEMENT_UPDATED,
        beforeData: { status: job.status },
        afterData: {
          status: AmazonInboundJobStatus.failed,
          reason: 'placement_split_detected',
          errorMessage,
        },
        operatorId,
        requestId,
      });
    });

    return this.loadJobDetailOrThrow(job.id);
  }

  async confirmPlacementOption(
    idParam: string,
    placementOptionId: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const inboundPlanId = this.requireInboundPlanId(job);
    const normalizedPlacementOptionId = String(placementOptionId || '').trim();
    if (!normalizedPlacementOptionId) {
      throw new BadRequestException('placementOptionId is required');
    }
    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);

    try {
      const result = await this.amazonSpApiService.confirmPlacementOption(
        job.connection.region,
        authConfig,
        inboundPlanId,
        normalizedPlacementOptionId,
        `${job.jobNo}-placement-confirm-${Date.now()}`,
      );
      const operationId = this.extractOperationId(result.body);
      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: {
            responsePayload: this.buildPlacementResponsePayload(job.responsePayload, {
              selectedPlacementOptionId: normalizedPlacementOptionId,
              confirmationResponse: result.body,
            }) as Prisma.InputJsonValue,
            lastOperationId: operationId,
            lastError: null,
            lastSyncAt: new Date(),
          },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'confirm_placement_option',
            requestMethod: 'POST',
            requestUrl: `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/placementOptions/${normalizedPlacementOptionId}/confirmation`,
            responseStatus: result.status,
            responseBody: this.normalizeJsonValue(result.body) as Prisma.InputJsonValue,
            status: AmazonApiLogStatus.success,
            createdBy: operatorId,
          },
        });
        await this.auditService.create({
          db: tx,
          entityType: 'amazon_inbound_job',
          entityId: job.id,
          action: AuditAction.update,
          eventType: AuditEventType.AMAZON_INBOUND_JOB_PLACEMENT_UPDATED,
          beforeData: { selectedPlacementOptionId: this.extractSelectedPlacementOptionId(job.responsePayload) },
          afterData: {
            step: 'confirm_placement_option',
            selectedPlacementOptionId: normalizedPlacementOptionId,
            lastOperationId: operationId,
          },
          operatorId,
          requestId,
        });
      });
    } catch (error) {
      const failure = this.normalizePushError(error);
      await this.persistAmazonActionFailure(
        job,
        'confirm_placement_option',
        'POST',
        `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/placementOptions/${normalizedPlacementOptionId}/confirmation`,
        failure,
        operatorId,
        requestId,
      );
      throw failure.error;
    }

    return this.loadJobDetailOrThrow(job.id);
  }

  async generateTransportationOptions(
    idParam: string,
    payload: GenerateTransportationOptionsDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const inboundPlanId = this.requireInboundPlanId(job);
    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);
    const requestBody = this.buildGenerateTransportationOptionsPayload(job, payload);

    try {
      const result = await this.amazonSpApiService.generateTransportationOptions(
        job.connection.region,
        authConfig,
        inboundPlanId,
        requestBody,
        `${job.jobNo}-transport-${Date.now()}`,
      );
      const operationId = this.extractOperationId(result.body);
      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: {
            responsePayload: this.buildTransportationResponsePayload(job.responsePayload, {
              placementOptionId: payload.placementOptionId,
              generateRequest: requestBody,
              generateResponse: result.body,
            }) as Prisma.InputJsonValue,
            lastOperationId: operationId,
            lastError: null,
            lastSyncAt: new Date(),
          },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'generate_transportation_options',
            requestMethod: 'POST',
            requestUrl: `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/transportationOptions`,
            requestBody: requestBody as Prisma.InputJsonValue,
            responseStatus: result.status,
            responseBody: this.normalizeJsonValue(result.body) as Prisma.InputJsonValue,
            status: AmazonApiLogStatus.success,
            createdBy: operatorId,
          },
        });
        await this.auditService.create({
          db: tx,
          entityType: 'amazon_inbound_job',
          entityId: job.id,
          action: AuditAction.update,
          eventType: AuditEventType.AMAZON_INBOUND_JOB_TRANSPORTATION_UPDATED,
          beforeData: null,
          afterData: {
            step: 'generate_transportation_options',
            placementOptionId: payload.placementOptionId,
            lastOperationId: operationId,
          },
          operatorId,
          requestId,
        });
      });
    } catch (error) {
      const failure = this.normalizePushError(error);
      await this.persistAmazonActionFailure(
        job,
        'generate_transportation_options',
        'POST',
        `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/transportationOptions`,
        failure,
        operatorId,
        requestId,
        requestBody,
      );
      throw failure.error;
    }

    return this.loadJobDetailOrThrow(job.id);
  }

  async listTransportationOptions(idParam: string, placementOptionId?: string): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const inboundPlanId = this.requireInboundPlanId(job);
    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);
    const normalizedPlacementOptionId =
      String(placementOptionId || '').trim() || this.extractSelectedPlacementOptionId(job.responsePayload);
    if (!normalizedPlacementOptionId) {
      throw new BadRequestException('placementOptionId is required');
    }

    const result = await this.amazonSpApiService.listTransportationOptions(
      job.connection.region,
      authConfig,
      inboundPlanId,
      normalizedPlacementOptionId,
    );
    const options = this.extractTransportationOptions(result.body);

    await this.prisma.amazonInboundJob.update({
      where: { id: job.id },
      data: {
        responsePayload: this.buildTransportationResponsePayload(job.responsePayload, {
          placementOptionId: normalizedPlacementOptionId,
          listResponse: result.body,
          options,
        }) as Prisma.InputJsonValue,
        lastError: null,
        lastSyncAt: new Date(),
      },
    });

    return this.loadJobDetailOrThrow(job.id);
  }

  async confirmTransportationOptions(
    idParam: string,
    payload: ConfirmTransportationOptionsDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const inboundPlanId = this.requireInboundPlanId(job);
    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);
    const requestBody = {
      transportationSelections: payload.transportationSelections.map((item) => ({
        shipmentId: item.shipmentId.trim(),
        transportationOptionId: item.transportationOptionId.trim(),
      })),
    };

    try {
      const result = await this.amazonSpApiService.confirmTransportationOptions(
        job.connection.region,
        authConfig,
        inboundPlanId,
        requestBody,
        `${job.jobNo}-transport-confirm-${Date.now()}`,
      );
      const operationId = this.extractOperationId(result.body);
      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: {
            responsePayload: this.buildTransportationResponsePayload(job.responsePayload, {
              confirmedSelections: requestBody.transportationSelections,
              confirmationResponse: result.body,
            }) as Prisma.InputJsonValue,
            lastOperationId: operationId,
            lastError: null,
            lastSyncAt: new Date(),
          },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'confirm_transportation_options',
            requestMethod: 'POST',
            requestUrl: `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/transportationOptions/confirmation`,
            requestBody: requestBody as Prisma.InputJsonValue,
            responseStatus: result.status,
            responseBody: this.normalizeJsonValue(result.body) as Prisma.InputJsonValue,
            status: AmazonApiLogStatus.success,
            createdBy: operatorId,
          },
        });
        await this.auditService.create({
          db: tx,
          entityType: 'amazon_inbound_job',
          entityId: job.id,
          action: AuditAction.update,
          eventType: AuditEventType.AMAZON_INBOUND_JOB_TRANSPORTATION_UPDATED,
          beforeData: null,
          afterData: {
            step: 'confirm_transportation_options',
            lastOperationId: operationId,
            shipmentCount: requestBody.transportationSelections.length,
          },
          operatorId,
          requestId,
        });
      });
    } catch (error) {
      const failure = this.normalizePushError(error);
      await this.persistAmazonActionFailure(
        job,
        'confirm_transportation_options',
        'POST',
        `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/transportationOptions/confirmation`,
        failure,
        operatorId,
        requestId,
        requestBody,
      );
      throw failure.error;
    }

    return this.loadJobDetailOrThrow(job.id);
  }

  async getShipmentLabels(
    idParam: string,
    shipmentIdParam: string,
    payload: GetAmazonShipmentLabelsDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const shipmentId = parseId(shipmentIdParam, 'amazonInboundShipmentId');
    const shipment = job.shipments.find((item) => item.id === shipmentId) as AmazonJobDetail['shipments'][number] | undefined;
    if (!shipment) {
      throw new NotFoundException('Amazon shipment not found in current job');
    }
    const shipmentConfirmationId = String((shipment as { shipmentConfirmationId?: string | null }).shipmentConfirmationId || '').trim();
    if (!shipmentConfirmationId) {
      throw new BadRequestException('当前货件缺少 shipmentConfirmationId，请先同步 Amazon shipment 信息');
    }

    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);
    const shipmentBoxes = Array.isArray(shipment?.boxes) ? shipment.boxes : [];
    const singleBoxId = this.requireSingleAmazonBoxId(shipmentBoxes);
    const packageLabelsToPrint =
      Array.isArray(payload.packageLabelsToPrint) && payload.packageLabelsToPrint.length
        ? payload.packageLabelsToPrint.map((item) => item.trim()).filter(Boolean)
        : [singleBoxId];
    const requestQuery: Record<string, string> = {
      PageType: String(payload.pageType || 'PackageLabel_Letter_2').trim(),
      LabelType: String(payload.labelType || 'PACKAGE_LABEL').trim(),
    };
    if (packageLabelsToPrint.length) {
      requestQuery.PackageLabelsToPrint = packageLabelsToPrint.join(',');
    }
    if (payload.numberOfPackages) {
      requestQuery.NumberOfPackages = String(payload.numberOfPackages);
    } else if (!packageLabelsToPrint.length && shipmentBoxes.length) {
      requestQuery.NumberOfPackages = String(shipmentBoxes.length);
    }
    if (payload.pageSize) {
      requestQuery.PageSize = String(payload.pageSize).trim();
    }

    try {
      const result = await this.amazonSpApiService.getLabels(
        job.connection.region,
        authConfig,
        shipmentConfirmationId,
        requestQuery,
      );
      const downloadUrl = this.extractLabelDownloadUrl(result.body);
      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: {
            responsePayload: this.buildLabelsResponsePayload(job.responsePayload, shipment.amazonShipmentId, {
              request: requestQuery,
              response: result.body,
              downloadUrl,
            }) as Prisma.InputJsonValue,
            lastError: null,
            lastSyncAt: new Date(),
          },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'get_labels',
            requestMethod: 'GET',
            requestUrl: `/fba/inbound/v0/shipments/${shipmentConfirmationId}/labels?${new URLSearchParams(requestQuery).toString()}`,
            responseStatus: result.status,
            responseBody: this.normalizeJsonValue(result.body) as Prisma.InputJsonValue,
            status: AmazonApiLogStatus.success,
            createdBy: operatorId,
          },
        });
        await this.auditService.create({
          db: tx,
          entityType: 'amazon_inbound_job',
          entityId: job.id,
          action: AuditAction.update,
          eventType: AuditEventType.AMAZON_INBOUND_JOB_LABELS_UPDATED,
          beforeData: { amazonShipmentId: shipment.amazonShipmentId },
          afterData: {
            amazonShipmentId: shipment.amazonShipmentId,
            shipmentConfirmationId,
            labelType: requestQuery.LabelType,
            pageType: requestQuery.PageType,
            downloadUrl,
          },
          operatorId,
          requestId,
        });
      });
      return {
        amazonShipmentId: shipment.amazonShipmentId,
        shipmentConfirmationId,
        requestQuery,
        downloadUrl,
        responseBody: result.body,
      };
    } catch (error) {
      const failure = this.normalizePushError(error);
      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: {
            lastError: failure.message,
            lastSyncAt: new Date(),
          },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'get_labels',
            requestMethod: 'GET',
            requestUrl: `/fba/inbound/v0/shipments/${shipmentConfirmationId}/labels?${new URLSearchParams(requestQuery).toString()}`,
            responseStatus: failure.responseStatus,
            responseBody: this.normalizeJsonValue(failure.responseBody) as Prisma.InputJsonValue,
            status: AmazonApiLogStatus.failed,
            errorMessage: failure.message,
            createdBy: operatorId,
          },
        });
      });
      throw failure.error;
    }
  }

  async updateShipmentTracking(
    idParam: string,
    shipmentIdParam: string,
    payload: UpdateAmazonShipmentTrackingDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const inboundPlanId = this.requireInboundPlanId(job);
    const shipmentId = parseId(shipmentIdParam, 'amazonInboundShipmentId');
    const shipment = job.shipments.find((item) => item.id === shipmentId) as AmazonJobDetail['shipments'][number] | undefined;
    if (!shipment) {
      throw new NotFoundException('Amazon shipment not found in current job');
    }

    const shipmentBoxes = Array.isArray(shipment?.boxes) ? shipment.boxes : [];
    const singleBoxId = this.requireSingleAmazonBoxId(shipmentBoxes);
    const trackingId = String(payload.trackingId || '').trim();
    const spdTrackingItems =
      Array.isArray(payload.boxTrackingItems) && payload.boxTrackingItems.length
        ? payload.boxTrackingItems.map((item) => ({
            boxId: item.boxId.trim(),
            trackingId: item.trackingId.trim(),
          }))
        : [
            {
              boxId: singleBoxId,
              trackingId,
            },
          ];

    if (!spdTrackingItems.length) {
      throw new BadRequestException('当前货件缺少 Amazon boxId，无法回传物流单号');
    }
    if (spdTrackingItems.some((item) => !item.boxId || !item.trackingId)) {
      throw new BadRequestException('物流单号回传需要有效的 boxId 和 trackingId');
    }

    const authConfig = this.normalizeAuthConfig(job.connection.authConfig, job.connection.marketplaceId);
    const requestBody = {
      trackingDetails: {
        spdTrackingDetail: {
          boxIdToTrackingIdList: spdTrackingItems,
        },
      },
    };

    try {
      const result = await this.amazonSpApiService.updateShipmentTrackingDetails(
        job.connection.region,
        authConfig,
        inboundPlanId,
        shipment.amazonShipmentId,
        requestBody,
      );
      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: {
            responsePayload: this.buildTrackingResponsePayload(job.responsePayload, shipment.amazonShipmentId, {
              request: requestBody,
              response: result.body,
            }) as Prisma.InputJsonValue,
            lastError: null,
            lastSyncAt: new Date(),
          },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'update_shipment_tracking_details',
            requestMethod: 'PUT',
            requestUrl: `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/shipments/${shipment.amazonShipmentId}/trackingDetails`,
            requestBody: requestBody as Prisma.InputJsonValue,
            responseStatus: result.status,
            responseBody: this.normalizeJsonValue(result.body) as Prisma.InputJsonValue,
            status: AmazonApiLogStatus.success,
            createdBy: operatorId,
          },
        });
        await this.auditService.create({
          db: tx,
          entityType: 'amazon_inbound_job',
          entityId: job.id,
          action: AuditAction.update,
          eventType: AuditEventType.AMAZON_INBOUND_JOB_TRACKING_UPDATED,
          beforeData: { amazonShipmentId: shipment.amazonShipmentId },
          afterData: {
            amazonShipmentId: shipment.amazonShipmentId,
            trackingItemCount: spdTrackingItems.length,
            trackingIds: [...new Set(spdTrackingItems.map((item) => item.trackingId))],
          },
          operatorId,
          requestId,
        });
      });
      return {
        amazonShipmentId: shipment.amazonShipmentId,
        trackingItemCount: spdTrackingItems.length,
        trackingIds: [...new Set(spdTrackingItems.map((item) => item.trackingId))],
        responseBody: result.body,
      };
    } catch (error) {
      const failure = this.normalizePushError(error);
      await this.prisma.$transaction(async (tx) => {
        await tx.amazonInboundJob.update({
          where: { id: job.id },
          data: {
            lastError: failure.message,
            lastSyncAt: new Date(),
          },
        });
        await tx.amazonApiLog.create({
          data: {
            connectionId: job.connectionId,
            jobId: job.id,
            action: 'update_shipment_tracking_details',
            requestMethod: 'PUT',
            requestUrl: `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/shipments/${shipment.amazonShipmentId}/trackingDetails`,
            requestBody: requestBody as Prisma.InputJsonValue,
            responseStatus: failure.responseStatus,
            responseBody: this.normalizeJsonValue(failure.responseBody) as Prisma.InputJsonValue,
            status: AmazonApiLogStatus.failed,
            errorMessage: failure.message,
            createdBy: operatorId,
          },
        });
      });
      throw failure.error;
    }
  }

  async updateAutomationSummary(
    idParam: string,
    payload: UpdateAmazonAutomationSummaryDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const job = await this.loadJobDetailOrThrow(parseId(idParam, 'amazonInboundJobId'));
    const summary = this.asRecord(payload.summary);
    if (!summary) {
      throw new BadRequestException('automation summary must be a JSON object');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.amazonInboundJob.update({
        where: { id: job.id },
        data: {
          responsePayload: this.buildAutomationResponsePayload(job.responsePayload, summary) as Prisma.InputJsonValue,
          lastError: null,
          lastSyncAt: new Date(),
        },
      });
      await tx.amazonApiLog.create({
        data: {
          connectionId: job.connectionId,
          jobId: job.id,
          action: 'update_automation_summary',
          requestMethod: 'LOCAL',
          requestUrl: 'amazon-fba://automation-summary',
          requestBody: this.normalizeJsonValue(summary) as Prisma.InputJsonValue,
          status: AmazonApiLogStatus.success,
          createdBy: operatorId,
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'amazon_inbound_job',
        entityId: job.id,
        action: AuditAction.update,
        eventType: AuditEventType.AMAZON_INBOUND_JOB_AUTOMATION_UPDATED,
        beforeData: null,
        afterData: summary,
        operatorId,
        requestId,
      });
    });
    return this.loadJobDetailOrThrow(job.id);
  }

  private requireInboundPlanId(job: AmazonJobDetail): string {
    const inboundPlanId = String(job.amazonInboundPlanId || '').trim();
    if (!inboundPlanId) {
      throw new BadRequestException('Amazon inbound plan id is missing, push the job first');
    }
    return inboundPlanId;
  }

  private requireSingleAmazonBoxId(boxes: Array<{ amazonBoxId?: string | null }>): string {
    const boxIds = (Array.isArray(boxes) ? boxes : [])
      .map((box) => String(box.amazonBoxId || '').trim())
      .filter(Boolean);
    if (!boxIds.length) {
      throw new BadRequestException('当前货件缺少 Amazon 箱信息，请先同步货件后再处理箱唛或物流单号。');
    }
    if (boxIds.length > 1) {
      throw new BadRequestException('当前货件存在多个 Amazon 箱，请改为人工处理，不走默认单箱流程。');
    }
    return boxIds[0];
  }

  private async persistAmazonActionFailure(
    job: AmazonJobDetail,
    action: string,
    requestMethod: 'GET' | 'POST',
    requestUrl: string,
    failure: AmazonSpApiFailure,
    operatorId: bigint,
    requestId?: string,
    requestBody?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.amazonInboundJob.update({
        where: { id: job.id },
        data: {
          status: AmazonInboundJobStatus.failed,
          lastError: failure.message,
          lastSyncAt: new Date(),
        },
      });
      await tx.amazonApiLog.create({
        data: {
          connectionId: job.connectionId,
          jobId: job.id,
          action,
          requestMethod,
          requestUrl,
          requestBody: requestBody ? (requestBody as Prisma.InputJsonValue) : undefined,
          responseStatus: failure.responseStatus,
          responseBody: this.normalizeJsonValue(failure.responseBody) as Prisma.InputJsonValue,
          status: AmazonApiLogStatus.failed,
          errorMessage: failure.message,
          createdBy: operatorId,
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'amazon_inbound_job',
        entityId: job.id,
        action: AuditAction.update,
        eventType: AuditEventType.AMAZON_INBOUND_JOB_SYNC_FAILED,
        beforeData: { status: job.status },
        afterData: { status: AmazonInboundJobStatus.failed, action, errorMessage: failure.message },
        operatorId,
        requestId,
      });
    });
  }

  private buildPlacementResponsePayload(
    currentPayload: Prisma.JsonValue | null,
    patch: {
      generatedResponse?: unknown;
      listResponse?: unknown;
      options?: Record<string, unknown>[];
      selectedPlacementOptionId?: string;
      confirmationResponse?: unknown;
    },
  ): Prisma.JsonObject {
    const current = this.asRecord(currentPayload) || {};
    const currentPlacement = this.asRecord(current.placementOptions) || {};
    return {
      ...current,
      placementOptions: {
        ...currentPlacement,
        ...(patch.generatedResponse !== undefined
          ? { generateResponse: this.normalizeJsonValue(patch.generatedResponse), generatedAt: new Date().toISOString() }
          : {}),
        ...(patch.listResponse !== undefined
          ? { listResponse: this.normalizeJsonValue(patch.listResponse), listedAt: new Date().toISOString() }
          : {}),
        ...(patch.options ? { options: this.normalizeJsonValue(patch.options) } : {}),
        ...(patch.selectedPlacementOptionId ? { selectedPlacementOptionId: patch.selectedPlacementOptionId } : {}),
        ...(patch.confirmationResponse !== undefined
          ? { confirmationResponse: this.normalizeJsonValue(patch.confirmationResponse), confirmedAt: new Date().toISOString() }
          : {}),
      },
    };
  }

  private buildPackingResponsePayload(
    currentPayload: Prisma.JsonValue | null,
    patch: {
      generateResponse?: unknown;
      listResponse?: unknown;
      options?: Record<string, unknown>[];
      selectedPackingOptionId?: string;
      confirmationResponse?: unknown;
      packingInformationRequest?: Record<string, unknown>;
      packingInformationResponse?: unknown;
    },
  ): Prisma.JsonObject {
    const current = this.asRecord(currentPayload) || {};
    const currentPacking = this.asRecord(current.packingOptions) || {};
    return {
      ...current,
      packingOptions: {
        ...currentPacking,
        ...(patch.generateResponse !== undefined
          ? { generateResponse: this.normalizeJsonValue(patch.generateResponse), generatedAt: new Date().toISOString() }
          : {}),
        ...(patch.listResponse !== undefined
          ? { listResponse: this.normalizeJsonValue(patch.listResponse), listedAt: new Date().toISOString() }
          : {}),
        ...(patch.options ? { options: this.normalizeJsonValue(patch.options) } : {}),
        ...(patch.selectedPackingOptionId ? { selectedPackingOptionId: patch.selectedPackingOptionId } : {}),
        ...(patch.confirmationResponse !== undefined
          ? { confirmationResponse: this.normalizeJsonValue(patch.confirmationResponse), confirmedAt: new Date().toISOString() }
          : {}),
        ...(patch.packingInformationRequest
          ? { packingInformationRequest: this.normalizeJsonValue(patch.packingInformationRequest) }
          : {}),
        ...(patch.packingInformationResponse !== undefined
          ? {
              packingInformationResponse: this.normalizeJsonValue(patch.packingInformationResponse),
              packingInformationUpdatedAt: new Date().toISOString(),
            }
          : {}),
      },
    };
  }

  private buildTransportationResponsePayload(
    currentPayload: Prisma.JsonValue | null,
    patch: {
      placementOptionId?: string;
      generateRequest?: Record<string, unknown>;
      generateResponse?: unknown;
      listResponse?: unknown;
      options?: Record<string, unknown>[];
      confirmedSelections?: Array<{ shipmentId: string; transportationOptionId: string }>;
      confirmationResponse?: unknown;
    },
  ): Prisma.JsonObject {
    const current = this.asRecord(currentPayload) || {};
    const currentTransportation = this.asRecord(current.transportationOptions) || {};
    return {
      ...current,
      transportationOptions: {
        ...currentTransportation,
        ...(patch.placementOptionId ? { placementOptionId: patch.placementOptionId } : {}),
        ...(patch.generateRequest
          ? { generateRequest: this.normalizeJsonValue(patch.generateRequest), generatedAt: new Date().toISOString() }
          : {}),
        ...(patch.generateResponse !== undefined ? { generateResponse: this.normalizeJsonValue(patch.generateResponse) } : {}),
        ...(patch.listResponse !== undefined
          ? { listResponse: this.normalizeJsonValue(patch.listResponse), listedAt: new Date().toISOString() }
          : {}),
        ...(patch.options ? { options: this.normalizeJsonValue(patch.options) } : {}),
        ...(patch.confirmedSelections
          ? { confirmedSelections: this.normalizeJsonValue(patch.confirmedSelections), confirmedAt: new Date().toISOString() }
          : {}),
        ...(patch.confirmationResponse !== undefined
          ? { confirmationResponse: this.normalizeJsonValue(patch.confirmationResponse) }
          : {}),
      },
    };
  }

  private buildLabelsResponsePayload(
    currentPayload: Prisma.JsonValue | null,
    amazonShipmentId: string,
    patch: {
      request?: Record<string, unknown>;
      response?: unknown;
      downloadUrl?: string | null;
    },
  ): Prisma.JsonObject {
    const current = this.asRecord(currentPayload) || {};
    const currentLabels = this.asRecord(current.labels) || {};
    const currentShipmentLabels = this.asRecord(currentLabels[amazonShipmentId]) || {};
    return {
      ...current,
      labels: this.normalizeJsonValue({
        ...currentLabels,
        [amazonShipmentId]: {
          ...currentShipmentLabels,
          ...(patch.request ? { request: this.normalizeJsonValue(patch.request) } : {}),
          ...(patch.response !== undefined ? { response: this.normalizeJsonValue(patch.response) } : {}),
          ...(patch.downloadUrl !== undefined ? { downloadUrl: patch.downloadUrl } : {}),
          requestedAt: new Date().toISOString(),
        },
      }) as Prisma.JsonValue,
    };
  }

  private buildTrackingResponsePayload(
    currentPayload: Prisma.JsonValue | null,
    amazonShipmentId: string,
    patch: {
      request?: Record<string, unknown>;
      response?: unknown;
    },
  ): Prisma.JsonObject {
    const current = this.asRecord(currentPayload) || {};
    const currentTracking = this.asRecord(current.trackingDetails) || {};
    const currentShipmentTracking = this.asRecord(currentTracking[amazonShipmentId]) || {};
    return {
      ...current,
      trackingDetails: this.normalizeJsonValue({
        ...currentTracking,
        [amazonShipmentId]: {
          ...currentShipmentTracking,
          ...(patch.request ? { request: this.normalizeJsonValue(patch.request) } : {}),
          ...(patch.response !== undefined ? { response: this.normalizeJsonValue(patch.response) } : {}),
          updatedAt: new Date().toISOString(),
        },
      }) as Prisma.JsonValue,
    };
  }

  private buildAutomationResponsePayload(
    currentPayload: Prisma.JsonValue | null,
    summary: Record<string, unknown>,
  ): Prisma.JsonObject {
    const current = this.asRecord(currentPayload) || {};
    return {
      ...current,
      automation: this.normalizeJsonValue({
        ...summary,
        updatedAt: new Date().toISOString(),
      }) as Prisma.JsonValue,
    };
  }

  private normalizePackingInformationPayload(
    job: AmazonJobDetail,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const record = this.asRecord(payload);
    if (!record) {
      throw new BadRequestException('装箱信息必须是 JSON 对象');
    }
    const groupings = Array.isArray(record.packageGroupings) ? record.packageGroupings : [];
    if (!groupings.length) {
      throw new BadRequestException('装箱信息缺少 packageGroupings');
    }
    this.validatePackingInformationAgainstSourceBoxes(job, groupings);
    this.validatePackingInformationAgainstJobItems(job, groupings);
    return record;
  }

  private validatePackingInformationAgainstSourceBoxes(job: AmazonJobDetail, groupings: unknown[]): void {
    const sourceBoxCodes = new Set(
      (Array.isArray(job.items) ? job.items : [])
        .map((item) => String(item?.sourceInventoryBox?.boxCode || '').trim())
        .filter(Boolean),
    );
    if (!sourceBoxCodes.size) return;

    groupings.forEach((group, groupIndex) => {
      const groupRecord = this.asRecord(group);
      const boxes = Array.isArray(groupRecord?.boxes) ? groupRecord.boxes : [];
      boxes.forEach((box, boxIndex) => {
        const boxRecord = this.asRecord(box);
        if (!boxRecord) return;
        const boxId = String(boxRecord.boxId || '').trim();
        const templateName = String(boxRecord.templateName || '').trim();
        if (boxId && sourceBoxCodes.has(boxId)) {
          throw new BadRequestException(
            `第 ${groupIndex + 1} 组第 ${boxIndex + 1} 个箱的 boxId=${boxId} 是来源库存箱号，请填写 FBA 箱标识。`,
          );
        }
        if (templateName && sourceBoxCodes.has(templateName)) {
          throw new BadRequestException(
            `第 ${groupIndex + 1} 组第 ${boxIndex + 1} 个箱的 templateName=${templateName} 是来源库存箱号，请填写 FBA 箱标识。`,
          );
        }
      });
    });
  }

  private validatePackingInformationAgainstJobItems(job: AmazonJobDetail, groupings: unknown[]): void {
    const expected = new Map<string, number>();
    (Array.isArray(job.items) ? job.items : []).forEach((item) => {
      const sku = String(item?.sku?.sku || '').trim();
      const qty = Number(item?.actualQty ?? item?.requestedQty ?? 0) || 0;
      if (!sku || qty <= 0) return;
      expected.set(sku, (expected.get(sku) || 0) + qty);
    });

    const submitted = new Map<string, number>();
    groupings.forEach((group) => {
      const groupRecord = this.asRecord(group);
      const boxes = Array.isArray(groupRecord?.boxes) ? groupRecord.boxes : [];
      boxes.forEach((box) => {
        const boxRecord = this.asRecord(box);
        const items = Array.isArray(boxRecord?.items) ? boxRecord.items : [];
        items.forEach((item) => {
          const itemRecord = this.asRecord(item);
          const sku = String(itemRecord?.msku || itemRecord?.sellerSku || itemRecord?.sku || '').trim();
          const qty = Number(itemRecord?.quantity ?? 0) || 0;
          if (!sku || qty <= 0) return;
          submitted.set(sku, (submitted.get(sku) || 0) + qty);
        });
      });
    });

    if (expected.size !== submitted.size) {
      throw new BadRequestException('出库后箱内 SKU 和数量不可修改，请保持与出库申请一致。');
    }
    for (const [sku, qty] of expected.entries()) {
      if ((submitted.get(sku) || 0) !== qty) {
        throw new BadRequestException(`出库后箱内 SKU 和数量不可修改，SKU ${sku} 当前应为 ${qty}。`);
      }
    }
  }

  private buildGenerateTransportationOptionsPayload(
    job: AmazonJobDetail,
    payload: GenerateTransportationOptionsDto,
  ): Record<string, unknown> {
    const normalizedPlacementOptionId = payload.placementOptionId.trim();
    const derivedShipmentIds = this.extractShipmentIdsForPlacementOption(job.responsePayload, normalizedPlacementOptionId);
    const configurations =
      payload.shipmentConfigurations?.map((item) => ({
        shipmentId: item.shipmentId.trim(),
        readyToShipWindow: {
          start: item.readyToShipWindowStart?.trim() || payload.readyToShipWindowStart?.trim() || new Date().toISOString(),
        },
        ...(item.freightInformation ? { freightInformation: item.freightInformation } : {}),
        ...(Array.isArray(item.pallets) ? { pallets: item.pallets } : {}),
      })) ||
      derivedShipmentIds.map((shipmentId) => ({
        shipmentId,
        readyToShipWindow: {
          start: payload.readyToShipWindowStart?.trim() || new Date().toISOString(),
        },
      }));

    if (!configurations.length) {
      throw new BadRequestException('No shipmentIds found for the selected placement option');
    }

    return {
      placementOptionId: normalizedPlacementOptionId,
      shipmentTransportationConfigurations: configurations,
    };
  }

  private extractOperationId(body: unknown): string | null {
    const record = this.asRecord(body);
    const payloadRecord = this.asRecord(record?.payload) || record;
    return payloadRecord ? this.pickString(payloadRecord, ['operationId']) : null;
  }

  private extractLabelDownloadUrl(body: unknown): string | null {
    const payloadRecord = this.extractPayloadRecord(body);
    if (!payloadRecord) return null;
    return this.pickString(payloadRecord, ['downloadURL', 'downloadUrl', 'labelDownloadUrl', 'labelDownloadURL', 'url']);
  }

  private extractPlacementOptions(body: unknown): Record<string, unknown>[] {
    const payloadRecord = this.extractPayloadRecord(body);
    const options = Array.isArray(payloadRecord?.placementOptions)
      ? payloadRecord.placementOptions
      : Array.isArray(payloadRecord?.options)
        ? payloadRecord.options
        : [];
    return options
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item));
  }

  private extractPackingOptions(body: unknown): Record<string, unknown>[] {
    const payloadRecord = this.extractPayloadRecord(body);
    const options = Array.isArray(payloadRecord?.packingOptions)
      ? payloadRecord.packingOptions
      : Array.isArray(payloadRecord?.options)
        ? payloadRecord.options
        : [];
    return options
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item));
  }

  private extractTransportationOptions(body: unknown): Record<string, unknown>[] {
    const payloadRecord = this.extractPayloadRecord(body);
    const options = Array.isArray(payloadRecord?.transportationOptions)
      ? payloadRecord.transportationOptions
      : Array.isArray(payloadRecord?.options)
        ? payloadRecord.options
        : [];
    return options
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item));
  }

  private extractSelectedPlacementOptionId(value: Prisma.JsonValue | null): string | null {
    const root = this.asRecord(value);
    const placement = this.asRecord(root?.placementOptions);
    return placement ? this.pickString(placement, ['selectedPlacementOptionId']) : null;
  }

  private extractSelectedPackingOptionId(value: Prisma.JsonValue | null): string | null {
    const root = this.asRecord(value);
    const packing = this.asRecord(root?.packingOptions);
    return packing ? this.pickString(packing, ['selectedPackingOptionId']) : null;
  }

  private extractShipmentIdsForPlacementOption(
    value: Prisma.JsonValue | null,
    placementOptionId: string,
  ): string[] {
    const root = this.asRecord(value);
    const placement = this.asRecord(root?.placementOptions);
    const options = Array.isArray(placement?.options) ? placement.options : [];
    const matched = options
      .map((item) => this.asRecord(item))
      .find((item) => this.pickString(item || {}, ['placementOptionId', 'placementId']) === placementOptionId);
    if (!matched) return [];
    const shipmentIds =
      Array.isArray(matched.shipmentIds)
        ? matched.shipmentIds
        : Array.isArray(matched.shipments)
          ? matched.shipments.map((item) => this.pickString(this.asRecord(item) || {}, ['shipmentId']))
          : [];
    return shipmentIds
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }

  private extractPayloadRecord(body: unknown): Record<string, unknown> | null {
    const record = this.asRecord(body);
    return this.asRecord(record?.payload) || record;
  }

  private extractShipmentSnapshot(
    body: unknown,
  ): {
    amazonShipmentId: string;
    shipmentConfirmationId: string | null;
    shipmentName: string | null;
    destinationCode: string | null;
    status: string;
    body: unknown;
  } | null {
    const payloadRecord = this.extractPayloadRecord(body);
    if (!payloadRecord) return null;
    const amazonShipmentId = this.pickString(payloadRecord, ['shipmentId']) || this.pickString(payloadRecord, ['amazonShipmentId']);
    if (!amazonShipmentId) return null;
    return {
      amazonShipmentId,
      shipmentConfirmationId: this.pickString(payloadRecord, ['shipmentConfirmationId', 'shipmentConfirmationID']),
      shipmentName: this.pickString(payloadRecord, ['shipmentName', 'name']),
      destinationCode: this.pickString(payloadRecord, ['destinationWarehouseId', 'destinationCode']),
      status: this.pickString(payloadRecord, ['status', 'shipmentStatus']) || 'UNKNOWN',
      body,
    };
  }

  private extractShipmentBoxes(
    body: unknown,
  ): Array<{
    amazonBoxId: string;
    boxSequence: number | null;
    templateName: string | null;
    contentSource: string | null;
    quantity: number | null;
    status: string | null;
    items: Array<{
      msku: string | null;
      fnsku: string | null;
      asin: string | null;
      quantity: number | null;
      body: unknown;
    }>;
    body: unknown;
  }> {
    const payloadRecord = this.extractPayloadRecord(body);
    const boxes = Array.isArray(payloadRecord?.boxes)
      ? payloadRecord.boxes
      : Array.isArray(payloadRecord?.packages)
        ? payloadRecord.packages
        : [];
    return boxes
      .map((item) => {
        const record = this.asRecord(item);
        if (!record) return null;
        const amazonBoxId =
          this.pickString(record, ['boxId', 'packageId', 'shipmentBoxId']) || '';
        if (!amazonBoxId) return null;
        const sequenceRaw = record.boxSequence ?? record.sequenceNumber ?? null;
        const quantityRaw = record.quantity ?? record.packageCount ?? null;
        return {
          amazonBoxId,
          boxSequence:
            typeof sequenceRaw === 'number'
              ? sequenceRaw
              : typeof sequenceRaw === 'string' && sequenceRaw.trim()
                ? Number(sequenceRaw)
                : null,
          templateName: this.pickString(record, ['templateName', 'packageTemplateName']),
          contentSource: this.pickString(record, ['contentInformationSource', 'contentSource']),
          quantity:
            typeof quantityRaw === 'number'
              ? quantityRaw
              : typeof quantityRaw === 'string' && quantityRaw.trim()
                ? Number(quantityRaw)
                : null,
          status: this.pickString(record, ['status']),
          items: this.extractShipmentBoxItems(item),
          body: item,
        };
      })
      .filter(
        (
          item,
        ): item is {
          amazonBoxId: string;
          boxSequence: number | null;
          templateName: string | null;
          contentSource: string | null;
          quantity: number | null;
          status: string | null;
          items: Array<{
            msku: string | null;
            fnsku: string | null;
            asin: string | null;
            quantity: number | null;
            body: unknown;
          }>;
          body: unknown;
        } => Boolean(item),
      );
  }

  private extractShipmentBoxItems(
    body: unknown,
  ): Array<{
    msku: string | null;
    fnsku: string | null;
    asin: string | null;
    quantity: number | null;
    body: unknown;
  }> {
    const record = this.extractPayloadRecord(body) || this.asRecord(body);
    const rawItems = Array.isArray(record?.items)
      ? record.items
      : Array.isArray(record?.packageContents)
        ? record.packageContents
        : Array.isArray(record?.contents)
          ? record.contents
          : Array.isArray(record?.boxContents)
            ? record.boxContents
            : Array.isArray(record?.products)
              ? record.products
              : [];
    return rawItems
      .map((item) => {
        const itemRecord = this.asRecord(item);
        if (!itemRecord) return null;
        const quantityRaw =
          itemRecord.quantity ?? itemRecord.qty ?? itemRecord.unitQuantity ?? itemRecord.quantityShipped ?? null;
        const parsed = {
          msku: this.pickString(itemRecord, ['msku', 'sellerSku', 'merchantSku', 'sku']),
          fnsku: this.pickString(itemRecord, ['fnsku']),
          asin: this.pickString(itemRecord, ['asin']),
          quantity:
            typeof quantityRaw === 'number'
              ? quantityRaw
              : typeof quantityRaw === 'string' && quantityRaw.trim()
                ? Number(quantityRaw)
                : null,
          body: item,
        };
        if (!parsed.msku && !parsed.fnsku && !parsed.asin) {
          return null;
        }
        return parsed;
      })
      .filter(
        (
          item,
        ): item is {
          msku: string | null;
          fnsku: string | null;
          asin: string | null;
          quantity: number | null;
          body: unknown;
        } => Boolean(item),
      );
  }

  private async fetchShipmentSnapshotsForJob(
    job: AmazonJobDetail,
    authConfig: AmazonConnectionAuthConfig,
  ): Promise<
    Array<{
      amazonShipmentId: string;
      shipmentConfirmationId: string | null;
      shipmentName: string | null;
      destinationCode: string | null;
      status: string;
      body: unknown;
      responseStatus: number;
      boxesResponseStatus: number;
      boxes: Array<{
        amazonBoxId: string;
        boxSequence: number | null;
        templateName: string | null;
        contentSource: string | null;
        quantity: number | null;
        status: string | null;
        items: Array<{
          msku: string | null;
          fnsku: string | null;
          asin: string | null;
          quantity: number | null;
          body: unknown;
        }>;
        body: unknown;
      }>;
    }>
  > {
    const inboundPlanId = String(job.amazonInboundPlanId || '').trim();
    if (!inboundPlanId) return [];

    const selectedPlacementOptionId = this.extractSelectedPlacementOptionId(job.responsePayload);
    const shipmentIds = [
      ...new Set([
        ...(selectedPlacementOptionId
          ? this.extractShipmentIdsForPlacementOption(job.responsePayload, selectedPlacementOptionId)
          : []),
        ...job.shipments.map((item) => item.amazonShipmentId),
      ]),
    ];
    if (!shipmentIds.length) return [];

    const results: Array<{
      amazonShipmentId: string;
      shipmentConfirmationId: string | null;
      shipmentName: string | null;
      destinationCode: string | null;
      status: string;
      body: unknown;
      responseStatus: number;
      boxesResponseStatus: number;
      boxes: Array<{
        amazonBoxId: string;
        boxSequence: number | null;
        templateName: string | null;
        contentSource: string | null;
        quantity: number | null;
        status: string | null;
        items: Array<{
          msku: string | null;
          fnsku: string | null;
          asin: string | null;
          quantity: number | null;
          body: unknown;
        }>;
        body: unknown;
      }>;
    }> = [];
    for (const shipmentId of shipmentIds) {
      const response = await this.amazonSpApiService.getShipment(
        job.connection.region,
        authConfig,
        inboundPlanId,
        shipmentId,
      );
      const snapshot = this.extractShipmentSnapshot(response.body);
      if (snapshot) {
        const boxesResponse = await this.amazonSpApiService.listShipmentBoxes(
          job.connection.region,
          authConfig,
          inboundPlanId,
          shipmentId,
        );
        results.push({
          ...snapshot,
          responseStatus: response.status,
          boxesResponseStatus: boxesResponse.status,
          boxes: this.extractShipmentBoxes(boxesResponse.body),
        });
      }
    }
    return results;
  }

  private async persistPushFailure(
    job: AmazonJobDetail,
    requestBody: Record<string, unknown>,
    failure: AmazonSpApiFailure,
    operatorId: bigint,
    requestId?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.amazonInboundJob.update({
        where: { id: job.id },
        data: {
          status: AmazonInboundJobStatus.failed,
          requestPayload: { ...(this.asRecord(job.requestPayload) || {}), amazonRequest: requestBody } as Prisma.InputJsonValue,
          lastError: failure.message,
          lastSyncAt: new Date(),
        },
      });
      await tx.amazonApiLog.create({
        data: {
          connectionId: job.connectionId,
          jobId: job.id,
          action: 'create_inbound_plan',
          requestMethod: 'POST',
          requestUrl: '/inbound/fba/2024-03-20/inboundPlans',
          requestBody: requestBody as Prisma.InputJsonValue,
          responseStatus: failure.responseStatus,
          responseBody: this.normalizeJsonValue(failure.responseBody) as Prisma.InputJsonValue,
          status: AmazonApiLogStatus.failed,
          errorMessage: failure.message,
          createdBy: operatorId,
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'amazon_inbound_job',
        entityId: job.id,
        action: AuditAction.update,
        eventType: AuditEventType.AMAZON_INBOUND_JOB_PUSH_FAILED,
        beforeData: { status: job.status },
        afterData: { status: AmazonInboundJobStatus.failed, errorMessage: failure.message },
        operatorId,
        requestId,
      });
    });
  }

  private normalizePushError(error: unknown): AmazonSpApiFailure {
    if (error instanceof AmazonSpApiRequestError) {
      const message = `${error.message} (HTTP ${error.status})`;
      return { error: new BadRequestException(message), message, responseStatus: error.status, responseBody: error.body };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { error: new BadRequestException(message), message, responseStatus: null, responseBody: null };
  }

  private extractPlanResponse(body: unknown): { amazonInboundPlanId: string | null; operationId: string | null } {
    const record = this.asRecord(body);
    const payloadRecord = this.asRecord(record?.payload) || record;
    if (!payloadRecord) return { amazonInboundPlanId: null, operationId: null };
    return {
      amazonInboundPlanId: this.pickString(payloadRecord, ['inboundPlanId']),
      operationId: this.pickString(payloadRecord, ['operationId']),
    };
  }

  private extractOperationStatus(body: unknown): string {
    const record = this.asRecord(body);
    const payloadRecord = this.asRecord(record?.payload) || record;
    return payloadRecord ? this.pickString(payloadRecord, ['operationStatus', 'status']) || 'UNKNOWN' : 'UNKNOWN';
  }

  private buildCreateInboundPlanPayload(job: AmazonJobDetail, authConfig: AmazonConnectionAuthConfig): Record<string, unknown> & { amazonRequest: Record<string, unknown> } {
    if (job.items.length === 0) throw new UnprocessableEntityException('Amazon FBA job has no items');
    const amazonRequest = {
      destinationMarketplaces: authConfig.destinationMarketplaces?.length ? authConfig.destinationMarketplaces : [job.connection.marketplaceId],
      name: job.jobNo,
      sourceAddress: authConfig.shipFromAddress,
      items: job.items.map((item) => ({
        msku: item.sku.sku,
        labelOwner: authConfig.labelOwner ?? 'SELLER',
        prepOwner: authConfig.prepOwner ?? 'SELLER',
        itemQuantity: item.actualQty ?? item.requestedQty,
      })),
    };
    return {
      workflow: 'send_to_amazon',
      step: 'create_inbound_plan',
      generatedAt: new Date().toISOString(),
      job: { id: job.id.toString(), jobNo: job.jobNo, status: job.status, sourceType: job.sourceType },
      connection: {
        id: job.connection.id.toString(),
        name: job.connection.name,
        marketplaceId: job.connection.marketplaceId,
        region: job.connection.region,
        sellerId: job.connection.sellerId,
      },
      items: job.items.map((rawItem) => {
        const item = rawItem as typeof rawItem & {
          fbaCartonRef: string;
          sourceInventoryBoxId: bigint;
          sourceInventoryBox: { boxCode: string; shelf?: { shelfCode?: string | null } | null };
        };
        return {
          jobItemId: item.id.toString(),
          fbaReplenishmentId: item.fbaReplenishmentId.toString(),
          requestNo: item.fbaReplenishment.requestNo,
          fbaCartonRef: item.fbaCartonRef,
          skuId: item.skuId.toString(),
          sku: item.sku.sku,
          rbSku: item.sku.rbSku,
          asin: item.sku.asin,
          fnsku: item.sku.fnsku,
          fbmSku: item.sku.fbmSku,
          model: item.sku.model,
          brand: item.sku.brand,
          type: item.sku.type,
          color: item.sku.color,
          shop: item.sku.shop,
          sourceInventoryBoxId: item.sourceInventoryBoxId.toString(),
          sourceInventoryBoxCode: item.sourceInventoryBox.boxCode,
          sourceInventoryShelfCode: item.sourceInventoryBox.shelf?.shelfCode ?? null,
          requestedQty: item.requestedQty,
          actualQty: item.actualQty ?? item.requestedQty,
        };
      }),
      amazonRequest,
    };
  }

  private normalizeAuthConfig(
    value: Prisma.JsonValue | Record<string, unknown> | undefined,
    fallbackMarketplaceId: string,
    options: { requireRefreshToken?: boolean } = {},
  ): AmazonConnectionAuthConfig {
    const record = this.asRecord(value);
    if (!record) throw new BadRequestException('Amazon authConfig is required');

    const clientId = String(record.clientId || '').trim();
    const clientSecret = String(record.clientSecret || '').trim();
    const refreshToken = String(record.refreshToken || '').trim();
    const shipFromAddress = this.normalizeShipFromAddress(record.shipFromAddress);
    if (!clientId || !clientSecret) {
      throw new BadRequestException('Amazon authConfig is missing clientId/clientSecret');
    }
    if ((options.requireRefreshToken ?? true) && !refreshToken) {
      throw new BadRequestException('Amazon authConfig is missing refreshToken');
    }

    const destinationMarketplaces = Array.isArray(record.destinationMarketplaces)
      ? record.destinationMarketplaces.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean)
      : [fallbackMarketplaceId];
    const applicationId =
      typeof record.applicationId === 'string' && record.applicationId.trim()
        ? record.applicationId.trim()
        : undefined;
    const sellerCentralUrl = this.normalizeOptionalUrl(record.sellerCentralUrl);
    const authorizationVersion = record.authorizationVersion === 'beta' ? 'beta' : 'published';
    const oauthState =
      typeof record.oauthState === 'string' && record.oauthState.trim()
        ? record.oauthState.trim()
        : undefined;
    const oauthStateExpiresAt =
      typeof record.oauthStateExpiresAt === 'string' && record.oauthStateExpiresAt.trim()
        ? record.oauthStateExpiresAt.trim()
        : undefined;
    const oauthLastAuthorizedAt =
      typeof record.oauthLastAuthorizedAt === 'string' && record.oauthLastAuthorizedAt.trim()
        ? record.oauthLastAuthorizedAt.trim()
        : undefined;
    const oauthLastError =
      typeof record.oauthLastError === 'string' && record.oauthLastError.trim()
        ? record.oauthLastError.trim()
        : undefined;
    const oauthSellingPartnerId =
      typeof record.oauthSellingPartnerId === 'string' && record.oauthSellingPartnerId.trim()
        ? record.oauthSellingPartnerId.trim()
        : undefined;

    const result: AmazonConnectionAuthConfig = {
      clientId,
      clientSecret,
      shipFromAddress,
      destinationMarketplaces: destinationMarketplaces.length ? destinationMarketplaces : [fallbackMarketplaceId],
      labelOwner: record.labelOwner === 'AMAZON' ? 'AMAZON' : 'SELLER',
      prepOwner: record.prepOwner === 'AMAZON' ? 'AMAZON' : 'SELLER',
      appName: typeof record.appName === 'string' ? record.appName : undefined,
      appVersion: typeof record.appVersion === 'string' ? record.appVersion : undefined,
      authorizationVersion,
    };
    if (refreshToken) result.refreshToken = refreshToken;
    if (applicationId) result.applicationId = applicationId;
    if (sellerCentralUrl) result.sellerCentralUrl = sellerCentralUrl;
    if (oauthState) result.oauthState = oauthState;
    if (oauthStateExpiresAt) result.oauthStateExpiresAt = oauthStateExpiresAt;
    if (oauthLastAuthorizedAt) result.oauthLastAuthorizedAt = oauthLastAuthorizedAt;
    if (oauthLastError) result.oauthLastError = oauthLastError;
    if (oauthSellingPartnerId) result.oauthSellingPartnerId = oauthSellingPartnerId;
    return result;
  }

  private normalizeShipFromAddress(value: unknown): AmazonConnectionAuthConfig['shipFromAddress'] {
    const record = this.asRecord(value);
    if (!record) throw new BadRequestException('Amazon authConfig.shipFromAddress is required');

    const name = String(record.name || '').trim();
    const addressLine1 = String(record.addressLine1 || '').trim();
    const city = String(record.city || '').trim();
    const countryCode = String(record.countryCode || '').trim().toUpperCase();
    const postalCode = String(record.postalCode || '').trim();
    const phoneNumber = String(record.phoneNumber || '').trim();
    if (!name || !addressLine1 || !city || !countryCode || !postalCode || !phoneNumber) {
      throw new BadRequestException('Amazon authConfig.shipFromAddress is missing required address fields');
    }

    const result: AmazonConnectionAuthConfig['shipFromAddress'] = {
      name,
      addressLine1,
      city,
      countryCode,
      postalCode,
      phoneNumber,
    };
    if (typeof record.addressLine2 === 'string' && record.addressLine2.trim()) result.addressLine2 = record.addressLine2.trim();
    if (typeof record.stateOrProvinceCode === 'string' && record.stateOrProvinceCode.trim()) result.stateOrProvinceCode = record.stateOrProvinceCode.trim();
    if (typeof record.districtOrCounty === 'string' && record.districtOrCounty.trim()) result.districtOrCounty = record.districtOrCounty.trim();
    if (typeof record.companyName === 'string' && record.companyName.trim()) result.companyName = record.companyName.trim();
    return result;
  }

  private normalizeRegion(region: string): string {
    const value = String(region || '').trim().toLowerCase();
    if (!['na', 'eu', 'fe'].includes(value)) throw new BadRequestException('Amazon region must be one of: na, eu, fe');
    return value;
  }

  private buildStoredAuthConfig(authConfig: AmazonConnectionAuthConfig): Record<string, unknown> {
    const result: Record<string, unknown> = {
      clientId: authConfig.clientId,
      clientSecret: authConfig.clientSecret,
      shipFromAddress: authConfig.shipFromAddress,
      destinationMarketplaces: authConfig.destinationMarketplaces?.length
        ? authConfig.destinationMarketplaces
        : undefined,
      labelOwner: authConfig.labelOwner === 'AMAZON' ? 'AMAZON' : 'SELLER',
      prepOwner: authConfig.prepOwner === 'AMAZON' ? 'AMAZON' : 'SELLER',
      authorizationVersion: authConfig.authorizationVersion === 'beta' ? 'beta' : 'published',
    };
    if (authConfig.refreshToken) result.refreshToken = authConfig.refreshToken;
    if (authConfig.appName) result.appName = authConfig.appName;
    if (authConfig.appVersion) result.appVersion = authConfig.appVersion;
    if (authConfig.applicationId) result.applicationId = authConfig.applicationId;
    if (authConfig.sellerCentralUrl) result.sellerCentralUrl = authConfig.sellerCentralUrl;
    if (authConfig.oauthState) result.oauthState = authConfig.oauthState;
    if (authConfig.oauthStateExpiresAt) result.oauthStateExpiresAt = authConfig.oauthStateExpiresAt;
    if (authConfig.oauthLastAuthorizedAt) result.oauthLastAuthorizedAt = authConfig.oauthLastAuthorizedAt;
    if (authConfig.oauthLastError) result.oauthLastError = authConfig.oauthLastError;
    if (authConfig.oauthSellingPartnerId) result.oauthSellingPartnerId = authConfig.oauthSellingPartnerId;
    return result;
  }

  private normalizePublicOrigin(origin: string | undefined): string {
    const value = String(origin || '').trim();
    if (!value) throw new BadRequestException('Public origin is required');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('Public origin is invalid');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new BadRequestException('Public origin must use http or https');
    }
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  }

  private buildAmazonOauthUris(origin: string): { loginUri: string; redirectUri: string } {
    return {
      loginUri: `${origin}/amazon-oauth-login.html`,
      redirectUri: `${origin}/amazon-oauth-callback.html`,
    };
  }

  private buildAmazonAuthorizationUrl(region: string, authConfig: AmazonConnectionAuthConfig, state: string): string {
    const baseUrl = authConfig.sellerCentralUrl || this.resolveDefaultSellerCentralUrl(region);
    const url = new URL('/apps/authorize/consent', baseUrl);
    url.searchParams.set('application_id', String(authConfig.applicationId || '').trim());
    url.searchParams.set('state', state);
    if (authConfig.authorizationVersion === 'beta') {
      url.searchParams.set('version', 'beta');
    }
    return url.toString();
  }

  private resolveDefaultSellerCentralUrl(region: string): string {
    const normalized = this.normalizeRegion(region);
    if (normalized === 'eu') return 'https://sellercentral-europe.amazon.com';
    if (normalized === 'fe') return 'https://sellercentral.amazon.co.jp';
    return 'https://sellercentral.amazon.com';
  }

  private async loadJobDetailOrThrow(id: bigint): Promise<AmazonJobDetail> {
    const job = await this.loadJobDetail(id);
    if (!job) throw new NotFoundException('Amazon FBA job not found');
    return job;
  }

  private async loadJobDetail(id: bigint): Promise<AmazonJobDetail | null> {
    const job = (await (this.prisma.amazonInboundJob as any).findUnique({
      where: { id },
      include: {
        connection: true,
        creator: { select: { id: true, username: true } },
        pusher: { select: { id: true, username: true } },
        items: {
          include: {
            sku: { select: { id: true, sku: true, rbSku: true, asin: true, fnsku: true, fbmSku: true, model: true, brand: true, type: true, color: true, shop: true } },
            sourceInventoryBox: { select: { id: true, boxCode: true, shelf: { select: { shelfCode: true, name: true } } } },
            fbaReplenishment: { select: { id: true, requestNo: true, status: true, requestedQty: true, actualQty: true, expressNo: true, remark: true, createdAt: true } },
          },
          orderBy: { id: 'asc' },
        },
        shipments: {
          orderBy: { id: 'asc' },
        },
      },
    })) as (Prisma.AmazonInboundJobGetPayload<{
      include: {
        connection: true;
        creator: { select: { id: true; username: true } };
        pusher: { select: { id: true; username: true } };
        items: {
          include: {
            sku: { select: { id: true; sku: true; rbSku: true; asin: true; fnsku: true; fbmSku: true; model: true; brand: true; type: true; color: true; shop: true } };
            sourceInventoryBox: { select: { id: true; boxCode: true; shelf: { select: { shelfCode: true; name: true } } } };
            fbaReplenishment: { select: { id: true; requestNo: true; status: true; requestedQty: true; actualQty: true; expressNo: true; remark: true; createdAt: true } };
          };
        };
        shipments: true;
      };
    }> | null);
    if (!job) return null;

    const shipmentIds = job.shipments.map((item) => item.id);
    const boxes = shipmentIds.length
      ? await (this.prisma as PrismaService & { amazonInboundBox: any }).amazonInboundBox.findMany({
          where: { shipmentId: { in: shipmentIds } },
          orderBy: [{ shipmentId: 'asc' }, { id: 'asc' }],
        })
      : [];
    const boxIds = boxes.map((item: { id: bigint }) => item.id);
    const boxItems = boxIds.length
      ? await (this.prisma as PrismaService & { amazonInboundBoxItem: any }).amazonInboundBoxItem.findMany({
          where: { boxId: { in: boxIds } },
          orderBy: [{ boxId: 'asc' }, { id: 'asc' }],
        })
      : [];
    const boxItemsByBoxId = new Map<string, unknown[]>();
    for (const item of boxItems) {
      const key = String(item.boxId);
      const list = boxItemsByBoxId.get(key) || [];
      list.push(item);
      boxItemsByBoxId.set(key, list);
    }
    const boxesByShipmentId = new Map<string, unknown[]>();
    for (const box of boxes) {
      const key = String(box.shipmentId);
      const list = boxesByShipmentId.get(key) || [];
      list.push({
        ...box,
        items: boxItemsByBoxId.get(String(box.id)) || [],
      });
      boxesByShipmentId.set(key, list);
    }

    return {
      ...job,
      shipments: job.shipments.map((shipment) => ({
        ...shipment,
        boxes: boxesByShipmentId.get(String(shipment.id)) || [],
      })),
    } as AmazonJobDetail;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private normalizeOptionalUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    try {
      const url = new URL(value.trim());
      return url.toString().replace(/\/$/, '');
    } catch {
      throw new BadRequestException('Amazon authConfig.sellerCentralUrl is invalid');
    }
  }

  private pickString(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  private normalizeJsonValue(value: unknown): Prisma.JsonValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map((item) => this.normalizeJsonValue(item));
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, this.normalizeJsonValue(item)]),
      ) as Prisma.JsonObject;
    }
    return String(value);
  }
}
