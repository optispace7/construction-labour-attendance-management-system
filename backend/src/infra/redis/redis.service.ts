import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createRedisClient, type RedisLike } from './redis-client';

/** How often a continuing Redis outage is allowed to write to the log. */
const WARN_EVERY_MS = 60_000;

/**
 * Token handed back when Redis could not be reached at all.
 *
 * It is not a lock — it is permission to carry on without one. See
 * {@link RedisService.acquireLock} for why the gate is let through.
 */
const DEGRADED_TOKEN = 'redis-unavailable';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private lastWarnAt = 0;

  readonly client: RedisLike;

  constructor() {
    this.client = createRedisClient();

    // ioredis emits 'error' on every failed reconnect. Without a listener Node
    // reports each one as an unhandled error event, which is what filled the
    // container log during the outage and told nobody anything useful.
    this.client.on('error', (e?: Error) => this.warn('connection', e));
    this.client.on('ready', () => {
      this.lastWarnAt = 0;
      this.logger.log('Redis connected');
    });
  }

  /** Rate-limited: a Redis outage retries every few seconds for hours. */
  private warn(what: string, e: unknown) {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_EVERY_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(
      `Redis ${what} failed (${(e as Error).message}). ` +
        'Per-worker tap locking is degraded; the one-open-session-per-worker ' +
        'index is still enforcing the rule in Postgres.',
    );
  }

  /**
   * Acquire a short-lived distributed lock. Returns a release token if
   * acquired, or null if the lock is genuinely held by somebody else.
   *
   * When Redis itself cannot be reached it returns {@link DEGRADED_TOKEN}
   * rather than null, so the caller proceeds. This is deliberate: the lock only
   * serialises two taps racing on the same worker, and the invariant that
   * actually matters — one OPEN session per worker — is a partial unique index
   * in Postgres, which does not care whether Redis is up. Returning null here
   * would read as "someone else is mid-scan" and refuse every tap on the site
   * for as long as Redis was away, which is a worse failure than the race it
   * would be preventing.
   */
  async acquireLock(key: string, ttlMs = 5000): Promise<string | null> {
    const token = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    try {
      const ok = await this.client.set(key, token, 'PX', ttlMs, 'NX');
      return ok === 'OK' ? token : null;
    } catch (e) {
      this.warn('lock', e);
      return DEGRADED_TOKEN;
    }
  }

  async releaseLock(key: string, token: string): Promise<void> {
    // Nothing was taken, so there is nothing to give back.
    if (token === DEGRADED_TOKEN) return;
    // Release only if we still own the lock (atomic check-and-delete).
    const lua = `if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1]) else return 0 end`;
    try {
      await this.client.eval(lua, 1, key, token);
    } catch (e) {
      // The lock expires on its own after ttlMs, so a failed release costs a
      // few seconds of contention at worst — never a failed scan.
      this.warn('unlock', e);
    }
  }

  async onModuleDestroy() {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

export const REDIS_DEGRADED_TOKEN = DEGRADED_TOKEN;
