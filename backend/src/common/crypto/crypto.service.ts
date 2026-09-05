import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { hashArgon2id, needsRehash, verifyArgon2id } from './argon2';

/**
 * Field-level encryption for sensitive data (e.g. Aadhaar) using AES-256-GCM.
 * Stored blob layout: [12-byte IV][16-byte auth tag][ciphertext].
 * Password hashing uses Argon2id.
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);

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
    return hashArgon2id(password);
  }

  /**
   * Whether this hash should be rewritten at the current cost after it next
   * verifies. See needsRehash — inherited hashes are several seconds to check.
   */
  passwordNeedsRehash(hash: string): boolean {
    return needsRehash(hash);
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return verifyArgon2id(hash, password);
    } catch (e) {
      // A malformed stored hash and a broken hashing library both end up here,
      // and they look identical from outside: every login is refused. Silence
      // made that indistinguishable from a wrong password, so the reason is
      // logged — never the password or the hash.
      this.logger.error(`Password verification failed to run: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Argon2id hash for a secret somebody could *guess* — a password, or the
   * six-digit reset OTP. The cost is the whole point there: it is what makes
   * running through the candidates expensive.
   */
  async hashToken(token: string): Promise<string> {
    return hashArgon2id(token);
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
      if (this.isLegacyTokenHash(hash)) return verifyArgon2id(hash, token);
      const expected = Buffer.from(hash, 'hex');
      const actual = createHash('sha256').update(token).digest();
      // Constant-time: timingSafeEqual throws on a length mismatch, so guard it.
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
}
