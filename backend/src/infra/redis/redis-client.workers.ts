import type { RedisLike } from './redis-client';

/**
 * Redis over Upstash's REST API, for the serverless runtime.
 *
 * ioredis is not used here, and the reason is the same one that made the
 * database pool hand out dead sockets: this runtime freezes an isolate between
 * requests. A client built around a long-lived TCP connection, a reconnect
 * strategy and backoff timers has nothing to stand on — the timers do not run
 * while the isolate is frozen, and the socket does not survive to the next
 * request. Upstash's REST endpoint is one ordinary HTTPS call per command,
 * which is exactly what this runtime is good at.
 *
 * Written against `fetch` rather than @upstash/redis on purpose: the two
 * commands this application issues are a SET and an EVAL, and the bundle is
 * already close to the size limit.
 *
 * Configured by UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. If either
 * is missing every command rejects, which RedisService reads as "Redis is
 * unreachable" and lets the tap through — the same degraded behaviour as a
 * genuine outage, rather than a gate that stops working because a secret was
 * never set.
 */

interface UpstashReply {
  result?: unknown;
  error?: string;
}

async function command(args: (string | number)[]): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL/TOKEN are not configured');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args.map(String)),
  });
  if (!res.ok) {
    // Read as text: an error from the edge in front of Upstash is not JSON,
    // and parsing it blind loses the only description of what went wrong.
    throw new Error(`Upstash returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as UpstashReply;
  if (body.error) throw new Error(`Upstash: ${body.error}`);
  return body.result;
}

export function createRedisClient(): RedisLike {
  return {
    async set(key, value, mode, ttl, nx) {
      const result = await command(['SET', key, value, mode, ttl, nx]);
      // Upstash answers null when NX found the key already there, which is the
      // same "somebody else holds it" ioredis reports.
      return result === 'OK' ? 'OK' : null;
    },
    eval(script, numKeys, key, arg) {
      return command(['EVAL', script, numKeys, key, arg]);
    },
    // There is no connection to have opinions about, so there are no events.
    // RedisService registers handlers for 'error' and 'ready'; both are simply
    // never called, and the per-command rejection above carries the failure.
    on() {
      return undefined;
    },
    quit() {
      return Promise.resolve();
    },
    disconnect() {
      /* nothing is held open */
    },
  };
}
