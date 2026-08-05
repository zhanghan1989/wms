import { randomBytes } from 'crypto';
import { AuthMfaService } from '../src/auth/auth-mfa.service';

describe('AuthMfaService', () => {
  const originalKey = process.env.AUTH_MFA_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.AUTH_MFA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.AUTH_MFA_ENCRYPTION_KEY;
    else process.env.AUTH_MFA_ENCRYPTION_KEY = originalKey;
  });

  it('verifies the RFC 6238 SHA1 vector using six digits and a narrow time window', () => {
    const service = new AuthMfaService();
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(service.verify(secret, '287082', 59_000)).toBe(true);
    expect(service.verify(secret, '287083', 59_000)).toBe(false);
  });

  it('encrypts MFA secrets with authenticated encryption', () => {
    const service = new AuthMfaService();
    const secret = service.generateSecret();
    const encrypted = service.encrypt(secret);
    expect(encrypted.encryptedValue).not.toContain(secret);
    expect(service.decrypt(encrypted)).toBe(secret);
  });

  it('builds a standard authenticator URI', () => {
    const service = new AuthMfaService();
    const uri = new URL(service.buildOtpAuthUri('admin', 'JBSWY3DPEHPK3PXP'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('issuer')).toBe('Fulangke WMS');
    expect(uri.searchParams.get('digits')).toBe('6');
  });
});
