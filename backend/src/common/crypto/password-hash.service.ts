import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * Password hashing, performed by Postgres rather than by this process.
 *
 * The reason is a hard limit rather than a preference. On the serverless
 * runtime this now deploys to, a request gets a very small CPU budget, and
 * every password KDF worth using costs far more than that: Argon2id in plain
 * JavaScript is about four seconds and is killed outright. The platform's own
 * WebCrypto offers only PBKDF2, and refuses more than 100,000 iterations —
 * roughly a sixth of what is currently recommended for it — so that is not a
 * way out either.
 *
 * Postgres has no such budget. pgcrypto's crypt() computes bcrypt in the
 * database, which costs this process one round trip and no arithmetic, and
 * bcrypt at cost 10 is squarely inside current guidance. Measured on the
 * production database: ~89ms at cost 10, ~340ms at cost 12.
 *
 * The password does travel to Postgres to be hashed. That is a real widening
 * of where the plaintext goes, and it is acceptable here only because the
 * connection is TLS and the server is not configured to log it —
 * log_statement is 'ddl', slow-query logging is off, and parameters are not
 * logged on error. Turning statement logging on would put passwords in the
 * log, so that setting is now a security-relevant one.
 */

/** Cost floor. Below this, bcrypt stops being worth the round trip. */
const MIN_COST = 4;
const PRODUCTION_COST = 10;

const cost = (): number => {
  const raw = Number(process.env.BCRYPT_COST);
  if (!Number.isInteger(raw) || raw < MIN_COST || raw > 31) return PRODUCTION_COST;
  // Only a test run may go below the production figure, for the same reason
  // the Argon2 cost was overridable: a suite that hashes dozens of times
  // otherwise stops being run. A typo in a deploy config must not be able to
  // quietly weaken every password in the system.
  if (raw < PRODUCTION_COST && String(process.env.NODE_ENV) !== 'test') return PRODUCTION_COST;
  return raw;
};

/**
 * A bcrypt modular-crypt string, and nothing else.
 *
 * This guard is not decoration. crypt() does not reject a salt it does not
 * recognise — it falls back to traditional DES crypt and returns a perfectly
 * ordinary looking answer:
 *
 *   crypt('pw', '$argon2id$v=19$m=65536,...')  ->  '$adA2QJcJYUro'
 *   crypt('pw', 'not-a-hash-at-all')           ->  'noufLM66ZQsGM'
 *
 * DES crypt takes its salt from the first two characters and, worse, ignores
 * everything after the eighth character of the password. Handing crypt() a
 * stored value without checking its shape first is therefore a way to end up
 * silently comparing eight characters of a password against a 1970s hash. The
 * format is checked here, before the value is ever passed to crypt().
 */
const BCRYPT_RE = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

@Injectable()
export class PasswordHashService {
  private readonly logger = new Logger(PasswordHashService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Hashes `secret` with bcrypt at the current cost. */
  async hash(secret: string): Promise<string> {
    const c = cost();
    const rows = await this.prisma.$queryRaw<
      { hash: string }[]
    >`SELECT crypt(${secret}, gen_salt('bf', ${c}::int4)) AS hash`;
    const hash = rows[0]?.hash;
    if (!hash || !BCRYPT_RE.test(hash)) {
      // Storing whatever came back would be worse than failing: an unusable
      // hash locks the account out permanently and looks like a wrong password.
      throw new Error('pgcrypto did not return a bcrypt hash');
    }
    return hash;
  }

  /**
   * Verifies `secret` against a stored bcrypt hash.
   *
   * Anything that is not a bcrypt string is false without a database call —
   * see BCRYPT_RE. That covers the Argon2 hashes inherited from the previous
   * deployment, which cannot be verified on this runtime at any price; those
   * accounts have to go through a password reset.
   */
  async verify(hash: string, secret: string): Promise<boolean> {
    if (!BCRYPT_RE.test(hash)) return false;
    try {
      const rows = await this.prisma.$queryRaw<
        { ok: boolean }[]
      >`SELECT crypt(${secret}, ${hash}) = ${hash} AS ok`;
      return rows[0]?.ok === true;
    } catch (e) {
      // A database that cannot be reached and a wrong password are the same
      // "invalid credentials" from outside. Silence there is what made the
      // previous hashing failure take so long to find.
      this.logger.error(`Password verification failed to run: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Whether a stored hash should be rewritten after it next verifies.
   *
   * True for a bcrypt hash below the current cost. Deliberately false for
   * anything unparseable: rewriting a hash we cannot read is how a password
   * becomes one nobody knows. Also false for the inherited Argon2 hashes —
   * they never verify here, so the question never arises.
   */
  needsRehash(hash: string): boolean {
    const m = BCRYPT_RE.exec(hash);
    if (!m) return false;
    return Number(m[1]) < cost();
  }
}
