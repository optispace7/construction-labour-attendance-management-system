import { createRedisClient } from './redis-client.workers';

/**
 * The REST client stands in for ioredis on the serverless runtime, so what
 * matters is that it answers the way RedisService already expects — including
 * when it cannot answer at all, because that path is what keeps the gate open
 * during an outage rather than refusing every scan.
 */
describe('Upstash REST redis client', () => {
  const URL = 'https://example.upstash.io';
  const TOKEN = 'a-token';
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
    fetchMock = jest.fn();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  const reply = (body: unknown, ok = true, status = 200) => ({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });

  it('sends SET with the arguments Redis expects, and the token', async () => {
    fetchMock.mockResolvedValue(reply({ result: 'OK' }));
    const client = createRedisClient();

    await expect(client.set('worker:w1:session', 'tok', 'PX', 5000, 'NX')).resolves.toBe('OK');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    // Every argument is sent as a string; Upstash rejects a bare number.
    expect(JSON.parse(init.body as string)).toEqual([
      'SET', 'worker:w1:session', 'tok', 'PX', '5000', 'NX',
    ]);
  });

  it('reads a null reply as the lock being held by somebody else', async () => {
    // NX found the key already there. RedisService turns this into "another
    // tap is being processed", which is the one case where refusing is right.
    fetchMock.mockResolvedValue(reply({ result: null }));
    const client = createRedisClient();
    await expect(client.set('k', 'v', 'PX', 5000, 'NX')).resolves.toBeNull();
  });

  it('rejects when the credentials are missing, rather than pretending', async () => {
    // A missing secret must look like an outage, which RedisService already
    // handles by letting the tap through — not like a lock nobody can take.
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const client = createRedisClient();
    await expect(client.set('k', 'v', 'PX', 5000, 'NX')).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects on an error in the reply body', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'WRONGTYPE' }));
    const client = createRedisClient();
    await expect(client.set('k', 'v', 'PX', 5000, 'NX')).rejects.toThrow(/WRONGTYPE/);
  });

  it('rejects with the body when the response is not ok and not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve('<html>bad gateway</html>'),
      json: () => Promise.reject(new Error('not json')),
    });
    const client = createRedisClient();
    await expect(client.set('k', 'v', 'PX', 5000, 'NX')).rejects.toThrow(/502/);
  });

  it('passes EVAL through for the release script', async () => {
    fetchMock.mockResolvedValue(reply({ result: 1 }));
    const client = createRedisClient();
    await client.eval('return 1', 1, 'k', 'tok');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual([
      'EVAL', 'return 1', '1', 'k', 'tok',
    ]);
  });

  it('has no connection to close or listen to', () => {
    const client = createRedisClient();
    expect(() => client.on('error', () => {})).not.toThrow();
    expect(() => client.disconnect()).not.toThrow();
    return expect(client.quit()).resolves.toBeUndefined();
  });
});
