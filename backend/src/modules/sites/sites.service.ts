import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { D1Service } from '../../infra/d1/d1.service';
import {
  shifts,
  siteSettings,
  sites,
  userSiteScopes,
} from '../../infra/d1/schema.generated';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { assertSiteInScope } from '../../common/auth/scope.util';
import { Errors } from '../../common/errors/app.exception';
import { isOvernight, parseTimeOfDay, textToTimeOfDay, timeOfDayToText } from '../../common/time/time.util';
import {
  CreateShiftDto,
  CreateSiteDto,
  UpdateShiftDto,
  UpdateSiteDto,
  UpdateSiteSettingsDto,
} from './dto/site.dto';

type SiteInsert = typeof sites.$inferInsert;
type SettingsInsert = typeof siteSettings.$inferInsert;

@Injectable()
export class SitesService {
  constructor(
    private readonly d1: D1Service,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, active?: boolean) {
    // Read scopes fresh from the database rather than from the token, which is
    // stale for as long as the session lasts — an assignment change has to show
    // up in the app straight away.
    const scoped = await this.freshSiteScope(user);
    const filters: SQL[] = [eq(sites.organizationId, user.organizationId)];
    if (scoped) filters.push(inArray(sites.id, scoped));
    if (active !== undefined) filters.push(eq(sites.isActive, active));

    return this.d1.db
      .select()
      .from(sites)
      .where(and(...filters))
      .orderBy(asc(sites.name));
  }

  /** Site ids the user is limited to, or null meaning "no limit". */
  private async freshSiteScope(user: AuthUser): Promise<string[] | null> {
    if (user.role === 'SUPER_ADMIN') return null;
    const rows = await this.d1.db
      .select({ siteId: userSiteScopes.siteId })
      .from(userSiteScopes)
      .where(eq(userSiteScopes.userId, user.userId));
    // No scopes recorded has always meant every site, not none.
    return rows.length ? rows.map((r) => r.siteId) : null;
  }

  async get(user: AuthUser, id: string) {
    assertSiteInScope(user, id);
    const [row] = await this.d1.db
      .select()
      .from(sites)
      .leftJoin(siteSettings, eq(siteSettings.siteId, sites.id))
      .where(and(eq(sites.id, id), eq(sites.organizationId, user.organizationId)))
      .limit(1);
    if (!row) throw Errors.notFound('Site');
    // Prisma's `include` produced a nested object; a join gives two, so the
    // shape the callers expect is rebuilt here rather than at every call site.
    return { ...row.sites, settings: row.site_settings ?? null };
  }

