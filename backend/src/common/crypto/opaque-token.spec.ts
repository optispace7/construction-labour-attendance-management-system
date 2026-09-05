/**
 * A hash in the old Argon2id format.
 *
 * A literal rather than something minted by the native library: nothing
 * verifies these any more, so all a test needs is a string of the right
 * shape, and the suite no longer has to depend on the addon to make one.
 */
const LEGACY_ARGON2_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$UTg6kAR/MrwAPGs1zW33Bg$' +
  'SG030NtdTI5tLGE4KXfl1VtXtsCRPDtqmUI+k0NC4A0';

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

  it('refuses a hash stored in the old Argon2id format, rather than checking it', async () => {
    // These used to be verified, and were, for exactly as long as there was a
    // machine with spare CPU to do it on. Verifying one costs 64 MiB and three
    // passes, which the serverless runtime kills outright — so attempting it
    // turns a stale token into a 500 rather than the 401 that tells the client
    // to authenticate again. Refusing is self-healing: the client re-registers
    // and is written back as SHA-256.
    expect(svc.isLegacyTokenHash(LEGACY_ARGON2_HASH)).toBe(true);
    await expect(svc.verifyToken(LEGACY_ARGON2_HASH, token)).resolves.toBe(false);
    await expect(svc.verifyToken(LEGACY_ARGON2_HASH, 'wrong')).resolves.toBe(false);
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

});
