import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { D1Service } from '../../infra/d1/d1.service';
import { chunkedWrite } from '../../infra/d1/chunked';
import { devices, notifications, pushTokens, users } from '../../infra/d1/schema.generated';
import { CryptoService } from '../../common/crypto/crypto.service';
import { MailService } from '../../common/mail/mail.service';
import { PushService } from '../../common/push/push.service';
import { Errors } from '../../common/errors/app.exception';

type UserRole = 'SUPER_ADMIN' | 'SITE_ADMIN' | 'SUPERVISOR' | 'WATCHMAN';

/** How stale "last seen" is allowed to get before it is worth a write. */
const LAST_SEEN_EVERY_MS = 60_000;

@Injectable()
export class DeviceAuthService {
  private readonly logger = new Logger(DeviceAuthService.name);

  constructor(
    private readonly d1: D1Service,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    private readonly push: PushService,
  ) {}

  /** App/browser self-registers; an admin must AUTHORIZE before it can be used. */
  async register(
    organizationId: string,
    deviceUid: string,
    platform?: string,
    label?: string,
    userId?: string,
    userRole?: UserRole,
    userName?: string,
  ) {
    const [existing] = await this.d1.db
      .select()
      .from(devices)
      .where(and(eq(devices.organizationId, organizationId), eq(devices.deviceUid, deviceUid)))
      .limit(1);

    // On re-register we deliberately DO NOT overwrite `label`: the device sends its
    // phone make/model as the initial name, but an admin may have renamed it in the
    // panel (e.g. "Gate 1 tablet") — that rename must stick across app restarts.
    const now = new Date();
    let device;
    if (existing) {
      [device] = await this.d1.db
        .update(devices)
        .set({
          ...(platform !== undefined ? { platform } : {}),
          lastSeenAt: now,
          ...(userId ? { userId } : {}),
          updatedAt: now,
        })
        .where(eq(devices.id, existing.id))
        .returning();
    } else {
      [device] = await this.d1.db
        .insert(devices)
        .values({
          id: randomUUID(),
          organizationId,
          deviceUid,
          platform: platform ?? null,
          label: label ?? null,
          status: 'PENDING',
          userId: userId ?? null,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    }

    // First sighting of a pending device → tell the people who can approve it.
    if (!existing && device.status === 'PENDING') {
      void this.notifyApprovers(organizationId, device.id, label ?? deviceUid, userRole, userName);
    }
    return { deviceId: device.id, status: device.status };
  }

  /**
   * Alert the roles allowed to approve this device: an Admin's PC needs the
   * Super Admin; watchman/safety-officer devices can be approved by either.
   */
  private async notifyApprovers(
    organizationId: string,
    deviceId: string,
    label: string,
    ownerRole?: UserRole,
    ownerName?: string,
  ) {
    try {
      const approverRoles: UserRole[] =
        ownerRole === 'SITE_ADMIN' ? ['SUPER_ADMIN'] : ['SUPER_ADMIN', 'SITE_ADMIN'];
      const title = 'New device awaiting approval';
      const body = `${ownerName ?? 'A user'} signed in on "${label}" — approve it in Devices to let them continue.`;

      await this.d1.db.insert(notifications).values({
        id: randomUUID(),
        organizationId,
        type: 'DEVICE_PENDING',
        title,
        body,
        // A text column now, so the payload is serialised rather than handed
        // over as an object — which would store "[object Object]".
        data: JSON.stringify({ deviceId, ownerRole: ownerRole ?? null }),
        createdAt: new Date(),
      });

      const approvers = await this.d1.db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(
          and(
            eq(users.organizationId, organizationId),
            eq(users.isActive, true),
            isNull(users.deletedAt),
            inArray(users.role, approverRoles),
          ),
        );
      const emails = approvers.map((u) => u.email).filter((e): e is string => !!e);
      await this.mail.send(emails, `CLAMS: ${title}`, body);

      const approverIds = approvers.map((u) => u.id);
      const tokens = approverIds.length
        ? await this.d1.db
            .select({ token: pushTokens.token })
            .from(pushTokens)
            .where(
              and(
                eq(pushTokens.organizationId, organizationId),
                inArray(pushTokens.userId, approverIds),
              ),
            )
        : [];
      const stale = await this.push.sendAlert(
        tokens.map((t) => t.token),
        { title, body, data: { deviceId } },
      );
      if (stale.length) {
        // However many FCM reported, in chunks — D1 binds at most 100
        // parameters per query.
        await chunkedWrite(stale, (batch) =>
          this.d1.db.delete(pushTokens).where(inArray(pushTokens.token, batch)),
        );
      }
    } catch (e) {
      this.logger.error(`Device-pending alert failed: ${(e as Error).message}`);
    }
  }

  /** Current approval status for a device UID (polled by pending screens). */
  async status(organizationId: string, deviceUid: string) {
    const [device] = await this.d1.db
      .select({ id: devices.id, status: devices.status })
      .from(devices)
      .where(and(eq(devices.organizationId, organizationId), eq(devices.deviceUid, deviceUid)))
      .limit(1);
    if (!device) return { deviceId: null, status: 'UNREGISTERED' as const };
    return { deviceId: device.id, status: device.status };
  }

  /**
   * Issue a device token once the device is AUTHORIZED. Only the hash is stored.
   *
   * A token the device already holds and that still verifies is handed back
   * as it is. The app asks for a token every time the attendance screen opens,
   * and replacing the hash each time broke the phone for a moment: requests
   * already carrying the old token — the scan a watchman made as the screen
   * came up — were refused with 403 until the new one was saved. The scan's
   * state check was one of them, so the confirm screen fell back to the
   * phone's own guess and offered LOGIN to a worker the server then logged out.
   */
  async issueToken(organizationId: string, deviceId: string, currentToken?: string) {
    const [device] = await this.d1.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.organizationId, organizationId)))
      .limit(1);
    if (!device) throw Errors.notFound('Device');
    if (device.status !== 'AUTHORIZED') throw Errors.deviceNotAuthorized();

