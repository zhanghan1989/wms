import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';

describe('revocable sessions and privilege boundaries', () => {
  const previousSecret = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = 'test-session-signing-secret'; });
  afterAll(() => { if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret; });

  function fixture() {
    const users: any[] = [
      { id: 1n, username: 'root', role: 'system_admin', status: 1, sessionVersion: 0 },
      { id: 2n, username: 'manager', role: 'admin', department: 'china_warehouse', status: 1, sessionVersion: 0, passwordHash: 'hash' },
      { id: 3n, username: 'employee', role: 'employee', department: 'factory', status: 1, sessionVersion: 0 },
    ];
    let session: any = { id: 'session-1', user: users[1], expiresAt: new Date(Date.now() + 60000) };
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      user: {
        findUnique: jest.fn(async ({ where }) => users.find(u => u.id === where.id) ?? null),
        update: jest.fn(async ({ where, data }) => Object.assign(users.find(u => u.id === where.id), data)),
        create: jest.fn(async ({ data }) => ({ id: 4n, ...data })),
      },
      authSession: {
        findUnique: jest.fn(async () => session),
        deleteMany: jest.fn(async () => { session = null; return { count: 1 }; }),
      },
    };
    tx.$transaction = async (work: any) => work(tx);
    const options = { assertRoleEnabled: jest.fn(), assertDepartmentEnabled: jest.fn() };
    return { users, tx, strategy: new JwtStrategy(tx), service: new UsersService(tx, { create: jest.fn() } as any, options as any) };
  }

  it('rejects legacy tokens with no server session', async () => {
    const { strategy } = fixture();
    await expect(strategy.validate({ sub: '2' })).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('uses the current role and rejects disabled users and revoked versions', async () => {
    const { strategy, users } = fixture();
    const payload = { sub: '2', jti: 'session-1', sessionVersion: 0 };
    users[1].role = 'employee';
    expect((await strategy.validate(payload)).role).toBe('employee');
    users[1].status = 0;
    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
    users[1].status = 1; users[1].sessionVersion = 1;
    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('logout removes only the current session and makes it unusable', async () => {
    const { tx, strategy } = fixture();
    const service = new AuthService(tx, {} as any, {} as any, {} as any);
    await service.logout(2n, 'session-1');
    expect(tx.authSession.deleteMany).toHaveBeenCalledWith({ where: { id: 'session-1', userId: 2n } });
    await expect(strategy.validate({ sub: '2', jti: 'session-1', sessionVersion: 0 })).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it.each([{ role: 'system_admin' }, { department: 'factory' }])('rejects admin self-escalation %j', async (payload) => {
    const { service, tx } = fixture();
    await expect(service.update('2', payload as any, 2n)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
  it('rejects admin granting admin to an employee', async () => {
    const { service, tx } = fixture();
    await expect(service.update('3', { role: 'admin' }, 2n)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
  it('rejects resetting another system administrator password', async () => {
    const { service, tx } = fixture();
    await expect(service.resetPassword('1', 'ValidPassword@123', 2n)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
  it('allows the system administrator to grant permissions and invalidates old sessions', async () => {
    const { service, tx } = fixture();
    await service.update('3', { role: 'admin' }, 1n);
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: 'admin', sessionVersion: { increment: 1 } }),
    }));
  });
  it('allows an admin to manage ordinary employee accounts', async () => {
    const { service, tx } = fixture();
    await service.update('3', { status: 0 }, 2n);
    expect(tx.user.update).toHaveBeenCalled();
  });
});
