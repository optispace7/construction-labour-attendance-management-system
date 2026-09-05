import { argon2id } from '@noble/hashes/argon2';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Argon2id in plain JavaScript.
 *
 * Not WebAssembly, and not a native addon — both were tried and neither works
 * everywhere this runs. The addon cannot load on a serverless runtime at all,
 * and a WASM build fails there in a worse way: it bundles, boots, and then
 * throws `Wasm code generation disallowed by embedder` on first use, because
 * that runtime refuses to compile WebAssembly at request time. The symptom was
 * every login being refused as "invalid credentials".
 *
 * Plain JS is slower than either. That is the correct trade here: this runs on
 * a login and on an OTP check, never in a loop, and being slow is the point of
 * a password hash.
 *
 * The PHC string is assembled and parsed here rather than by a library, so the
 * format stays exactly what the previous implementations wrote:
 *
 *   $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>
 *
 * with unpadded base64. Every existing hash keeps verifying, whatever wrote it.
 */

/**
 * Cost for newly written hashes. Existing ones carry their own.
 *
 * The defaults are OWASP's argon2id figures and are what production uses. They
 * are overridable because a plain-JS argon2 takes about a second per hash, and
 * a test suite that hashes a few dozen times then takes ten minutes — which is
 * how a suite stops being run. Tests set a token cost; nothing else should.
 *
 * A floor is enforced rather than trusting the environment: a typo in a deploy
 * config must not be able to quietly reduce every password in the system to
 * something cheap to attack.
 */
const MIN_MEMORY_KIB = 8;
const MIN_ITERATIONS = 1;

const envCost = (name: string, fallback: number, floor: number): number => {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < floor) return fallback;
  // Only a test run may go below the production figures.
  if (raw < fallback && String(process.env.NODE_ENV) !== 'test') return fallback;
  return raw;
};

const DEFAULT_MEMORY_KIB = envCost('ARGON2_MEMORY_KIB', 19456, MIN_MEMORY_KIB);
const DEFAULT_ITERATIONS = envCost('ARGON2_ITERATIONS', 2, MIN_ITERATIONS);
const DEFAULT_PARALLELISM = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64').replace(/=+$/, '');

const unb64 = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

interface ParsedHash {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: Buffer;
  digest: Buffer;
}

/**
 * Reads a PHC argon2id string.
 *
 * Throws rather than returning null for anything unrecognised — a stored hash
 * that cannot be parsed is a corrupt record, and treating it as "wrong
 * password" would hide that behind a login failure.
 */
function parse(hash: string): ParsedHash {
  const parts = hash.split('$');
  // ['', 'argon2id', 'v=19', 'm=...,t=...,p=...', salt, digest]
  if (parts.length !== 6 || parts[1] !== 'argon2id') {
    throw new Error('not an argon2id PHC string');
  }
  const params = Object.fromEntries(
    parts[3].split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k, Number(v)];
    }),
  ) as Record<string, number>;
  if (!params.m || !params.t || !params.p) {
    throw new Error('argon2id hash is missing its cost parameters');
  }
  return {
    memoryKiB: params.m,
    iterations: params.t,
    parallelism: params.p,
    salt: unb64(parts[4]),
    digest: unb64(parts[5]),
  };
}

/** Hashes `secret` and returns a PHC string. */
export function hashArgon2id(secret: string): string {
  const salt = randomBytes(SALT_BYTES);
  const digest = argon2id(secret, salt, {
    t: DEFAULT_ITERATIONS,
    m: DEFAULT_MEMORY_KIB,
    p: DEFAULT_PARALLELISM,
    dkLen: HASH_BYTES,
  });
  return (
    `$argon2id$v=19$m=${DEFAULT_MEMORY_KIB},t=${DEFAULT_ITERATIONS},p=${DEFAULT_PARALLELISM}` +
    `$${b64(salt)}$${b64(digest)}`
  );
}

/**
 * Whether a stored hash was written at a costlier setting than we now use.
 *
 * It matters more than it looks. Verifying costs whatever the *stored* hash
 * says, and the hashes inherited from the previous deployment are m=64MiB,
 * t=3, p=4 — about 4.5 seconds each in plain JavaScript, against 0.9 for the
 * current setting. Rehashing on a successful login means a user pays that once
 * and never again.
 *
 * Deliberately only compares cost, not algorithm: everything here is argon2id.
 */
export function needsRehash(hash: string): boolean {
  try {
    const { memoryKiB, iterations, parallelism } = parse(hash);
    return (
      memoryKiB !== DEFAULT_MEMORY_KIB ||
      iterations !== DEFAULT_ITERATIONS ||
      parallelism !== DEFAULT_PARALLELISM
    );
  } catch {
    // Unparseable: leave it alone. Rewriting a hash we cannot read is how a
    // password gets replaced with one nobody knows.
    return false;
  }
}

/**
 * Verifies `secret` against a stored PHC string.
 *
 * The cost parameters come from the hash, not from the constants above, so a
 * hash written under the old settings (m=65536, t=3, p=4) still verifies after
 * they changed.
 */
export function verifyArgon2id(hash: string, secret: string): boolean {
  const { memoryKiB, iterations, parallelism, salt, digest } = parse(hash);
  const computed = Buffer.from(
    argon2id(secret, salt, {
      t: iterations,
      m: memoryKiB,
      p: parallelism,
      dkLen: digest.length,
    }),
  );
  // Constant-time; timingSafeEqual throws on a length mismatch, so guard it.
  return computed.length === digest.length && timingSafeEqual(computed, digest);
}
