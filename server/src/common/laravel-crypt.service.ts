import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Port of Laravel's Illuminate\Encryption\Encrypter for the `encrypted` Eloquent cast
 * (Crypt::encryptString / decryptString). Default cipher AES-256-CBC. The payload is
 * base64(json({iv, value, mac, tag})) where mac = HMAC-SHA256(iv_b64 . value_b64, key).
 * Values are NOT PHP-serialized (encryptString uses serialize=false).
 */
@Injectable()
export class LaravelCryptService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const appKey = config.get<string>('appKey') ?? process.env.APP_KEY ?? '';
    const raw = appKey.startsWith('base64:') ? appKey.slice(7) : appKey;
    this.key = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(32);
  }

  /** Decrypt a Laravel-encrypted string, or return null if it isn't a valid payload. */
  decryptString(payload: string | null | undefined): string | null {
    if (payload === null || payload === undefined || payload === '') return null;
    try {
      const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { iv?: string; value?: string; mac?: string };
      if (!json.iv || !json.value || !json.mac) return null;
      // Verify the MAC (HMAC-SHA256 over the base64 iv + base64 value).
      const expected = crypto.createHmac('sha256', this.key).update(json.iv + json.value).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(json.mac))) return null;

      const iv = Buffer.from(json.iv, 'base64');
      const ciphertext = Buffer.from(json.value, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-cbc', this.key, iv);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /** Encrypt a string in Laravel's payload format (so Laravel can decrypt it at/after cutover). */
  encryptString(value: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()]);
    const ivB64 = iv.toString('base64');
    const valueB64 = encrypted.toString('base64');
    const mac = crypto.createHmac('sha256', this.key).update(ivB64 + valueB64).digest('hex');
    const json = JSON.stringify({ iv: ivB64, value: valueB64, mac, tag: '' });
    return Buffer.from(json, 'utf8').toString('base64');
  }
}
