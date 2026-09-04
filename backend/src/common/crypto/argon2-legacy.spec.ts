import { CryptoService } from './crypto.service';

/**
 * Password hashing moved from the native `argon2` addon to a WebAssembly build
 * so it can run on a runtime with no native-module support.
 *
 * The point of these tests is that the move is invisible to existing accounts:
 * every password and OTP hash already in the database was produced by the old
 * library with its defaults (m=65536, t=3, p=4), and must keep verifying. If
 * that ever stops being true, every user is locked out at once — so it is
 * pinned here with a real hash captured from the old implementation rather than
 * one generated at test time.
 */
describe('CryptoService — Argon2 hashes survive the WASM switch', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  let svc: CryptoService;

  beforeAll(() => {
    process.env.DATA_ENCRYPTION_KEY = KEY;
    svc = new CryptoService();
  });

  // Produced by `argon2.hash('Correct-Horse-Battery-Staple-9', { type: argon2id })`
  // on the native addon, at the defaults the app shipped with.
  const LEGACY_PASSWORD = 'Correct-Horse-Battery-Staple-9';
  const LEGACY_HASH =
    '$argon2id$v=19$m=65536,t=3,p=4$UTg6kAR/MrwAPGs1zW33Bg$' +
    'SG030NtdTI5tLGE4KXfl1VtXtsCRPDtqmUI+k0NC4A0';

  it('verifies a password hashed by the old native library', async () => {
    // The cost parameters live in the hash string, so the old m=65536,t=3,p=4
    // is honoured even though new hashes are written at the lower setting.
    await expect(svc.verifyPassword(LEGACY_HASH, LEGACY_PASSWORD)).resolves.toBe(true);
  });

  it('rejects a wrong password against an old hash', async () => {
    await expect(svc.verifyPassword(LEGACY_HASH, 'wrong-password')).resolves.toBe(false);
  });

  it('round-trips a freshly hashed password', async () => {
    const hash = await svc.hashPassword('s3cret-passphrase');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(svc.verifyPassword(hash, 's3cret-passphrase')).resolves.toBe(true);
    await expect(svc.verifyPassword(hash, 's3cret-passphras')).resolves.toBe(false);
  });

  it('writes new hashes at the reduced memory cost', async () => {
    // 19 MiB, not 64 — the runtime caps a request at 128 MB total.
    const hash = await svc.hashPassword('another-one');
    expect(hash).toContain('m=19456,t=2,p=1');
  });

  it('still salts: the same password hashes differently each time', async () => {
    const a = await svc.hashPassword('same-input');
    const b = await svc.hashPassword('same-input');
    expect(a).not.toEqual(b);
  });

  it('verifies a legacy Argon2 opaque-token hash through verifyToken', async () => {
    // Device/refresh tokens issued before the SHA-256 switch are Argon2 strings;
    // verifyToken must still read them, now through the WASM verifier.
    const token = 'opaque-token-value';
    const legacy = await svc.hashToken(token);
    expect(svc.isLegacyTokenHash(legacy)).toBe(true);
    await expect(svc.verifyToken(legacy, token)).resolves.toBe(true);
    await expect(svc.verifyToken(legacy, 'nope')).resolves.toBe(false);
  });
});
