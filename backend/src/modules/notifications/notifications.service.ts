import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNotNull, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { D1Service } from '../../infra/d1/d1.service';
import { notifications, pushTokens, users } from '../../infra/d1/schema.generated';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';

type UserRole = 'SUPER_ADMIN' | 'SITE_ADMIN' | 'SUPERVISOR' | 'WATCHMAN';

const ALERT_ROLES: UserRole[] = ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'];

@Injectable()
export class NotificationsService {
  constructor(private readonly d1: D1Service) {}

  async create(input: {
    organizationId: string;
    type: string;
    title: string;
    body: string;
    siteId?: string | null;
    data?: unknown;
  }) {
    const [row] = await this.d1.db
      .insert(notifications)
      .values({
        id: randomUUID(),
        organizationId: input.organizationId,
        type: input.type,
        title: input.title,
        body: input.body,
        siteId: input.siteId ?? null,
        // Serialised here: the column is text on SQLite, and handing it an
        // object stores "[object Object]".
        data: input.data === undefined ? null : JSON.stringify(input.data),
        createdAt: new Date(),
      })
      .returning();
    return parseData(row);
  }

  /** Polling feed for the admin panel and the mobile app. */
  async list(user: AuthUser, since?: string, type?: string) {
    const filters: SQL[] = [eq(notifications.organizationId, user.organizationId)];
    if (since) filters.push(gt(notifications.createdAt, new Date(since)));
    if (type) filters.push(eq(notifications.type, type));

    const rows = await this.d1.db
      .select()
      .from(notifications)
      .where(and(...filters))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    return rows.map(parseData);
  }

  async markRead(user: AuthUser, id: string) {
    const [n] = await this.d1.db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.id, id), eq(notifications.organizationId, user.organizationId)),
      )
      .limit(1);
    if (!n) throw Errors.notFound('Notification');

    const [updated] = await this.d1.db
      .update(notifications)
      .set({ readAt: new Date(), readBy: user.userId })
      .where(eq(notifications.id, id))
      .returning();
    return parseData(updated);
  }

  /** Register (or refresh) an FCM device token for the current user/device. */
  async registerPushToken(
    user: AuthUser,
    input: { token: string; deviceUid?: string; platform?: string },
  ) {
    const now = new Date();
    const [row] = await this.d1.db
      .insert(pushTokens)
      .values({
        id: randomUUID(),
        organizationId: user.organizationId,
        userId: user.userId,
        deviceUid: input.deviceUid ?? null,
        token: input.token,
        platform: input.platform ?? null,
        createdAt: now,
        updatedAt: now,
      })
      // The token is what identifies the row — the same handset re-registering
      // must update rather than accumulate, or every alert goes out twice.
      .onConflictDoUpdate({
        target: pushTokens.token,
        set: {
          organizationId: user.organizationId,
          userId: user.userId,
          deviceUid: input.deviceUid ?? null,
          platform: input.platform ?? null,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  }

  /**
   * Push tokens to alert for an SOS — everyone in the org except the sender's
   * device. Filtered in code so tokens with a NULL deviceUid are still alerted
   * (a SQL `deviceUid != x` would silently drop NULL rows).
   */
  async sosTokens(organizationId: string, excludeDeviceUid?: string | null): Promise<string[]> {
    const rows = await this.d1.db
      .select({ token: pushTokens.token, deviceUid: pushTokens.deviceUid })
      .from(pushTokens)
      .where(eq(pushTokens.organizationId, organizationId));
    return rows
      .filter((r) => !excludeDeviceUid || r.deviceUid !== excludeDeviceUid)
      .map((r) => r.token);
  }

  /** Drop tokens FCM reported as no longer valid. */
  async pruneTokens(tokens: string[]) {
    if (tokens.length === 0) return;
    await this.d1.db.delete(pushTokens).where(inArray(pushTokens.token, tokens));
  }

  /** Emails of active users in the given roles (defaults to admins + safety officers). */
  async alertEmails(organizationId: string, roles: UserRole[] = ALERT_ROLES): Promise<string[]> {
    const rows = await this.d1.db
      .select({ email: users.email })
      .from(users)
      .where(
        and(
          eq(users.organizationId, organizationId),
          eq(users.isActive, true),
          isNotNull(users.email),
          inArray(users.role, roles),
        ),
      );
    return rows.map((u) => u.email).filter((e): e is string => !!e);
  }
}

/** The payload back as an object, which is what callers were always given. */
function parseData<T extends { data: string | null }>(row: T) {
  if (!row) return row;
  let data: unknown = null;
  if (row.data != null) {
    try {
      data = JSON.parse(row.data);
    } catch {
      data = null;
    }
  }
  return { ...row, data };
}
