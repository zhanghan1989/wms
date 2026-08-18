import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export interface EncryptedRakutenCredential {
  encryptedValue: string;
  iv: string;
  authTag: string;
}

@Injectable()
export class RakutenRmsApiCryptoService {
  encrypt(value: string): EncryptedRakutenCredential {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      encryptedValue: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  decrypt(encryptedValue: string, iv: string, authTag: string): string {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.getEncryptionKey(), Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new InternalServerErrorException('乐天 RMS API 凭证无法解密，请检查加密密钥配置');
    }
  }

  private getEncryptionKey(): Buffer {
    const raw = String(process.env.RAKUTEN_RMS_API_ENCRYPTION_KEY ?? '').trim();
    let key: Buffer | null = null;
    if (/^[a-f0-9]{64}$/i.test(raw)) {
      key = Buffer.from(raw, 'hex');
    } else {
      try {
        const decoded = Buffer.from(raw, 'base64');
        if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) {
          key = decoded;
        }
      } catch {
        key = null;
      }
    }
    if (!key || key.length !== 32) {
      throw new InternalServerErrorException(
        '请配置 RAKUTEN_RMS_API_ENCRYPTION_KEY（32字节Base64或64位十六进制）',
      );
    }
    return key;
  }
}