  async create(user: AuthUser, dto: CreateSiteDto) {
    const now = new Date();
    const id = randomUUID();
    const [site] = await this.d1.db
      .insert(sites)
      .values({
        ...(dto as Partial<SiteInsert>),
        id,
        organizationId: user.organizationId,
        createdAt: now,
        updatedAt: now,
      } as SiteInsert)
      .returning();

    // The settings row is not optional in practice — everything that reads a
    // site expects one — so it is written in the same request, as before.
    await this.d1.db.insert(siteSettings).values({ siteId: id, updatedAt: now } as SettingsInsert);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'SITE_CREATE',
      entityType: 'Site',
      entityId: site.id,
      newValue: site,
    });
    return site;
  }

  async update(user: AuthUser, id: string, dto: UpdateSiteDto) {
    const before = await this.get(user, id);
    const [site] = await this.d1.db
      .update(sites)
      .set({ ...(dto as Partial<SiteInsert>), updatedAt: new Date() })
      .where(eq(sites.id, id))
      .returning();

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'SITE_UPDATE',
      entityType: 'Site',
      entityId: id,
      oldValue: before,
      newValue: site,
    });
    return site;
  }

  async getSettings(user: AuthUser, siteId: string) {
    await this.get(user, siteId);
    const [settings] = await this.d1.db
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.siteId, siteId))
      .limit(1);
    if (settings) return settings;
    const [created] = await this.d1.db
      .insert(siteSettings)
      .values({ siteId, updatedAt: new Date() } as SettingsInsert)
      .returning();
    return created;
  }

  async updateSettings(user: AuthUser, siteId: string, dto: UpdateSiteSettingsDto) {
    await this.get(user, siteId);
    const [before] = await this.d1.db
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.siteId, siteId))
      .limit(1);

    // Prisma's upsert, spelled out. SQLite has ON CONFLICT DO UPDATE, which is
    // one round trip and cannot race two requests into two rows.
    const [settings] = await this.d1.db
      .insert(siteSettings)
      .values({ siteId, ...(dto as Partial<SettingsInsert>), updatedAt: new Date() } as SettingsInsert)
      .onConflictDoUpdate({
        target: siteSettings.siteId,
        set: { ...(dto as Partial<SettingsInsert>), updatedAt: new Date() },
      })
      .returning();

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'SITE_SETTINGS_UPDATE',
      entityType: 'SiteSettings',
      entityId: siteId,
      oldValue: before,
      newValue: settings,
    });
    return settings;
  }

  async listShifts(user: AuthUser, siteId: string) {
    assertSiteInScope(user, siteId);
    const rows = await this.d1.db
      .select()
      .from(shifts)
      .where(eq(shifts.siteId, siteId))
      .orderBy(asc(shifts.startTime));
    // 'HH:MM:SS' sorts correctly as text, so the ordering above is right — but
    // callers were given Dates by Prisma, so they still are.
    return rows.map(withTimeObjects);
  }

  async createShift(user: AuthUser, siteId: string, dto: CreateShiftDto) {
    await this.get(user, siteId);
    const start = parseTimeOfDay(dto.startTime);
    const end = parseTimeOfDay(dto.endTime);
    const [shift] = await this.d1.db
      .insert(shifts)
      .values({
        id: randomUUID(),
        siteId,
        name: dto.name,
        startTime: timeOfDayToText(start),
        endTime: timeOfDayToText(end),
        isOvernight: isOvernight(start, end),
        lateGraceMinutes: dto.lateGraceMinutes ?? 0,
        earlyGraceMinutes: dto.earlyGraceMinutes ?? 0,
        otThresholdMinutes: dto.otThresholdMinutes ?? 0,
        isActive: true,
        createdAt: new Date(),
      })
      .returning();

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'SHIFT_CREATE',
      entityType: 'Shift',
      entityId: shift.id,
      newValue: shift,
    });
    return withTimeObjects(shift);
  }

  async updateShift(user: AuthUser, shiftId: string, dto: UpdateShiftDto) {
    const [existing] = await this.d1.db
      .select()
      .from(shifts)
      .where(eq(shifts.id, shiftId))
      .limit(1);
    if (!existing) throw Errors.notFound('Shift');
    assertSiteInScope(user, existing.siteId);

    const start = dto.startTime ? parseTimeOfDay(dto.startTime) : textToTimeOfDay(existing.startTime);
    const end = dto.endTime ? parseTimeOfDay(dto.endTime) : textToTimeOfDay(existing.endTime);

    const [shift] = await this.d1.db
      .update(shifts)
      .set({
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        startTime: timeOfDayToText(start),
        endTime: timeOfDayToText(end),
        isOvernight: isOvernight(start, end),
        ...(dto.lateGraceMinutes !== undefined ? { lateGraceMinutes: dto.lateGraceMinutes } : {}),
        ...(dto.earlyGraceMinutes !== undefined ? { earlyGraceMinutes: dto.earlyGraceMinutes } : {}),
        ...(dto.otThresholdMinutes !== undefined
          ? { otThresholdMinutes: dto.otThresholdMinutes }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      })
      .where(eq(shifts.id, shiftId))
      .returning();

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'SHIFT_UPDATE',
      entityType: 'Shift',
      entityId: shiftId,
      oldValue: withTimeObjects(existing),
      newValue: shift,
    });
    return withTimeObjects(shift);
  }
}

/** Shift times back as Dates, which is what everything downstream expects. */
function withTimeObjects<T extends { startTime: string; endTime: string }>(shift: T) {
  return {
    ...shift,
    startTime: textToTimeOfDay(shift.startTime),
    endTime: textToTimeOfDay(shift.endTime),
  };
}
