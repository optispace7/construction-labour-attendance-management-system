import { CryptoService } from './crypto.service';

/**
 * Password hashing has now changed implementation twice: from the native
 * `argon2` addon, to a WebAssembly build, to plain JavaScript. The addon cannot
 * load on a serverless runtime, and the WASM build failed there in a worse way
 * — it bundled and booted, then threw `Wasm code generation disallowed by
 * embedder` on first use, so every login came back "invalid credentials".
 *
 * These tests exist because none of that may be visible to an existing account.
 * Every password and OTP hash in the database was written by the addon at its
 * defaults (m=65536, t=3, p=4) and must keep verifying. If that stops being
 * true, every user is locked out at once — so it is pinned against a real hash
 * captured from the old implementation, not one generated at test time.
 */
describe('CryptoService — inherited Argon2 hashes keep verifying', () => {
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

  /**
   * The same password and library, at a cost cheap enough to use freely.
   *
   * Still m=1024,t=2,p=4 — deliberately unlike the current m=19456,t=2,p=1 —
   * so it goes on proving the parameters are read from the hash rather than
   * from the constants. What it does not prove is that the *production* figure
   * verifies, which is why the real one above is still exercised once.
   */
  const CHEAP_LEGACY_HASH =
    '$argon2id$v=19$m=1024,t=2,p=4$ByinpsIYFd2xX/p2hjvlbw$' +
    'PFuLDK+ZFYMFn7LqV7U4iGF+0hfkGq1E4VGrt7f3aXc';

  // Slow on purpose, and the one test here worth its cost: this is the exact
  // parameter set every inherited password in the database carries, and if it
  // stops verifying every user is locked out at once. Around four seconds of
  // real work, but far longer under Jest — its sandboxed globals make the
  // typed-array arithmetic argon2 is built from roughly thirty times slower,
  // so budget over two minutes here and do not read that as the cost a login
  // pays. Measured directly on the same machine, outside Jest: 3.9s for this
  // hash, 0.76s once it has been rewritten at the current cost.
  it('verifies a password hashed by the old native library', async () => {
    await expect(svc.verifyPassword(LEGACY_HASH, LEGACY_PASSWORD)).resolves.toBe(true);
  }, 300_000);

  it('rejects a wrong password against an old hash', async () => {
    // Cheap fixture: rejection does not depend on the cost, only on the
    // parameters being honoured, and paying two more minutes to learn that
    // twice is how a suite stops being run.
    await expect(svc.verifyPassword(CHEAP_LEGACY_HASH, 'wrong-password')).resolves.toBe(false);
    await expect(svc.verifyPassword(CHEAP_LEGACY_HASH, LEGACY_PASSWORD)).resolves.toBe(true);
  });

  it('round-trips a freshly hashed password', async () => {
    const hash = await svc.hashPassword('s3cret-passphrase');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(svc.verifyPassword(hash, 's3cret-passphrase')).resolves.toBe(true);
    await expect(svc.verifyPassword(hash, 's3cret-passphras')).resolves.toBe(false);
  });

  it('writes a well-formed PHC string carrying its own cost', async () => {
    // The cost itself is not asserted here: tests run at a token cost so the
    // suite does not take ten minutes, and pinning the number would only test
    // the test config. What matters is that the parameters travel *inside* the
    // hash, which is what lets an old hash verify after the cost changes.
    const hash = await svc.hashPassword('another-one');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[^$]+\$[^$]+$/);
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

/**
 * Rehash-on-login.
 *
 * Verifying costs whatever the *stored* hash says, and the inherited ones are
 * several seconds each in plain JavaScript. They are rewritten at the current
 * cost the first time their owner logs in, so the slow verification is paid
 * once per account rather than on every login for ever.
 */
describe('CryptoService — inherited hashes are rewritten at the current cost', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  let svc: CryptoService;

  beforeAll(() => {
    process.env.DATA_ENCRYPTION_KEY = KEY;
    svc = new CryptoService();
  });

  it('flags a hash written at the old cost', () => {
    const legacy =
      '$argon2id$v=19$m=65536,t=3,p=4$UTg6kAR/MrwAPGs1zW33Bg$' +
      'SG030NtdTI5tLGE4KXfl1VtXtsCRPDtqmUI+k0NC4A0';
    expect(svc.passwordNeedsRehash(legacy)).toBe(true);
  });

  it('leaves a hash already at the current cost alone', async () => {
    const fresh = await svc.hashPassword('whatever');
    expect(svc.passwordNeedsRehash(fresh)).toBe(false);
  });

  it('does not touch a hash it cannot read', () => {
    // Rewriting a hash we cannot parse is how a password becomes one nobody
    // knows. Better to leave a corrupt record visible than to overwrite it.
    expect(svc.passwordNeedsRehash('not-a-phc-string')).toBe(false);
    expect(svc.passwordNeedsRehash('')).toBe(false);
  });
});
