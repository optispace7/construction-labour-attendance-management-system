import { PasswordHashService } from './password-hash.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * These tests stub the database. What is being checked is not that bcrypt
 * works — Postgres is entitled to be trusted about that — but the decisions
 * made on this side of the round trip, which is where the sharp edges are.
 */
type Row = Record<string, unknown>;

/** Records every query, and answers with whatever the test queued up. */
function fakePrisma(answer: (sql: string, params: unknown[]) => Row[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const prisma = {
    $queryRaw: (strings: TemplateStringsArray, ...params: unknown[]) => {
      const sql = strings.join('?');
      calls.push({ sql, params });
      return Promise.resolve(answer(sql, params));
    },
  } as unknown as PrismaService;
  return { prisma, calls };
}

const BCRYPT = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

describe('PasswordHashService', () => {
  afterEach(() => {
    delete process.env.BCRYPT_COST;
  });

  describe('refuses to hand anything but bcrypt to crypt()', () => {
    /**
     * The reason this guard exists at all. crypt() does not reject a salt it
     * does not understand — it quietly falls back to traditional DES crypt,
     * which derives its salt from the first two characters and ignores
     * everything past the eighth character of the password. Passing a stored
     * value to crypt() without checking its shape is how eight characters of a
     * password end up being compared against a 1970s hash.
     */
    it.each([
      ['an inherited Argon2 hash', '$argon2id$v=19$m=65536,t=3,p=4$UTg6kAR/MrwAPGs1zW33Bg$SG030NtdTI5tLGE4KXfl1VtXtsCRPDtqmUI+k0NC4A0'],
      ['a DES crypt hash', 'noufLM66ZQsGM'],
      ['a SHA-256 hex digest', 'a'.repeat(64)],
      ['an empty string', ''],
      ['obvious rubbish', 'not-a-hash-at-all'],
      ['a bcrypt hash of the wrong length', '$2a$10$tooshort'],
      ['a bcrypt hash with a non-numeric cost', '$2a$xx$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'],
    ])('returns false for %s without touching the database', async (_label, stored) => {
      const { prisma, calls } = fakePrisma(() => {
        throw new Error('the database should not have been consulted');
      });
      const svc = new PasswordHashService(prisma);
      await expect(svc.verify(stored, 'any-password')).resolves.toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  it('verifies a real bcrypt hash through the database', async () => {
    const { prisma, calls } = fakePrisma(() => [{ ok: true }]);
    const svc = new PasswordHashService(prisma);
    await expect(svc.verify(BCRYPT, 'correct-password')).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    // The password and the hash travel as bound parameters, never spliced into
    // the statement text.
    expect(calls[0].params).toEqual(['correct-password', BCRYPT, BCRYPT]);
    expect(calls[0].sql).not.toContain('correct-password');
  });

  it('treats a false answer as a wrong password', async () => {
    const { prisma } = fakePrisma(() => [{ ok: false }]);
    const svc = new PasswordHashService(prisma);
    await expect(svc.verify(BCRYPT, 'wrong')).resolves.toBe(false);
  });

  it('treats an unreachable database as a failed login, not a successful one', async () => {
    const { prisma } = fakePrisma(() => {
      throw new Error('connection refused');
    });
    const svc = new PasswordHashService(prisma);
    await expect(svc.verify(BCRYPT, 'correct-password')).resolves.toBe(false);
  });

  it('does not read a missing row as a match', async () => {
    const { prisma } = fakePrisma(() => []);
    const svc = new PasswordHashService(prisma);
    await expect(svc.verify(BCRYPT, 'correct-password')).resolves.toBe(false);
  });

  describe('hash', () => {
    it('returns what pgcrypto produced', async () => {
      const { prisma, calls } = fakePrisma(() => [{ hash: BCRYPT }]);
      const svc = new PasswordHashService(prisma);
      await expect(svc.hash('a-password')).resolves.toBe(BCRYPT);
      expect(calls[0].params).toEqual(['a-password', 10]);
    });

    it('refuses to return something that is not a bcrypt hash', async () => {
      // Storing whatever came back would lock the account out permanently and
      // look exactly like a wrong password.
      const { prisma } = fakePrisma(() => [{ hash: 'noufLM66ZQsGM' }]);
      const svc = new PasswordHashService(prisma);
      await expect(svc.hash('a-password')).rejects.toThrow(/did not return a bcrypt hash/);
    });

    it('refuses when the database returns nothing at all', async () => {
      const { prisma } = fakePrisma(() => []);
      const svc = new PasswordHashService(prisma);
      await expect(svc.hash('a-password')).rejects.toThrow(/did not return a bcrypt hash/);
    });
  });

  describe('cost', () => {
    it('uses cost 10 by default', async () => {
      const { prisma, calls } = fakePrisma(() => [{ hash: BCRYPT }]);
      await new PasswordHashService(prisma).hash('x');
      expect(calls[0].params[1]).toBe(10);
    });

    it('ignores a cheaper cost outside a test run', async () => {
      // A typo in a deploy config must not be able to quietly weaken every
      // password in the system.
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      process.env.BCRYPT_COST = '4';
      const { prisma, calls } = fakePrisma(() => [{ hash: BCRYPT }]);
      await new PasswordHashService(prisma).hash('x');
      expect(calls[0].params[1]).toBe(10);
      process.env.NODE_ENV = previous;
    });

    it('accepts a stronger cost anywhere', async () => {
      process.env.BCRYPT_COST = '12';
      const { prisma, calls } = fakePrisma(() => [{ hash: BCRYPT }]);
      await new PasswordHashService(prisma).hash('x');
      expect(calls[0].params[1]).toBe(12);
    });

    it.each([['0'], ['32'], ['abc'], ['10.5']])('falls back to 10 for %s', async (bad) => {
      process.env.BCRYPT_COST = bad;
      const { prisma, calls } = fakePrisma(() => [{ hash: BCRYPT }]);
      await new PasswordHashService(prisma).hash('x');
      expect(calls[0].params[1]).toBe(10);
    });
  });

  describe('needsRehash', () => {
    it('flags a bcrypt hash below the current cost', () => {
      const { prisma } = fakePrisma(() => []);
      const svc = new PasswordHashService(prisma);
      expect(svc.needsRehash('$2a$08$' + 'a'.repeat(53))).toBe(true);
    });

    it('leaves a hash at the current cost alone', () => {
      const { prisma } = fakePrisma(() => []);
      expect(new PasswordHashService(prisma).needsRehash(BCRYPT)).toBe(false);
    });

    it('does not touch a hash it cannot read', () => {
      // Rewriting a hash we cannot parse is how a password becomes one nobody
      // knows. That includes the inherited Argon2 hashes, which never verify
      // here anyway — those accounts need a reset, not a rewrite.
      const { prisma } = fakePrisma(() => []);
      const svc = new PasswordHashService(prisma);
      expect(svc.needsRehash('$argon2id$v=19$m=65536,t=3,p=4$abc$def')).toBe(false);
      expect(svc.needsRehash('')).toBe(false);
      expect(svc.needsRehash('not-a-hash')).toBe(false);
    });
  });
});
