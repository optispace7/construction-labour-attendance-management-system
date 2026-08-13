import * as argon2 from 'argon2';
import { CryptoService } from './crypto.service';

/**
 * Device tokens are verified on every authenticated request, so what this
 * costs is what every screen in both apps costs. It was an Argon2id hash — 64
 * MB and three passes — which is what made the panel and the phone crawl on a
 * half-core container.
 *
 * The point of these tests is that moving to SHA-256 did not break anybody
 * already holding a token issued under the old scheme.
 */
// The constructor needs a key for the field-encryption half of the service;
// none of these tests touch it.
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

describe('CryptoService opaque tokens', () => {
  const svc = new CryptoService();
  const token = 'device-id.9f1c8b30-1f0e-4a1a-9a0a-2c9d5f9e77bb';

  it('verifies a token it just hashed', async () => {
    const hash = svc.hashOpaqueToken(token);
    await expect(svc.verifyToken(hash, token)).resolves.toBe(true);
  });

  it('refuses the wrong token', async () => {
    const hash = svc.hashOpaqueToken(token);
    await expect(svc.verifyToken(hash, `${token}x`)).resolves.toBe(false);
  });

  it('still verifies a hash stored in the old Argon2id format', async () => {
    // Exactly what is sitting in the devices table for every phone already
    // registered — logging them all out would not have been an acceptable fix.
    const legacy = await argon2.hash(token, { type: argon2.argon2id });
    expect(svc.isLegacyTokenHash(legacy)).toBe(true);
    await expect(svc.verifyToken(legacy, token)).resolves.toBe(true);
    await expect(svc.verifyToken(legacy, 'wrong')).resolves.toBe(false);
  });

  it('knows which format it is looking at', () => {
    expect(svc.isLegacyTokenHash(svc.hashOpaqueToken(token))).toBe(false);
  });

  it('survives a malformed stored hash instead of throwing', async () => {
    // A truncated or junk column must read as "does not match", not blow up
    // the request — this runs inside the device guard.
    await expect(svc.verifyToken('not-a-hash', token)).resolves.toBe(false);
    await expect(svc.verifyToken('', token)).resolves.toBe(false);
    await expect(svc.verifyToken('abcd', token)).resolves.toBe(false);
  });

  it('is dramatically cheaper than the hash it replaced', async () => {
    const legacy = await argon2.hash(token, { type: argon2.argon2id });

    const t0 = process.hrtime.bigint();
    await svc.verifyToken(legacy, token);
    const argonNs = Number(process.hrtime.bigint() - t0);

    const fast = svc.hashOpaqueToken(token);
    const t1 = process.hrtime.bigint();
    await svc.verifyToken(fast, token);
    const shaNs = Number(process.hrtime.bigint() - t1);

    // Measured at ~26,000x on a fast multi-core machine and worse on the
    // half-core container. A very loose bound, so this asserts the property
    // without being a flaky benchmark.
    expect(shaNs * 20).toBeLessThan(argonNs);
  });
});
