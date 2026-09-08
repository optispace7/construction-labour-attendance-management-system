import { DevicesService } from './devices.service';
import { drizzleDouble } from '../../../test/drizzle-double';
import { devices as devicesTable } from '../../infra/d1/schema.generated';

const superAdmin: any = {
  userId: 'u-super',
  organizationId: 'org-1',
  role: 'SUPER_ADMIN',
  siteScopes: [],
};
const siteAdmin: any = {
  userId: 'u-admin',
  organizationId: 'org-1',
  role: 'SITE_ADMIN',
  siteScopes: ['site-1'],
};

const gateTablet = {
  id: 'dev-1',
  organizationId: 'org-1',
  deviceUid: 'ABC-123',
  label: 'Gate 1 tablet',
  platform: 'android',
  status: 'AUTHORIZED',
  user: null,
};

function build(over: any = {}) {
  // `in`, not `??` — a test that passes `device: null` means "not found".
  const device = 'device' in over ? over.device : gateTablet;
  const taps = over.taps ?? 1247;

  // The service reads the device with its owner's role joined, so the double
  // answers with the row shape that join produces.
  const double = drizzleDouble([], {});
  const order: string[] = [];
  double.db.then = jest.fn((resolve: (rows: any[]) => unknown) =>
    Promise.resolve(device ? [{ device, ownerRole: device.user?.role ?? null }] : []).then(
      resolve,
    ),
  ) as any;
  double.db.update = jest.fn((t: unknown) => {
    // Only an update to devices is the pre-delete revoke. The stamp inside the
    // batch is an update too, on attendance_taps, and counting it here made
    // the ordering assertion see a revoke that never happened.
    if (t === devicesTable) order.push('revoke');
    double.writes.push({ kind: 'update', table: t });
    return double.db;
  }) as any;
  double.db.batch = jest.fn((stmts: unknown[]) => {
    order.push('stamp', 'delete');
    return Promise.resolve((stmts ?? []).map(() => ({ meta: { changes: taps } })));
  }) as any;

  const audit: any = { record: jest.fn() };
  const d1: any = { db: double.db, d1: {} };
  return { svc: new DevicesService(d1, audit), db: double.db, audit, order, double };
}

describe('DevicesService.remove', () => {
  it('deletes a device that has marked attendance, keeping its name on the punches', async () => {
    const { svc, db } = build();

    const res = await svc.remove(superAdmin, 'dev-1');

    expect(res).toEqual({ deleted: true, punchesStamped: 1247 });
    // The stamp and the delete go together in one batch — that is the point of
    // them being a batch, so the assertion is that both were in it.
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ deviceLabel: 'Gate 1 tablet' }));
  });

  it('revokes before it deletes, so a failed delete leaves the device locked out', async () => {
    const { svc, order, db } = build();

    await svc.remove(superAdmin, 'dev-1');

    expect(order).toEqual(['revoke', 'stamp', 'delete']);
    expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'REVOKED' }));
  });

  it('does not revoke again when the device was already revoked', async () => {
    const { svc, order, db } = build({ device: { ...gateTablet, status: 'REVOKED' } });
    await svc.remove(superAdmin, 'dev-1');
    expect(order).not.toContain('revoke');
    expect(db.batch).toHaveBeenCalled();
  });

  it('falls back to the device uid when nobody ever named it', async () => {
    const { svc, db } = build({ device: { ...gateTablet, label: '   ' } });
    await svc.remove(superAdmin, 'dev-1');
    expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ deviceLabel: 'ABC-123' }));
  });

  it('records what was kept, and how much of it, in the audit trail', async () => {
    const { svc, audit } = build();
    await svc.remove(superAdmin, 'dev-1');

    const del = audit.record.mock.calls.find((c: any[]) => c[0].action === 'DEVICE_DELETE');
    expect(del[0].newValue).toEqual({ keptName: 'Gate 1 tablet', punchesStamped: 1247 });
    // The automatic revoke is its own row, not folded into the delete.
    const rev = audit.record.mock.calls.find((c: any[]) => c[0].action === 'DEVICE_UPDATE');
    expect(rev[0]).toMatchObject({ newValue: { status: 'REVOKED' } });
  });

  it("still refuses to let a Site Admin delete an Admin's own device", async () => {
    const { svc, db, order } = build({
      device: { ...gateTablet, user: { role: 'SITE_ADMIN' } },
    });

    await expect(svc.remove(siteAdmin, 'dev-1')).rejects.toMatchObject({ status: 403 });
    expect(db.batch).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it('404s for a device belonging to another organization', async () => {
    const { svc, db } = build({ device: null });
    await expect(svc.remove(superAdmin, 'dev-1')).rejects.toMatchObject({ status: 404 });
    expect(db.batch).not.toHaveBeenCalled();
  });
});
