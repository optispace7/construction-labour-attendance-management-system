import { CryptoService } from './crypto.service';

describe('CryptoService', () => {
  let svc: CryptoService;

  beforeAll(() => {
    // 32-byte key, base64.
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    svc = new CryptoService();
  });

  it('encrypts and decrypts round-trip', () => {
    const blob = svc.encrypt('123412341234');
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(svc.decrypt(blob)).toBe('123412341234');
  });

  it('produces different ciphertext each time (random IV)', () => {
    const a = svc.encrypt('secret');
    const b = svc.encrypt('secret');
    expect(a.equals(b)).toBe(false);
  });

  it('fails to decrypt tampered ciphertext (GCM auth)', () => {
    const blob = svc.encrypt('secret');
    blob[blob.length - 1] ^= 0xff;
    expect(() => svc.decrypt(blob)).toThrow();
  });

  it('rejects a key that is not 32 bytes', () => {
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64');
    expect(() => new CryptoService()).toThrow();
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  });
});
