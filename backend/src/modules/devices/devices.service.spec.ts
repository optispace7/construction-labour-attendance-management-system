import { DevicesService } from './devices.service';

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
  const prisma: any = {
    device: {
      // `in`, not `??` — a test that passes `device: null` means "not found".
      findFirst: jest.fn().mockResolvedValue('device' in over ? over.device : gateTablet),
      update: jest.fn().mockResolvedValue({ ...gateTablet, status: 'REVOKED' }),
      delete: jest.fn().mockResolvedValue({ id: 'dev-1' }),
    },
    attendanceTap: {
      updateMany: jest.fn().mockResolvedValue({ count: over.taps ?? 1247 }),
      count: jest.fn().mockResolvedValue(over.taps ?? 1247),
    },
  };
  const audit: any = { record: jest.fn() };
  return { svc: new DevicesService(prisma, audit), prisma, audit };
}

describe('DevicesService.remove', () => {
  it('deletes a device that has marked attendance, keeping its name on the punches', async () => {
    const { svc, prisma } = build();

    const res = await svc.remove(superAdmin, 'dev-1');

    expect(res).toEqual({ deleted: true, punchesStamped: 1247 });
    expect(prisma.attendanceTap.updateMany).toHaveBeenCalledWith({
      where: { deviceId: 'dev-1' },
      data: { deviceLabel: 'Gate 1 tablet' },
    });
    expect(prisma.device.delete).toHaveBeenCalledWith({ where: { id: 'dev-1' } });
  });

  it('revokes before it deletes, so a failed delete leaves the device locked out', async () => {
    const { svc, prisma } = build();
    const order: string[] = [];
    prisma.device.update.mockImplementation(async () => {
      order.push('revoke');
      return { ...gateTablet, status: 'REVOKED' };
    });
    prisma.attendanceTap.updateMany.mockImplementation(async () => {
      order.push('stamp');
      return { count: 1247 };
    });
    prisma.device.delete.mockImplementation(async () => {
      order.push('delete');
      return { id: 'dev-1' };
    });

    await svc.remove(superAdmin, 'dev-1');

    expect(order).toEqual(['revoke', 'stamp', 'delete']);
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'dev-1' },
      data: { status: 'REVOKED' },
    });
  });

  it('does not revoke again when the device was already revoked', async () => {
    const { svc, prisma } = build({ device: { ...gateTablet, status: 'REVOKED' } });
    await svc.remove(superAdmin, 'dev-1');
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(prisma.device.delete).toHaveBeenCalled();
  });

  it('falls back to the device uid when nobody ever named it', async () => {
    const { svc, prisma } = build({ device: { ...gateTablet, label: '   ' } });
    await svc.remove(superAdmin, 'dev-1');
    expect(prisma.attendanceTap.updateMany.mock.calls[0][0].data).toEqual({
      deviceLabel: 'ABC-123',
    });
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
    const { svc, prisma } = build({
      device: { ...gateTablet, user: { role: 'SITE_ADMIN' } },
    });

    await expect(svc.remove(siteAdmin, 'dev-1')).rejects.toMatchObject({ status: 403 });
    expect(prisma.device.delete).not.toHaveBeenCalled();
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it('404s for a device belonging to another organization', async () => {
    const { svc, prisma } = build({ device: null });
    await expect(svc.remove(superAdmin, 'dev-1')).rejects.toMatchObject({ status: 404 });
    expect(prisma.device.delete).not.toHaveBeenCalled();
  });
});
