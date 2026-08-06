import { Injectable } from '@nestjs/common';
import { DeviceStatus } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, siteId?: string, status?: DeviceStatus) {
    return this.prisma.device.findMany({
      where: {
        organizationId: user.organizationId,
        ...(siteId ? { siteId } : {}),
        ...(status ? { status } : {}),
      },
      include: { user: { select: { id: true, fullName: true, role: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(
    user: AuthUser,
    id: string,
    data: { status?: DeviceStatus; siteId?: string; label?: string },
  ) {
    const device = await this.prisma.device.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { user: { select: { role: true } } },
    });
    if (!device) throw Errors.notFound('Device');

    // An Admin's own PC/browser can only be approved (or revoked) by the
    // Super Admin — admins must not self-approve their logins.
    if (
      data.status &&
      data.status !== device.status &&
      device.user?.role === 'SITE_ADMIN' &&
      user.role !== 'SUPER_ADMIN'
    ) {
      throw Errors.forbidden("Only the Super Admin can approve an Admin's device.");
    }

    // An empty rename clears the label so the UI falls back to the device UID.
    const nextLabel = data.label !== undefined ? data.label.trim() || null : undefined;

    const updated = await this.prisma.device.update({
      where: { id },
      data: {
        status: data.status,
        siteId: data.siteId ?? device.siteId,
        ...(nextLabel !== undefined ? { label: nextLabel } : {}),
        ...(data.status === 'AUTHORIZED'
          ? { authorizedBy: user.userId, authorizedAt: new Date() }
          : {}),
        ...(data.status === 'REVOKED' ? { tokenHash: null } : {}),
      },
    });

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
    const device = await this.prisma.device.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { user: { select: { role: true } } },
    });
    if (!device) throw Errors.notFound('Device');

    // Same guard as approval: an Admin's device is the Super Admin's to manage.
    if (device.user?.role === 'SITE_ADMIN' && user.role !== 'SUPER_ADMIN') {
      throw Errors.forbidden("Only the Super Admin can delete an Admin's device.");
    }

    // The name the punches will keep. A device nobody ever named has only its
    // uid, which is still better than an empty column.
    const keptName = device.label?.trim() || device.deviceUid;

    if (device.status !== 'REVOKED') {
      await this.prisma.device.update({ where: { id }, data: { status: 'REVOKED' } });
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

    const stamped = await this.prisma.attendanceTap.updateMany({
      where: { deviceId: id },
      data: { deviceLabel: keptName },
    });

    await this.prisma.device.delete({ where: { id } });

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
      newValue: { keptName, punchesStamped: stamped.count },
    });

    return { deleted: true, punchesStamped: stamped.count };
  }
}
