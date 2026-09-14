import { DeviceAuthService } from './device-auth.service';
import { CryptoService } from '../../common/crypto/crypto.service';

/**
 * The app asks for a device token every time the attendance screen opens.
 * Replacing the stored hash on each ask made the token the phone was already
 * using fail mid-flight: a scan made as the screen came up had its state check
 * refused with 403, and the confirm screen showed the phone's own guess — LOGIN
 * for a worker the server then recorded as logging out.
 */

// The constructor needs a key for the field-encryption half of the service;
// nothing here touches it.
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const crypto = new CryptoService();
const ORG_ID = 'b0c1d2e3-0000-4000-8000-000000000002';
const DEVICE_ID = 'a2f1c0de-0000-4000-8000-000000000001';
const TOKEN = `${DEVICE_ID}.6f8b1c22-2f3e-4d1a-9b0a-7c9d5f9e1234`;

function build(device: Record<string, unknown> | null) {
  // A Drizzle chain: every call returns itself, awaiting resolves to the row.
  const db: any = {
    select: () => db,
    from: () => db,
    where: () => db,
    limit: () => db,
    update: () => db,
    then: (resolve: (rows: unknown[]) => unknown) =>
      Promise.resolve(device ? [device] : []).then(resolve),
  };
  db.set = jest.fn(() => db);
  const svc = new DeviceAuthService({ db, d1: {} } as never, crypto, {} as never, {} as never);
  return { svc, set: db.set };
}

const authorized = (over: Record<string, unknown> = {}) => ({
  id: DEVICE_ID,
  organizationId: ORG_ID,
  status: 'AUTHORIZED',
  tokenHash: crypto.hashOpaqueToken(TOKEN),
  ...over,
});

describe('DeviceAuthService.issueToken', () => {
  it('hands back a token that still works instead of replacing it', async () => {
    const { svc, set } = build(authorized());
    await expect(svc.issueToken(ORG_ID, DEVICE_ID, TOKEN)).resolves.toEqual({
      deviceToken: TOKEN,
    });
    expect(set).not.toHaveBeenCalled();
  });

  it('issues a new token when the device holds none', async () => {
    const { svc, set } = build(authorized());
    const { deviceToken } = await svc.issueToken(ORG_ID, DEVICE_ID);
    expect(deviceToken).not.toBe(TOKEN);
    expect(deviceToken.startsWith(`${DEVICE_ID}.`)).toBe(true);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: crypto.hashOpaqueToken(deviceToken) }),
    );
  });

  it('replaces a token that no longer verifies', async () => {
    const { svc, set } = build(authorized());
    const { deviceToken } = await svc.issueToken(ORG_ID, DEVICE_ID, `${DEVICE_ID}.stale`);
    expect(deviceToken).not.toBe(`${DEVICE_ID}.stale`);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: crypto.hashOpaqueToken(deviceToken) }),
    );
  });

  it('issues a token when a revoked device was re-approved and has no hash', async () => {
    const { svc, set } = build(authorized({ tokenHash: null }));
    const { deviceToken } = await svc.issueToken(ORG_ID, DEVICE_ID, TOKEN);
    expect(deviceToken).not.toBe(TOKEN);
    expect(set).toHaveBeenCalled();
  });

  it('still refuses a device that is not authorized, whatever token it sends', async () => {
    const { svc, set } = build(authorized({ status: 'PENDING' }));
    await expect(svc.issueToken(ORG_ID, DEVICE_ID, TOKEN)).rejects.toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });
});
