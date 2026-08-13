import { DeviceAuthService } from './device-auth.service';
import { CryptoService } from '../../common/crypto/crypto.service';

/**
 * The device guard calls validateToken on every authenticated request from
 * every non-Super-Admin, so anything it does, both apps do constantly. It was
 * verifying an Argon2id hash and writing a row each time.
 */

// The constructor needs a key for the field-encryption half of the service;
// nothing here touches it.
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const crypto = new CryptoService();
const DEVICE_ID = 'a2f1c0de-0000-4000-8000-000000000001';
const TOKEN = `${DEVICE_ID}.6f8b1c22-2f3e-4d1a-9b0a-7c9d5f9e1234`;

function build(device: Record<string, unknown> | null) {
  const update = jest.fn().mockResolvedValue({});
  const prisma: any = { device: { findUnique: jest.fn().mockResolvedValue(device), update } };
  const svc = new DeviceAuthService(prisma, crypto, {} as never, {} as never);
  return { svc, update, prisma };
}

const authorized = (over: Record<string, unknown> = {}) => ({
  id: DEVICE_ID,
  status: 'AUTHORIZED',
  tokenHash: crypto.hashOpaqueToken(TOKEN),
  lastSeenAt: new Date(),
  ...over,
});

describe('DeviceAuthService.validateToken', () => {
  it('accepts a good token', async () => {
    const { svc } = build(authorized());
    await expect(svc.validateToken(DEVICE_ID, TOKEN)).resolves.toBe(true);
  });

  it('refuses a bad token, an unknown device and a revoked one', async () => {
    const bad = build(authorized());
    await expect(bad.svc.validateToken(DEVICE_ID, 'nope')).resolves.toBe(false);

    const missing = build(null);
    await expect(missing.svc.validateToken(DEVICE_ID, TOKEN)).resolves.toBe(false);

    const revoked = build(authorized({ status: 'REVOKED' }));
    await expect(revoked.svc.validateToken(DEVICE_ID, TOKEN)).resolves.toBe(false);
  });

  it('does not write a row on every request', async () => {
    // lastSeenAt was updated on each call — a write per API request, for a
    // figure nobody reads to the second.
    const { svc, update } = build(authorized({ lastSeenAt: new Date() }));
    await svc.validateToken(DEVICE_ID, TOKEN);
    expect(update).not.toHaveBeenCalled();
  });

  it('does refresh last seen once it has gone stale', async () => {
    const { svc, update } = build(authorized({ lastSeenAt: new Date(Date.now() - 5 * 60_000) }));
    await svc.validateToken(DEVICE_ID, TOKEN);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastSeenAt: expect.any(Date) }) }),
    );
  });

  it('rewrites a legacy hash the first time it is used', async () => {
    const argon2 = await import('argon2');
    const legacy = await argon2.hash(TOKEN, { type: argon2.argon2id });
    const { svc, update } = build(authorized({ tokenHash: legacy, lastSeenAt: new Date() }));

    await expect(svc.validateToken(DEVICE_ID, TOKEN)).resolves.toBe(true);

    // Upgraded in place, so the expensive hash is paid once per device rather
    // than once per request — and the phone never has to re-register.
    const written = update.mock.calls[0][0].data.tokenHash as string;
    expect(crypto.isLegacyTokenHash(written)).toBe(false);
    await expect(crypto.verifyToken(written, TOKEN)).resolves.toBe(true);
  });
});