    if (
      currentToken &&
      device.tokenHash &&
      (await this.crypto.verifyToken(device.tokenHash, currentToken))
    ) {
      return { deviceToken: currentToken };
    }

    const token = `${deviceId}.${randomUUID()}`;
    const tokenHash = this.crypto.hashOpaqueToken(token);
    await this.d1.db
      .update(devices)
      .set({ tokenHash, updatedAt: new Date() })
      .where(eq(devices.id, deviceId));
    return { deviceToken: token };
  }

  /**
   * Validate a presented device token (used by the device guard).
   *
   * This runs on **every authenticated request** from every non-Super-Admin, so
   * what it costs is what every screen in both apps costs. It used to verify an
   * Argon2id hash here — 64 MB and three passes, per request, on a half-core
   * container — which is why the panel and the phone crawled. The token is a
   * random UUID the server issued; SHA-256 is all that is called for.
   *
   * Hashes issued before that change still verify, and are rewritten in the new
   * format the first time they do, so the old cost is paid once per device
   * rather than once per request.
   */
  async validateToken(deviceId: string, token: string): Promise<boolean> {
    const [device] = await this.d1.db
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (!device || device.status !== 'AUTHORIZED' || !device.tokenHash) return false;

    const ok = await this.crypto.verifyToken(device.tokenHash, token);
    if (!ok) return false;

    const data: { tokenHash?: string; lastSeenAt?: Date } = {};
    if (this.crypto.isLegacyTokenHash(device.tokenHash)) {
      data.tokenHash = this.crypto.hashOpaqueToken(token);
    }
    // "Last seen" to the minute is as much as anything asks of it, and writing
    // a row on every single API call is a cost the answer does not justify.
    const now = new Date();
    if (!device.lastSeenAt || now.getTime() - device.lastSeenAt.getTime() > LAST_SEEN_EVERY_MS) {
      data.lastSeenAt = now;
    }
    if (Object.keys(data).length > 0) {
      await this.d1.db.update(devices).set(data).where(eq(devices.id, deviceId));
    }
    return true;
  }
}
