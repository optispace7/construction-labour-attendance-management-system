import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as argon2 from 'argon2';

/**
 * Field-level encryption for sensitive data (e.g. Aadhaar) using AES-256-GCM.
 * Stored blob layout: [12-byte IV][16-byte auth tag][ciphertext].
 * Password hashing uses Argon2id.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  private readonly IV_LEN = 12;
  private readonly TAG_LEN = 16;

  constructor() {
    const b64 = process.env.DATA_ENCRYPTION_KEY;
    if (!b64) {
      throw new InternalServerErrorException('DATA_ENCRYPTION_KEY is not configured');
    }
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) {
      throw new InternalServerErrorException('DATA_ENCRYPTION_KEY must decode to 32 bytes');
    }
    this.key = key;
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(this.IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]);
  }

  decrypt(blob: Buffer): string {
    return this.decryptBuffer(blob).toString('utf8');
  }

  /**
   * Encrypt raw bytes (e.g. a compressed Aadhaar image) with the same
   * [IV][tag][ciphertext] layout as {@link encrypt}.
   */
  encryptBuffer(plaintext: Buffer): Buffer {
    const iv = randomBytes(this.IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]);
  }

  /** Inverse of {@link encryptBuffer}; returns the original bytes. */
  decryptBuffer(blob: Buffer): Buffer {
    const iv = blob.subarray(0, this.IV_LEN);
    const tag = blob.subarray(this.IV_LEN, this.IV_LEN + this.TAG_LEN);
    const data = blob.subarray(this.IV_LEN + this.TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /**
   * Argon2id hash for a secret somebody could *guess* — a password, or the
   * six-digit reset OTP. The cost is the whole point there: it is what makes
   * running through the candidates expensive.
   */
  async hashToken(token: string): Promise<string> {
    return argon2.hash(token, { type: argon2.argon2id });
  }

  /**
   * Hash for an opaque token the server itself generated — a device token, a
   * refresh token. These carry 122 bits of randomness, so there is no candidate
   * list to run through and nothing for a slow hash to slow down. What is
   * wanted is only that a stolen database does not hand over usable tokens,
   * which SHA-256 does perfectly well.
   *
   * Argon2 was being used here, and it was measurably the wrong tool: the
   * device guard verifies a device token on *every authenticated request*, so
   * each call to the API was paying a 64 MB, three-pass hash designed to take
   * tens of milliseconds — on a half-core container, with the phone waiting.
   */
  hashOpaqueToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** True for a hash still stored in the old Argon2id format. */
  isLegacyTokenHash(hash: string): boolean {
    return hash.startsWith('$argon2');
  }

  /**
   * Verify an opaque token against either format, so tokens issued before the
   * change keep working. Callers should upgrade a legacy hash once it verifies
   * — see DeviceAuthService.validateToken.
   */
  async verifyToken(hash: string, token: string): Promise<boolean> {
    try {
      if (this.isLegacyTokenHash(hash)) return await argon2.verify(hash, token);
      const expected = Buffer.from(hash, 'hex');
      const actual = createHash('sha256').update(token).digest();
      // Constant-time: timingSafeEqual throws on a length mismatch, so guard it.
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
}
