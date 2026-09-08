import { Injectable } from '@nestjs/common';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { D1Service } from '../../infra/d1/d1.service';
import { attendanceTaps, devices, users } from '../../infra/d1/schema.generated';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';

type DeviceStatus = 'PENDING' | 'AUTHORIZED' | 'REVOKED';

@Injectable()
export class DevicesService {
  constructor(
    private readonly d1: D1Service,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, siteId?: string, status?: DeviceStatus) {
    const filters: SQL[] = [eq(devices.organizationId, user.organizationId)];
    if (siteId) filters.push(eq(devices.siteId, siteId));
    if (status) filters.push(eq(devices.status, status));

    const rows = await this.d1.db
      .select({
        device: devices,
        userId: users.id,
        userFullName: users.fullName,
        userRole: users.role,
      })
      .from(devices)
      // Left, not inner: a device registered before its user was deleted still
      // has to appear in the list, and an inner join would hide it.
      .leftJoin(users, eq(users.id, devices.userId))
      .where(and(...filters))
      .orderBy(desc(devices.createdAt));

    // Rebuilt into the nested shape Prisma's include produced, so the panel is
    // unchanged.
    return rows.map((r) => ({
      ...r.device,
      user: r.userId ? { id: r.userId, fullName: r.userFullName, role: r.userRole } : null,
    }));
  }

  /** A device with the owning user's role, which the guards below turn on. */
  private async findWithOwner(user: AuthUser, id: string) {
    const [row] = await this.d1.db
      .select({ device: devices, ownerRole: users.role })
      .from(devices)
      .leftJoin(users, eq(users.id, devices.userId))
      .where(and(eq(devices.id, id), eq(devices.organizationId, user.organizationId)))
      .limit(1);
    if (!row) throw Errors.notFound('Device');
    return row;
  }

  async update(
    user: AuthUser,
    id: string,
    data: { status?: DeviceStatus; siteId?: string; label?: string },
  ) {
    const { device, ownerRole } = await this.findWithOwner(user, id);

    // An Admin's own PC/browser can only be approved (or revoked) by the
    // Super Admin — admins must not self-approve their logins.
    if (
      data.status &&
      data.status !== device.status &&
      ownerRole === 'SITE_ADMIN' &&
      user.role !== 'SUPER_ADMIN'
    ) {
      throw Errors.forbidden("Only the Super Admin can approve an Admin's device.");
    }

    // An empty rename clears the label so the UI falls back to the device UID.
    const nextLabel = data.label !== undefined ? data.label.trim() || null : undefined;

    const [updated] = await this.d1.db
      .update(devices)
      .set({
        ...(data.status !== undefined ? { status: data.status } : {}),
        siteId: data.siteId ?? device.siteId,
        ...(nextLabel !== undefined ? { label: nextLabel } : {}),
        ...(data.status === 'AUTHORIZED'
          ? { authorizedBy: user.userId, authorizedAt: new Date() }
          : {}),
        ...(data.status === 'REVOKED' ? { tokenHash: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(devices.id, id))
      .returning();

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'DEVICE_UPDATE',
      entityType: 'Device',
      entityId: id,
      oldValue: { status: device.status, siteId: device.siteId, label: device.label },
      newValue: { status: updated.status, siteId: updated.siteId, label: updated.label },
    });

    return updated;
  }

  /**
   * Delete a device — a tablet that has been retired, lost or replaced, as well
   * as the test phone somebody registered by mistake.
   *
   * A device that has marked attendance used to be refused, because
   * AttendanceTap.deviceId is SET NULL on delete and deleting would have
   * stripped the device off every punch it ever took. The punches themselves
   * were never at risk — only the record of which device made them — so the
   * name is copied onto those punches first and then the row goes. "Which
   * device took this" outlives the device.
   *
   * Revoked before deleted, in that order and never the reverse: revoking is
   * what kills the device's token. If the delete then fails on anything, the
   * device is already locked out rather than still able to mark attendance.
   */
  async remove(user: AuthUser, id: string) {
    const { device, ownerRole } = await this.findWithOwner(user, id);

    // Same guard as approval: an Admin's device is the Super Admin's to manage.
    if (ownerRole === 'SITE_ADMIN' && user.role !== 'SUPER_ADMIN') {
      throw Errors.forbidden("Only the Super Admin can delete an Admin's device.");
    }

    // The name the punches will keep. A device nobody ever named has only its
    // uid, which is still better than an empty column.
    const keptName = device.label?.trim() || device.deviceUid;

    if (device.status !== 'REVOKED') {
      await this.d1.db
        .update(devices)
        .set({ status: 'REVOKED', tokenHash: null, updatedAt: new Date() })
        .where(eq(devices.id, id));
      await this.audit.record({
        organizationId: user.organizationId,
        actorUserId: user.userId,
        actorRole: user.role,
        action: 'DEVICE_UPDATE',
        entityType: 'Device',
        entityId: id,
        oldValue: { status: device.status },
        newValue: { status: 'REVOKED' },
        reason: 'Revoked automatically before deletion',
      });
    }

    // Stamping the name onto the punches and removing the row go together: a
    // delete that landed without the stamp would leave those punches with
    // neither a device nor a name for one.
    const stamp = this.d1.db
      .update(attendanceTaps)
      .set({ deviceLabel: keptName })
      .where(eq(attendanceTaps.deviceId, id));
    const results = (await this.d1.db.batch([
      stamp,
      this.d1.db.delete(devices).where(eq(devices.id, id)),
    ] as never)) as unknown as { meta?: { changes?: number } }[];

    const punchesStamped = results[0]?.meta?.changes ?? 0;

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'DEVICE_DELETE',
      entityType: 'Device',
      entityId: id,
      oldValue: {
        deviceUid: device.deviceUid,
        label: device.label,
        status: device.status,
        platform: device.platform,
      },
      // How many punches now carry the name instead of the link, so the trail
      // says what became of them.
      newValue: { keptName, punchesStamped },
    });

    return { deleted: true, punchesStamped };
  }
}
