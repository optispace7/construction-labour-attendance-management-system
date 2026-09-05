import Redis from 'ioredis';

/**
 * The slice of a Redis client this application actually uses.
 *
 * Narrow on purpose: it is the whole contract the serverless implementation in
 * redis-client.workers.ts has to meet, and keeping it to two commands is what
 * makes that implementation a few lines of fetch rather than a port of a
 * client library.
 */
export interface RedisLike {
  /** SET key value PX ttl NX — returns 'OK' if it was taken, null if held. */
  set(key: string, value: string, mode: 'PX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, key: string, arg: string): Promise<unknown>;
  on(event: 'error' | 'ready', handler: (e?: Error) => void): unknown;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export function createRedisClient(): RedisLike {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    // Fail a command instead of parking it. The gate takes a lock from here
    // before it records anything, and the old settings (unlimited retries plus
    // ioredis's offline queue) meant an unreachable Redis did not fail a scan —
    // it queued it for ever, so the watchman's tap simply hung until the phone
    // gave up twenty seconds later and the worker never appeared. Redis being
    // down must cost a scan milliseconds, not the whole gate.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3000,
    commandTimeout: 2000,
    // Keep trying to get back, with a ceiling, so a blip heals itself rather
    // than needing the container restarted.
    retryStrategy: (times) => Math.min(times * 200, 5000),
  }) as unknown as RedisLike;
}
