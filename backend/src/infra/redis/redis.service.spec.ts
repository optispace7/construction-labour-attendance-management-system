import { RedisService, REDIS_DEGRADED_TOKEN } from './redis.service';

/**
 * What happens at the gate when Redis is not there.
 *
 * The outage this guards against: ioredis was configured with unlimited
 * per-command retries and its offline queue left on, so a SET issued while the
 * connection was down was never refused — it waited. The watchman's scan hung
 * for the twenty seconds the phone allowed, the session was never opened, and
 * the worker did not appear on anyone's screen. Redis was merely unreachable;
 * the gate looked broken.
 */

/** A service with its client swapped for a double — no real connection. */
function serviceWith(client: Partial<{ set: unknown; eval: unknown }>): RedisService {
  const svc = Object.create(RedisService.prototype) as RedisService;
  Object.defineProperty(svc, 'client', { value: client, writable: true });
  Object.defineProperty(svc, 'logger', { value: { warn: jest.fn(), log: jest.fn() } });
  (svc as unknown as { lastWarnAt: number }).lastWarnAt = 0;
  return svc;
}

describe('RedisService.acquireLock', () => {
  it('hands back a token when the lock is free', async () => {
    const svc = serviceWith({ set: jest.fn().mockResolvedValue('OK') });
    const token = await svc.acquireLock('worker:w1:session');
    expect(token).toBeTruthy();
    expect(token).not.toBe(REDIS_DEGRADED_TOKEN);
  });

  it('returns null when somebody else genuinely holds it', async () => {
    const svc = serviceWith({ set: jest.fn().mockResolvedValue(null) });
    await expect(svc.acquireLock('worker:w1:session')).resolves.toBeNull();
  });

  it('lets the tap through when Redis cannot be reached', async () => {
    const svc = serviceWith({
      set: jest.fn().mockRejectedValue(new Error('connect ETIMEDOUT')),
    });

    const token = await svc.acquireLock('worker:w1:session');

    // Not null: null means "another tap is in flight", which would refuse every
    // scan on the site for as long as Redis was away.
    expect(token).toBe(REDIS_DEGRADED_TOKEN);
  });

  it('does not fail the scan when the release cannot reach Redis either', async () => {
    const svc = serviceWith({
      eval: jest.fn().mockRejectedValue(new Error('connect ETIMEDOUT')),
    });
    await expect(svc.releaseLock('worker:w1:session', 'a-real-token')).resolves.toBeUndefined();
  });

  it('does not try to release a lock it never took', async () => {
    const evalFn = jest.fn();
    const svc = serviceWith({ eval: evalFn });
    await svc.releaseLock('worker:w1:session', REDIS_DEGRADED_TOKEN);
    expect(evalFn).not.toHaveBeenCalled();
  });
});
