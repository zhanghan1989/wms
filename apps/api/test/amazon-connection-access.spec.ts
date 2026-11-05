import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { AmazonSpApiController } from '../src/amazon-sp-api/amazon-sp-api.controller';
import { AmazonSpApiService } from '../src/amazon-sp-api/amazon-sp-api.service';

describe('Amazon connection access', () => {
  let app: INestApplication;
  let user: any;
  const service = Object.fromEntries([
    'listConnections', 'startOAuth', 'continueAppstoreOAuth', 'updateConnection',
    'testConnection', 'enqueueConnectionSync', 'listSyncRuns', 'getCoverage', 'enqueueAllConnectionsSync',
  ].map(name => [name, jest.fn().mockResolvedValue({ success: true })]));

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AmazonSpApiController],
      providers: [{ provide: AmazonSpApiService, useValue: service }],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate: (context: ExecutionContext) => {
      context.switchToHttp().getRequest().user = user;
      return !!user;
    } }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { jest.clearAllMocks(); });

  const routes = [
    ['get', '/amazon-sp-api/connections', 'listConnections'],
    ['post', '/amazon-sp-api/oauth/start', 'startOAuth'],
    ['post', '/amazon-sp-api/oauth/appstore/continue', 'continueAppstoreOAuth'],
    ['put', '/amazon-sp-api/connections/7', 'updateConnection'],
    ['post', '/amazon-sp-api/connections/7/test', 'testConnection'],
    ['post', '/amazon-sp-api/connections/7/sync', 'enqueueConnectionSync'],
    ['get', '/amazon-sp-api/sync-runs?connectionId=7', 'listSyncRuns'],
  ] as const;

  it.each(['employee', 'admin', 'system_admin'])('allows Chinese company %s to manage connections', async role => {
    user = { id: 5n, role, companyId: 2n, department: 'china_warehouse' };
    for (const [method, url, handler] of routes) {
      const response = await request(app.getHttpServer())[method](url).send({ shopId: '7' });
      expect(response.status).toBeLessThan(300);
      expect(service[handler]).toHaveBeenCalledTimes(1);
    }
  });

  it('retains warehouse employee restrictions', async () => {
    user = { id: 5n, role: 'employee', companyId: null, department: 'overseas_warehouse' };
    for (const [method, url, handler] of routes) {
      await request(app.getHttpServer())[method](url).send({}).expect(403);
      expect(service[handler]).not.toHaveBeenCalled();
    }
  });

  it('keeps global synchronization and coverage restricted for Chinese employees', async () => {
    user = { id: 5n, username: 'employee', role: 'employee', companyId: 2n };
    await request(app.getHttpServer()).post('/amazon-sp-api/sync-all').send({}).expect(403);
    await request(app.getHttpServer()).get('/amazon-sp-api/coverage').expect(403);
    expect(service.enqueueAllConnectionsSync).not.toHaveBeenCalled();
    expect(service.getCoverage).not.toHaveBeenCalled();
  });
});
