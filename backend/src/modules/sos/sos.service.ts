import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gt, isNotNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { D1Service } from '../../infra/d1/d1.service';
import { devices, organizations, sites, sosEvents } from '../../infra/d1/schema.generated';
import { MailService } from '../../common/mail/mail.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { NotificationsService } from '../notifications/notifications.service';
import { PushService } from '../../common/push/push.service';
import { distanceMeters } from '../attendance/engine/tap-decision';
import { TriggerSosDto } from './dto/sos.dto';

const MAX_SITE_MATCH_METERS = 10_000; // GPS → nearest site within 10 km

@Injectable()
export class SosService {
  private readonly logger = new Logger(SosService.name);

  constructor(
    private readonly d1: D1Service,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
  ) {}

  /**
   * PUBLIC endpoint — works without login so the SOS button is usable from the
   * app's login screen. Site is resolved from (1) the phone's last-selected
   * siteId, then (2) GPS proximity to site coordinates, then (3) the device's
   * registered site.
   */
  async trigger(dto: TriggerSosDto) {
    // Short per-device cooldown so a stuck/abused button can't flood alerts,
    // but a responder can re-raise quickly if the first wasn't acknowledged.
    if (dto.deviceUid) {
      const [recent] = await this.d1.db
        .select({ id: sosEvents.id })
        .from(sosEvents)
        .where(
          and(
            eq(sosEvents.deviceUid, dto.deviceUid),
            gt(sosEvents.createdAt, new Date(Date.now() - 15_000)),
          ),
        )
        .limit(1);
      if (recent) throw Errors.rateLimited();
    }

    let site: { id: string; name: string; organizationId: string } | null = null;

    if (dto.siteId) {
      [site] = await this.d1.db
        .select({ id: sites.id, name: sites.name, organizationId: sites.organizationId })
        .from(sites)
        .where(and(eq(sites.id, dto.siteId), eq(sites.isActive, true)))
        .limit(1);
    }

    if (!site && dto.latitude != null && dto.longitude != null) {
      const candidates = await this.d1.db
        .select({
          id: sites.id,
          name: sites.name,
          organizationId: sites.organizationId,
          latitude: sites.latitude,
          longitude: sites.longitude,
        })
        .from(sites)
        .where(
          and(eq(sites.isActive, true), isNotNull(sites.latitude), isNotNull(sites.longitude)),
        );
      let best: { site: (typeof candidates)[number]; dist: number } | null = null;
      for (const c of candidates) {
        const dist = distanceMeters(c.latitude!, c.longitude!, dto.latitude, dto.longitude);
        if (dist <= MAX_SITE_MATCH_METERS && (!best || dist < best.dist)) best = { site: c, dist };
      }
      if (best) site = best.site;
    }

    let device: { organizationId: string; siteId: string | null } | null = null;
    if (!site && dto.deviceUid) {
      [device] = await this.d1.db
        .select({ organizationId: devices.organizationId, siteId: devices.siteId })
        .from(devices)
        .where(eq(devices.deviceUid, dto.deviceUid))
        .limit(1);
      if (device?.siteId) {
        [site] = await this.d1.db
          .select({ id: sites.id, name: sites.name, organizationId: sites.organizationId })
          .from(sites)
          .where(eq(sites.id, device.siteId))
          .limit(1);
      }
    }

    const [anyOrg] =
      site || device
        ? []
        : await this.d1.db
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.isActive, true))
            .limit(1);
    const organizationId = site?.organizationId ?? device?.organizationId ?? anyOrg?.id;
    if (!organizationId) throw Errors.notFound('Organization');

    const [event] = await this.d1.db
      .insert(sosEvents)
      .values({
        id: randomUUID(),
        organizationId,
        siteId: site?.id ?? null,
        siteName: site?.name ?? null,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        geoAccuracyM: dto.accuracyM ?? null,
        deviceUid: dto.deviceUid ?? null,
        deviceName: dto.deviceName ?? null,
        senderName: dto.senderName ?? null,
        senderRole: dto.senderRole ?? null,
        senderEmail: dto.senderEmail ?? null,
        message: dto.message ?? null,
        createdAt: new Date(),
      })
      .returning();

    const where = site?.name ?? 'Unknown location';
    const mapsLink =
      dto.latitude != null && dto.longitude != null
        ? `https://maps.google.com/?q=${dto.latitude},${dto.longitude}`
        : null;

    // "Sent by Ramu (Safety Officer, ramu@x.com)" when logged in; otherwise the
    // phone is all we know.
    const roleLabel = dto.senderRole === 'SUPERVISOR' ? 'Safety Officer' : dto.senderRole;
    const senderLine = dto.senderName
      ? `Sent by: ${dto.senderName}` +
        (roleLabel || dto.senderEmail
          ? ` (${[roleLabel, dto.senderEmail].filter(Boolean).join(', ')})`
          : '')
      : `Sent from a logged-out device`;
    const phoneLine = dto.deviceName ? `Phone: ${dto.deviceName}` : null;

    const title = `🚨 SOS — ${where}`;
    const body = [
      `Emergency reported at ${where}.`,
      senderLine,
      phoneLine,
      mapsLink ? `Location: ${mapsLink}` : null,
      dto.message ? `Message: ${dto.message}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    await this.notifications.create({
      organizationId,
      type: 'SOS',
      title,
      body,
      siteId: site?.id ?? null,
      // Carry the sender's device/email so a receiver can avoid alarming the
      // very device (or person) that raised the SOS.
      data: {
        sosEventId: event.id,
        senderDeviceUid: dto.deviceUid ?? null,
        senderEmail: dto.senderEmail ?? null,
      },
    });

    // Push to every registered device in the org (except the sender's), so the
    // alert rings even when the app is closed. No-op if push isn't configured.
    void (async () => {
      const tokens = await this.notifications.sosTokens(organizationId, dto.deviceUid);
      const stale = await this.push.sendSos(tokens, { title, body, sosEventId: event.id });
      await this.notifications.pruneTokens(stale);
    })().catch((e) => this.logger.error(`SOS push failed: ${(e as Error).message}`));

    // Email all admins + safety officers; never block the SOS response on it.
    void (async () => {
      const emails = await this.notifications.alertEmails(organizationId);
      await this.mail.send(
        emails,
        `🚨 CLAMS SOS — ${where}`,
        [
          `An SOS was triggered at ${new Date().toISOString()}.`,
          `Site: ${where}`,
          senderLine,
          phoneLine,
          mapsLink ? `Location: ${mapsLink}` : 'Location: not available',
          dto.message ? `Message: ${dto.message}` : null,
          dto.deviceUid ? `Device UID: ${dto.deviceUid}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    })().catch((e) => this.logger.error(`SOS email failed: ${(e as Error).message}`));

    return { ok: true, sosEventId: event.id, site: site?.name ?? null };
  }

  list(user: AuthUser) {
    return this.d1.db
      .select()
      .from(sosEvents)
      .where(eq(sosEvents.organizationId, user.organizationId))
      .orderBy(desc(sosEvents.createdAt))
      .limit(50);
  }

  async acknowledge(user: AuthUser, id: string) {
    const [event] = await this.d1.db
      .select()
      .from(sosEvents)
      .where(and(eq(sosEvents.id, id), eq(sosEvents.organizationId, user.organizationId)))
      .limit(1);
    if (!event) throw Errors.notFound('SOS event');
    const [updated] = await this.d1.db
      .update(sosEvents)
      .set({ acknowledgedBy: user.userId, acknowledgedAt: new Date() })
      .where(eq(sosEvents.id, id))
      .returning();
    return updated;
  }
}
