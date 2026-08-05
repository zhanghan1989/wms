import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

export interface EncryptedMfaSecret {
  encryptedValue: string;
  iv: string;
  authTag: string;
}

@Injectable()
export class AuthMfaService {
  generateSecret(): string {
    return this.base32Encode(randomBytes(20));
  }

  buildOtpAuthUri(username: string, secret: string): string {
    const issuer = 'Fulangke WMS';
    const label = `${issuer}:${String(username ?? '').trim()}`;
    const url = new URL(`otpauth://totp/${encodeURIComponent(label)}`);
    url.searchParams.set('secret', secret);
    url.searchParams.set('issuer', issuer);
    url.searchParams.set('algorithm', 'SHA1');
    url.searchParams.set('digits', String(TOTP_DIGITS));
    url.searchParams.set('period', String(TOTP_PERIOD_SECONDS));
    return url.toString();
  }

  encrypt(secret: string): EncryptedMfaSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return {
      encryptedValue: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  decrypt(credential: EncryptedMfaSecret): string {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.getEncryptionKey(),
        Buffer.from(credential.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(credential.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(credential.encryptedValue, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new BadRequestException('MFA配置无法解密，请由管理员重置');
    }
  }

  verify(secret: string, code: string, nowMs = Date.now()): boolean {
    const normalizedCode = String(code ?? '').trim();
    if (!/^\d{6}$/.test(normalizedCode)) return false;
    const counter = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
    for (const offset of [-1, 0, 1]) {
      const expected = this.generateCode(secret, counter + offset);
      if (timingSafeEqual(Buffer.from(expected), Buffer.from(normalizedCode))) return true;
    }
    return false;
  }

  private generateCode(secret: string, counter: number): string {
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac('sha1', this.base32Decode(secret)).update(counterBuffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary =
      ((digest[offset] & 0x7f) << 24)
      | ((digest[offset + 1] & 0xff) << 16)
      | ((digest[offset + 2] & 0xff) << 8)
      | (digest[offset + 3] & 0xff);
    return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
  }

  private base32Encode(input: Buffer): string {
    let bits = '';
    for (const byte of input) bits += byte.toString(2).padStart(8, '0');
    let output = '';
    for (let index = 0; index < bits.length; index += 5) {
      output += BASE32_ALPHABET[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
    }
    return output;
  }

  private base32Decode(value: string): Buffer {
    const normalized = String(value ?? '').toUpperCase().replace(/=+$/g, '');
    let bits = '';
    for (const character of normalized) {
      const index = BASE32_ALPHABET.indexOf(character);
      if (index < 0) throw new BadRequestException('MFA密钥格式无效');
      bits += index.toString(2).padStart(5, '0');
    }
    const bytes: number[] = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) {
      bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
    }
    return Buffer.from(bytes);
  }

  private getEncryptionKey(): Buffer {
    const configured = String(process.env.AUTH_MFA_ENCRYPTION_KEY ?? '').trim();
    const key = /^[0-9a-f]{64}$/i.test(configured)
      ? Buffer.from(configured, 'hex')
      : Buffer.from(configured, 'base64');
    if (key.length !== 32) {
      throw new ServiceUnavailableException('请配置32字节的 AUTH_MFA_ENCRYPTION_KEY');
    }
    return key;
  }
}
