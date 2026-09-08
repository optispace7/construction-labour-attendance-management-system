import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, ne, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { SafetyMetric } from '../../common/enums';
import { D1Service } from '../../infra/d1/d1.service';
import { chunked } from '../../infra/d1/chunked';
import {
  attendanceSessions,
  dailySafetyEntries,
  dailyWasteEntries,
  organizations,
  sites,
  wasteTypes,
  workers,
} from '../../infra/d1/schema.generated';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { businessDate } from '../../common/time/time.util';
import {
  DEFAULT_WASTE_TYPES,
  METRIC_CATALOG,
  SAFETY_MANPOWER_CATEGORIES,
  SAFETY_PERFORMANCE_TARGET,
  SAFE_MAN_HOURS_PER_DAY,
  SCORE_INACTIVITY_MIN_DAYS,
  WASTE_METRIC,
  isAutomated,
  safetyPerformance,
  safetyWindow,
  specFor,
} from './safety.metrics';
import {
  SafetyPeriod,
  SaveDailyDto,
  UpsertMetricDto,
  WasteItemDto,
  WasteTypeDto,
} from './dto/safety.dto';
import { renderSafetyPdf } from '../reports/report.renderer';

const DAY_MS = 86_400_000;
/** The longest `period=custom` window; see `SafetyService.customWindow`. */
const MAX_CUSTOM_RANGE_DAYS = 366;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const midnight = (v: string) => new Date(`${v.slice(0, 10)}T00:00:00.000Z`);

/**
 * Fold one site's comment into the note for a day that covers several.
 *
 * A comment belongs to the site whose officer wrote it, so an aggregate row
 * names each one — "Tower A: skip overflowing" — rather than picking one at
 * random or, as it used to, dropping the lot. Sites with nothing to say add
 * nothing, so the common case of one site commenting still reads as one line.
 */
function joinSiteComments(
  soFar: string | null | undefined,
  siteName: string,
  comment: string | null,
): string | null {
  if (!comment?.trim()) return soFar ?? null;
  const line = `${siteName}: ${comment.trim()}`;
  return soFar ? `${soFar} · ${line}` : line;
}

/**
 * How the derived metrics are named on the statistics board, where the figure
 * covers the selected window rather than one day. The catalogue keeps its own
 * labels for the daily sheet, which really is a single day.
 */
const WINDOW_METRIC_LABELS: Partial<Record<SafetyMetric, string>> = {
  DAILY_MANPOWER: 'Manpower',
  TOTAL_MANPOWER: 'Total manpower to date',
  TOTAL_SAFE_MAN_HOURS: 'Safe man-hours',
};

@Injectable()
export class SafetyService {
  constructor(
    private readonly d1: D1Service,
    private readonly audit: AuditService,
  ) {}

  /** The org's today, in its own timezone. */
  private async today(user: AuthUser): Promise<Date> {
    const [org] = await this.d1.db
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, user.organizationId))
      .limit(1);
    return businessDate(new Date(), org?.timezone ?? 'Asia/Kolkata');
  }

  /**
   * Which sites a read may cover. `siteId` narrows to one; otherwise it is every
   * site the caller is scoped to, which is what the "All sites" filter means.
   *
   * Returns null for "no restriction" so a Super Admin with no scopes is not
   * accidentally filtered down to an empty list.
   */
  private readScope(user: AuthUser, siteId?: string): string[] | null {
    const scoped = user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0;
    if (siteId && siteId !== 'all') {
      if (scoped && !user.siteScopes.includes(siteId)) {
        throw Errors.forbidden('That site is outside your access');
      }
      return [siteId];
    }
    return scoped ? user.siteScopes : null;
  }

  /**
   * A write always names one site. There is no company-wide row to write to:
   * the figures belong to a site and the totals are an aggregation over them, so
   * "All sites" is a reading position, never a writing one.
   */
  private async writeSite(user: AuthUser, siteId: string): Promise<string> {
    if (!siteId || siteId === 'all') {
      throw Errors.validation({ message: 'Pick a site before saving safety figures' });
    }
    const [site] = await this.d1.db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, siteId), eq(sites.organizationId, user.organizationId)))
      .limit(1);
    if (!site) throw Errors.notFound('Site');
    if (user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0) {
      if (!user.siteScopes.includes(siteId)) {
        throw Errors.forbidden('That site is outside your access');
      }
    }
    return site.id;
  }

  /**
   * The shared session filter. Reads the joined worker, so every caller joins
   * `workers` — they all do.
   */
  private sessionWhere(user: AuthUser, siteIds: string[] | null): SQL[] {
    return [
      eq(attendanceSessions.organizationId, user.organizationId),
      ne(attendanceSessions.state, 'VOID'),
      // Everybody who works the site, labour and staff alike: a supervisor
      // standing in the same hazard is a man-day on the safety board and earns
      // the same safe hours. A visitor walking through is not, and is the one
      // category left out — which is why this is a list rather than "not
      // VISITOR", so a category added later has to be thought about.
      inArray(workers.category, [...SAFETY_MANPOWER_CATEGORIES]),
      ...(siteIds ? [inArray(attendanceSessions.siteId, siteIds)] : []),
    ];
  }

  /** How many manpower sessions match, for a window of work dates. */
  private async countSessions(where: SQL[], extra: SQL[]): Promise<number> {
    const [row] = await this.d1.db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(attendanceSessions)
      .innerJoin(workers, eq(workers.id, attendanceSessions.workerId))
      .where(and(...where, ...extra));
    return Number(row?.count ?? 0);
  }

  /**
   * The two counts every derived figure is built from.
   *
   * `inWindow` is the man-days falling inside [start, end]; `toDate` is every
   * man-day up to and including `end`, cumulative since the project began, which
   * is why it dwarfs the other. Kept as raw counts rather than a finished metric
   * map because the daily sheet and the statistics board want them combined
   * differently — the sheet is always one day, the board is whatever window the
   * reader picked.
   */
  private async manpowerCounts(user: AuthUser, siteIds: string[] | null, start: Date, end: Date) {
    const where = this.sessionWhere(user, siteIds);
    const [inWindow, toDate] = await Promise.all([
      this.countSessions(where, [
        gte(attendanceSessions.workDate, iso(start)),
        lte(attendanceSessions.workDate, iso(end)),
      ]),
      this.countSessions(where, [lte(attendanceSessions.workDate, iso(end))]),
    ]);
    return { inWindow, toDate };
  }

  /**
   * The three figures nobody types in, as the daily sheet means them: one day's
   * man-days, the project-to-date total, and that total at a flat shift length.
   *
   * Safe man-hours does NOT reset on a lost-time injury — the client asked for
   * the running total, not the since-last-incident streak.
   */
  private async automated(user: AuthUser, siteIds: string[] | null, date: Date) {
    const { inWindow, toDate } = await this.manpowerCounts(user, siteIds, date, date);
    return {
      DAILY_MANPOWER: inWindow,
      TOTAL_MANPOWER: toDate,
      TOTAL_SAFE_MAN_HOURS: toDate * SAFE_MAN_HOURS_PER_DAY,
    } satisfies Partial<Record<SafetyMetric, number>>;
  }

  /**
   * One day's board: every metric in the catalogue, with the derived ones filled
   * in and the typed ones carrying whatever has been entered so far.
   *
   * Always returns the full catalogue, including metrics with no row yet — the
   * form is driven by this response, and a missing metric would otherwise be an
   * un-fillable gap. `value: null` on a manual metric means "not filled in",
   * which the stats page treats differently from a recorded zero.
   */
  async daily(user: AuthUser, opts: { date?: string; siteId?: string }) {
    const siteIds = this.readScope(user, opts.siteId);
    const date = opts.date ? midnight(opts.date) : await this.today(user);
    const single = opts.siteId && opts.siteId !== 'all' ? opts.siteId : null;

    const [rows, derived, wasteTypes, waste] = await Promise.all([
      this.d1.db
        .select({ entry: dailySafetyEntries, siteName: sites.name })
        .from(dailySafetyEntries)
        .innerJoin(sites, eq(sites.id, dailySafetyEntries.siteId))
        .where(
          and(
            eq(dailySafetyEntries.organizationId, user.organizationId),
            eq(dailySafetyEntries.entryDate, iso(date)),
            ...(siteIds ? [inArray(dailySafetyEntries.siteId, siteIds)] : []),
          ),
        )
        // Text on SQLite where Prisma had an enum; the values stored are the
        // enum's own, so the narrowing restates rather than changes anything.
        .then((rows) =>
          rows.map((r) => ({
            ...r.entry,
            metric: r.entry.metric as SafetyMetric,
            site: { name: r.siteName },
          })),
        ),
      this.automated(user, siteIds, date),
      this.wasteTypes(user),
      this.wasteFor(user, siteIds, date),
    ]);

    // Across several sites a typed metric is the sum of them. A comment belongs
    // to the site whose officer wrote it, so the aggregate names each one
    // instead of dropping them — only the entry id, which is what per-item
    // editing needs, is meaningless across sites.
    const summed = new Map<SafetyMetric, number>();
    const byMetric = new Map<SafetyMetric, (typeof rows)[number]>();
    const notes = new Map<SafetyMetric, string | null>();
    for (const r of rows) {
      if (r.value != null) summed.set(r.metric, (summed.get(r.metric) ?? 0) + r.value);
      if (single) byMetric.set(r.metric, r);
      else notes.set(r.metric, joinSiteComments(notes.get(r.metric), r.site.name, r.comment));
    }

    const items = METRIC_CATALOG.map((spec) => {
      const row = byMetric.get(spec.metric);
      const automatedValue = derived[spec.metric as keyof typeof derived];
      return {
        metric: spec.metric,
        label: spec.label,
        kind: spec.kind,
        group: spec.group,
        value: spec.kind === 'AUTOMATED' ? automatedValue : (summed.get(spec.metric) ?? null),
        comment: single ? (row?.comment ?? null) : (notes.get(spec.metric) ?? null),
        entryId: row?.id ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });

    return {
      date: iso(date),
      siteId: opts.siteId ?? 'all',
      /** Comments and per-item editing need one site; the aggregate is read-only. */
      editable: Boolean(single),
      items,
      /**
       * The detail behind WASTE_DISPOSAL: the dropdown to choose from, and what
       * has been recorded against it today. The metric's own figure above is the
       * total of these, so a client reading only `items` still gets a number.
       */
      waste: { types: wasteTypes, rows: waste },
    };
  }

  // -------------------------------------------------------------------------
  // Waste types
  // -------------------------------------------------------------------------

  /**
   * The organization's waste dropdown, retired types last.
   *
   * Seeds the defaults for an organization that has none. Writing on a read is
   * not free, but the alternative is a client whose dropdown is empty until
   * somebody remembers to run something — and the migration only reaches the
   * organizations that existed when it ran.
   */
  async wasteTypes(user: AuthUser) {
    const [{ count: existing } = { count: 0 }] = await this.d1.db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(wasteTypes)
      .where(eq(wasteTypes.organizationId, user.organizationId));
    if (Number(existing) === 0) {
      const now = new Date();
      await this.d1.db
        .insert(wasteTypes)
        .values(
          DEFAULT_WASTE_TYPES.map((name, i) => ({
            id: randomUUID(),
            organizationId: user.organizationId,
            name,
            sortOrder: i + 1,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          })),
        )
        // skipDuplicates, spelled out: two requests arriving together must not
        // seed the list twice.
        .onConflictDoNothing();
    }
    return this.d1.db
      .select({
        id: wasteTypes.id,
        name: wasteTypes.name,
        sortOrder: wasteTypes.sortOrder,
        isActive: wasteTypes.isActive,
      })
      .from(wasteTypes)
      .where(eq(wasteTypes.organizationId, user.organizationId))
      .orderBy(desc(wasteTypes.isActive), asc(wasteTypes.sortOrder), asc(wasteTypes.name));
  }

  private cleanName(name: string): string {
    const trimmed = name.trim().replace(/\s+/g, ' ');
    if (!trimmed) throw Errors.validation({ message: 'Give the waste type a name' });
    return trimmed;
  }

  /** A name already in use, whether or not that type is still active. */
  private async assertNameFree(user: AuthUser, name: string, exceptId?: string) {
    const [clash] = await this.d1.db
      .select({ isActive: wasteTypes.isActive })
      .from(wasteTypes)
      .where(
        and(
          eq(wasteTypes.organizationId, user.organizationId),
          eq(wasteTypes.name, name),
          ...(exceptId ? [ne(wasteTypes.id, exceptId)] : []),
        ),
      )
      .limit(1);
    if (clash) {
      throw Errors.validation({
        message: clash.isActive
          ? `"${name}" is already in the list`
          : `"${name}" is a retired type — bring it back rather than adding a second one`,
      });
    }
  }

  async createWasteType(user: AuthUser, dto: WasteTypeDto) {
    const name = this.cleanName(dto.name);
    await this.assertNameFree(user, name);
    // Last in the dropdown, so an addition never reshuffles the list somebody
    // has learned the shape of.
    const [last] = await this.d1.db
      .select({ maxSort: sql<number>`coalesce(max(${wasteTypes.sortOrder}), 0)`.as('maxSort') })
      .from(wasteTypes)
      .where(eq(wasteTypes.organizationId, user.organizationId));
    const now = new Date();
    const [created] = await this.d1.db
      .insert(wasteTypes)
      .values({
        id: randomUUID(),
        organizationId: user.organizationId,
        name,
        sortOrder: Number(last?.maxSort ?? 0) + 1,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: wasteTypes.id,
        name: wasteTypes.name,
        sortOrder: wasteTypes.sortOrder,
        isActive: wasteTypes.isActive,
      });
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'WASTE_TYPE_CREATE',
      entityType: 'WasteType',
      entityId: created.id,
      newValue: { name },
      reason: 'Waste type added',
    });
    return created;
  }

  private async ownWasteType(user: AuthUser, id: string) {
    const [type] = await this.d1.db
      .select()
      .from(wasteTypes)
      .where(and(eq(wasteTypes.id, id), eq(wasteTypes.organizationId, user.organizationId)))
      .limit(1);
    if (!type) throw Errors.notFound('Waste type');
    return type;
  }

  /**
   * Rename, or bring a retired type back.
   *
   * A rename carries its history with it — the entries point at the row, not at
   * the text — which is the point of holding these as rows in the first place.
   */
  async updateWasteType(user: AuthUser, id: string, dto: WasteTypeDto) {
    const before = await this.ownWasteType(user, id);
    const name = this.cleanName(dto.name);
    if (name !== before.name) await this.assertNameFree(user, name, id);
    const [updated] = await this.d1.db
      .update(wasteTypes)
      .set({ name, isActive: true, updatedAt: new Date() })
      .where(eq(wasteTypes.id, id))
      .returning({
        id: wasteTypes.id,
        name: wasteTypes.name,
        sortOrder: wasteTypes.sortOrder,
        isActive: wasteTypes.isActive,
      });
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'WASTE_TYPE_UPDATE',
      entityType: 'WasteType',
      entityId: id,
      oldValue: { name: before.name, isActive: before.isActive },
      newValue: { name, isActive: true },
      reason: 'Waste type edited',
    });
    return updated;
  }

  /**
   * Remove a waste type — properly if nothing has been filed against it, by
   * retiring it if something has.
   *
   * Deleting a used type would take a month of recorded figures with it and
   * silently change every total that included them. Retiring drops it out of
   * the dropdown, which is what "delete" means to the person asking, and leaves
   * the past intact.
   */
  async deleteWasteType(user: AuthUser, id: string) {
    const type = await this.ownWasteType(user, id);
    const [usedRow] = await this.d1.db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(dailyWasteEntries)
      .where(eq(dailyWasteEntries.wasteTypeId, id));
    const used = Number(usedRow?.count ?? 0);

    if (used === 0) {
      await this.d1.db.delete(wasteTypes).where(eq(wasteTypes.id, id));
    } else {
      await this.d1.db
        .update(wasteTypes)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(wasteTypes.id, id));
    }

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: used === 0 ? 'WASTE_TYPE_DELETE' : 'WASTE_TYPE_RETIRE',
      entityType: 'WasteType',
      entityId: id,
      oldValue: { name: type.name },
      reason: used === 0 ? 'Waste type removed' : `Waste type retired (${used} entries kept)`,
    });

    return { deleted: used === 0, retired: used > 0, entriesKept: used };
  }

  // -------------------------------------------------------------------------
  // The waste breakdown behind WASTE_DISPOSAL
  // -------------------------------------------------------------------------

  /** The day's breakdown, summed across sites when several are in view. */
  private async wasteFor(user: AuthUser, siteIds: string[] | null, date: Date) {
    const rows = await this.d1.db
      .select({
        wasteTypeId: dailyWasteEntries.wasteTypeId,
        value: sql<number>`sum(${dailyWasteEntries.value})`.as('value'),
      })
      .from(dailyWasteEntries)
      .where(
        and(
          eq(dailyWasteEntries.organizationId, user.organizationId),
          eq(dailyWasteEntries.entryDate, iso(date)),
          ...(siteIds ? [inArray(dailyWasteEntries.siteId, siteIds)] : []),
        ),
      )
      .groupBy(dailyWasteEntries.wasteTypeId);
    return rows.map((r) => ({ wasteTypeId: r.wasteTypeId, value: Number(r.value ?? 0) }));
  }

  /**
   * Write the day's breakdown and fold it back into the WASTE_DISPOSAL figure.
   *
   * The total is never typed. It is the sum of the rows, written to the same
   * DailySafetyEntry every chart and export already reads, so the headline and
   * its detail cannot drift apart.
   */
  private async saveWaste(
    user: AuthUser,
    siteId: string,
    date: Date,
    items: WasteItemDto[],
    comment?: string | null,
  ) {
    const ids = [...new Set(items.map((i) => i.wasteTypeId))];
    if (ids.length) {
      const [knownRow] = await this.d1.db
        .select({ count: sql<number>`count(*)`.as('count') })
        .from(wasteTypes)
        .where(
          and(inArray(wasteTypes.id, ids), eq(wasteTypes.organizationId, user.organizationId)),
        );
      if (Number(knownRow?.count ?? 0) !== ids.length) {
        throw Errors.validation({ message: 'Unknown waste type' });
      }
    }

    const keep = items.filter((i) => i.value != null) as { wasteTypeId: string; value: number }[];
    const drop = items.filter((i) => i.value == null).map((i) => i.wasteTypeId);

    const now = new Date();
    const day = iso(date);
    await this.d1.db.batch([
      // A line cleared on the form is a row deleted, not a zero: the sheet
      // distinguishes "none went out" from "nobody said".
      ...(drop.length
        ? [
            this.d1.db
              .delete(dailyWasteEntries)
              .where(
                and(
                  eq(dailyWasteEntries.siteId, siteId),
                  eq(dailyWasteEntries.entryDate, day),
                  inArray(dailyWasteEntries.wasteTypeId, drop),
                ),
              ),
          ]
        : []),
      ...keep.map((i) =>
        this.d1.db
          .insert(dailyWasteEntries)
          .values({
            id: randomUUID(),
            organizationId: user.organizationId,
            siteId,
            entryDate: day,
            wasteTypeId: i.wasteTypeId,
            value: i.value,
            recordedById: user.userId,
            createdAt: now,
            updatedAt: now,
          })
          // Prisma's upsert, on the same key its compound unique named.
          .onConflictDoUpdate({
            target: [
              dailyWasteEntries.siteId,
              dailyWasteEntries.entryDate,
              dailyWasteEntries.wasteTypeId,
            ],
            set: { value: i.value, recordedById: user.userId, updatedAt: now },
          }),
      ),
    ] as never);

    await this.syncWasteTotal(user, siteId, date, comment);
  }

  /** Re-derive WASTE_DISPOSAL for one site and day from its breakdown. */
  private async syncWasteTotal(
    user: AuthUser,
    siteId: string,
    date: Date,
    comment?: string | null,
  ) {
    const [sum] = await this.d1.db
      .select({
        total: sql<number>`sum(${dailyWasteEntries.value})`.as('total'),
        rows: sql<number>`count(*)`.as('rows'),
      })
      .from(dailyWasteEntries)
      .where(
        and(eq(dailyWasteEntries.siteId, siteId), eq(dailyWasteEntries.entryDate, iso(date))),
      );
    // No rows at all means nobody has said anything about waste today, which is
    // a blank rather than a zero — the same distinction the rest of the sheet
    // keeps. The comment on the row survives either way.
    const total = Number(sum?.rows ?? 0) === 0 ? null : Number(sum?.total ?? 0);
    await this.upsertOne(user, siteId, date, {
      metric: WASTE_METRIC,
      value: total,
      comment: comment === undefined ? await this.wasteComment(siteId, date) : comment,
    });
  }

  /** The comment already on the WASTE_DISPOSAL row, which a resync must keep. */
  private async wasteComment(siteId: string, date: Date): Promise<string | null> {
    const [row] = await this.d1.db
      .select({ comment: dailySafetyEntries.comment })
      .from(dailySafetyEntries)
      .where(
        and(
          eq(dailySafetyEntries.siteId, siteId),
          eq(dailySafetyEntries.entryDate, iso(date)),
          eq(dailySafetyEntries.metric, WASTE_METRIC),
        ),
      )
      .limit(1);
    return row?.comment ?? null;
  }

  /** Upsert a whole day in one go — what the form's Save button posts. */
  async saveDaily(user: AuthUser, dto: SaveDailyDto) {
    const siteId = await this.writeSite(user, dto.siteId);
    const date = midnight(dto.date);

    const writes = dto.items
      // The waste total is the sum of the breakdown, written below. Taking a
      // typed figure here would let the headline disagree with its own detail.
      .filter((item) => item.metric !== WASTE_METRIC || dto.waste === undefined)
      .map((item) =>
        this.upsertOne(user, siteId, date, {
          metric: item.metric,
          // A derived metric stores only its comment; its number comes from
          // attendance and caching it here would let the two drift apart.
          value: isAutomated(item.metric) ? null : (item.value ?? null),
          comment: item.comment ?? null,
        }),
      );
    if (writes.length) await this.d1.db.batch(writes as never);

    if (dto.waste) {
      // The comment on the waste row is still the sheet's to set; only its
      // number is taken away from it. A save that says nothing about the
      // comment leaves whatever is there.
      const sent = dto.items.find((i) => i.metric === WASTE_METRIC);
      await this.saveWaste(
        user,
        siteId,
        date,
        dto.waste,
        sent ? (sent.comment ?? null) : undefined,
      );
    }

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'SAFETY_DAILY_SAVE',
      entityType: 'DailySafetyEntry',
      entityId: null,
      newValue: { siteId, date: iso(date), metrics: dto.items.length },
      reason: 'Daily safety figures',
    });

    return this.daily(user, { date: iso(date), siteId });
  }

  private upsertOne(
    user: AuthUser,
    siteId: string,
    date: Date,
    data: { metric: SafetyMetric; value: number | null; comment: string | null },
  ) {
    const now = new Date();
    return this.d1.db
      .insert(dailySafetyEntries)
      .values({
        id: randomUUID(),
        organizationId: user.organizationId,
        siteId,
        entryDate: iso(date),
        metric: data.metric,
        value: data.value ?? null,
        comment: data.comment ?? null,
        recordedById: user.userId,
        createdAt: now,
        updatedAt: now,
      })
      // Prisma's upsert, on the same key its compound unique named.
      .onConflictDoUpdate({
        target: [
          dailySafetyEntries.siteId,
          dailySafetyEntries.entryDate,
          dailySafetyEntries.metric,
        ],
        set: {
          value: data.value ?? null,
          comment: data.comment ?? null,
          recordedById: user.userId,
          updatedAt: now,
        },
      });
  }

  /** Edit a single item — the per-row Edit action. */
  async upsertMetric(user: AuthUser, dto: UpsertMetricDto) {
    const siteId = await this.writeSite(user, dto.siteId);
    const date = midnight(dto.date);
    if (!specFor(dto.metric)) throw Errors.validation({ message: 'Unknown safety metric' });
    if (dto.metric === WASTE_METRIC) {
      // Waste is the sum of its breakdown, so this row takes the comment and
      // leaves the figure alone — the same deal the derived metrics get.
      await this.syncWasteTotal(user, siteId, date, dto.comment ?? null);
    } else {
      await this.upsertOne(user, siteId, date, {
        metric: dto.metric,
        value: isAutomated(dto.metric) ? null : (dto.value ?? null),
        comment: dto.comment ?? null,
      });
    }
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'SAFETY_METRIC_EDIT',
      entityType: 'DailySafetyEntry',
      entityId: null,
      newValue: { siteId, date: iso(date), metric: dto.metric, value: dto.value ?? null },
      reason: 'Safety figure edited',
    });
    return this.daily(user, { date: iso(date), siteId });
  }

  /**
   * Remove a single item, putting it back to "not filled in".
   *
   * A derived metric cannot be deleted as a number — only its comment goes, and
   * the figure keeps coming from attendance.
   */
  async deleteMetric(user: AuthUser, opts: { siteId: string; date: string; metric: SafetyMetric }) {
    const siteId = await this.writeSite(user, opts.siteId);
    const date = midnight(opts.date);
    const [existing] = await this.d1.db
      .select()
      .from(dailySafetyEntries)
      .where(
        and(
          eq(dailySafetyEntries.siteId, siteId),
          eq(dailySafetyEntries.entryDate, iso(date)),
          eq(dailySafetyEntries.metric, opts.metric),
        ),
      )
      .limit(1);
    if (!existing) throw Errors.notFound('Safety entry');

    // Clearing the waste figure means clearing what it is the total of.
    // Leaving the breakdown would put the number straight back on the next save.
    if (opts.metric === WASTE_METRIC) {
      await this.d1.db
        .delete(dailyWasteEntries)
        .where(
          and(
            eq(dailyWasteEntries.siteId, siteId),
            eq(dailyWasteEntries.entryDate, iso(date)),
          ),
        );
    }
    await this.d1.db.delete(dailySafetyEntries).where(eq(dailySafetyEntries.id, existing.id));
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'SAFETY_METRIC_DELETE',
      entityType: 'DailySafetyEntry',
      entityId: existing.id,
      oldValue: { metric: existing.metric, value: existing.value, comment: existing.comment },
      reason: 'Safety figure removed',
    });
    return this.daily(user, { date: iso(date), siteId });
  }

  /**
   * One metric across many dates — the per-item "View for all the dates".
   *
   * Derived metrics are answered from attendance for every day in the window, so
   * the history of manpower reads the same way as the history of toolbox talks.
   */
  async history(
    user: AuthUser,
    opts: { metric: SafetyMetric; siteId?: string; from?: string; to?: string },
  ) {
    const spec = specFor(opts.metric);
    if (!spec) throw Errors.validation({ message: 'Unknown safety metric' });
    const siteIds = this.readScope(user, opts.siteId);
    const end = opts.to ? midnight(opts.to) : await this.today(user);
    const start = opts.from ? midnight(opts.from) : new Date(end.getTime() - 29 * DAY_MS);
    if (start > end) throw Errors.validation({ message: 'The range starts after it ends' });

    const days: string[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) days.push(iso(new Date(t)));

    if (spec.kind === 'AUTOMATED') {
      // Counted in SQL rather than by reading a row per session: a year of a
      // real site is tens of thousands of rows, and only the daily totals are
      // wanted.
      const sessions = await this.d1.db
        .select({
          workDate: attendanceSessions.workDate,
          count: sql<number>`count(*)`.as('count'),
        })
        .from(attendanceSessions)
        .innerJoin(workers, eq(workers.id, attendanceSessions.workerId))
        .where(
          and(
            ...this.sessionWhere(user, siteIds),
            gte(attendanceSessions.workDate, iso(start)),
            lte(attendanceSessions.workDate, iso(end)),
          ),
        )
        .groupBy(attendanceSessions.workDate);
      const perDay = new Map<string, number>();
      for (const row of sessions) perDay.set(row.workDate, Number(row.count));
      // Only TOTAL_MANPOWER still runs a total forward; the other two are
      // per-day figures and would be nonsense carried over from before the
      // window opened.
      const priorTotal =
        spec.metric === 'TOTAL_MANPOWER'
          ? await this.countSessions(this.sessionWhere(user, siteIds), [
              lt(attendanceSessions.workDate, iso(start)),
            ])
          : 0;
      let running = priorTotal;
      const comments = await this.commentsFor(user, opts.metric, siteIds, start, end);
      return {
        metric: opts.metric,
        label: spec.label,
        kind: spec.kind,
        rows: days.map((d) => {
          const dayCount = perDay.get(d) ?? 0;
          running += dayCount;
          const value =
            spec.metric === 'DAILY_MANPOWER'
              ? dayCount
              : spec.metric === 'TOTAL_MANPOWER'
                ? running
                : // Hours earned that day, matching the board's window figure —
                  // a running curve here beside a period total on the card was
                  // two different questions answered as one.
                  dayCount * SAFE_MAN_HOURS_PER_DAY;
          return {
            date: d,
            value,
            comment: comments.get(d) ?? null,
            entryId: null,
            // A derived figure exists for every day by definition.
            recorded: true,
            // Manpower is one number counted from attendance; there is nothing
            // underneath it the way there is under waste.
            breakdown: null,
          };
        }),
      };
    }

    const joined = await this.d1.db
      .select({ entry: dailySafetyEntries, siteName: sites.name })
      .from(dailySafetyEntries)
      .innerJoin(sites, eq(sites.id, dailySafetyEntries.siteId))
      .where(
        and(
          eq(dailySafetyEntries.organizationId, user.organizationId),
          eq(dailySafetyEntries.metric, opts.metric),
          gte(dailySafetyEntries.entryDate, iso(start)),
          lte(dailySafetyEntries.entryDate, iso(end)),
          ...(siteIds ? [inArray(dailySafetyEntries.siteId, siteIds)] : []),
        ),
      )
      .orderBy(asc(dailySafetyEntries.entryDate));
    const rows = joined.map((r) => ({ ...r.entry, site: { name: r.siteName } }));
    const single = opts.siteId && opts.siteId !== 'all';
    const perDay = new Map<string, { value: number | null; comment: string | null; id: string }>();
    for (const r of rows) {
      const key = r.entryDate;
      const prev = perDay.get(key);
      perDay.set(key, {
        value: (prev?.value ?? 0) + (r.value ?? 0),
        // A comment survives the aggregate rather than being thrown away with
        // it. The statistics board reads this drawer with "All sites" selected
        // by default, and dropping the note there meant every comment anybody
        // typed on the daily sheet read back as "no comment on this day".
        // Several sites on one day are joined and named, because the note only
        // makes sense against the site whose officer wrote it.
        comment: single ? r.comment : joinSiteComments(prev?.comment, r.site.name, r.comment),
        id: r.id,
      });
    }

    /**
     * The waste figure is a total of typed-in lines, so its history carries
     * them. Every other metric is a single number and has nothing underneath.
     *
     * Without this the drawer answered "3 recorded" for a day somebody entered
     * one skip of block waste and two of gypsum — a true total, and half the
     * answer to the question the drawer exists to ask.
     */
    const breakdowns =
      opts.metric === WASTE_METRIC
        ? await this.wasteBreakdownByDay(user, siteIds, start, end)
        : new Map<string, { label: string; value: number }[]>();

    return {
      metric: opts.metric,
      label: spec.label,
      kind: spec.kind,
      /**
       * Every day in the window, recorded or not.
       *
       * The detail drawer steps through dates and plots a continuous trend, so
       * it needs the gaps as gaps rather than as missing rows it would have to
       * infer. `recorded: false` is what lets it say "not filled in" instead of
       * printing a zero nobody entered — callers that only want the entries
       * filter on that flag.
       */
      rows: days.map((d) => {
        const hit = perDay.get(d);
        return {
          date: d,
          value: hit?.value ?? null,
          comment: hit?.comment ?? null,
          entryId: single ? (hit?.id ?? null) : null,
          recorded: Boolean(hit),
          /** What the figure is made of, where it is made of anything. */
          breakdown: breakdowns.get(d) ?? null,
        };
      }),
    };
  }

  /**
   * The waste breakdown day by day across a window, named and in dropdown
   * order — what the day-by-day drawer shows under each day's total.
   *
   * One query for the whole window rather than one per day: a thirty-day
   * drawer would otherwise be thirty round trips to draw a panel.
   */
  private async wasteBreakdownByDay(
    user: AuthUser,
    siteIds: string[] | null,
    start: Date,
    end: Date,
  ): Promise<Map<string, { label: string; value: number }[]>> {
    const grouped = await this.d1.db
      .select({
        entryDate: dailyWasteEntries.entryDate,
        wasteTypeId: dailyWasteEntries.wasteTypeId,
        value: sql<number>`sum(${dailyWasteEntries.value})`.as('value'),
      })
      .from(dailyWasteEntries)
      .where(
        and(
          eq(dailyWasteEntries.organizationId, user.organizationId),
          gte(dailyWasteEntries.entryDate, iso(start)),
          lte(dailyWasteEntries.entryDate, iso(end)),
          ...(siteIds ? [inArray(dailyWasteEntries.siteId, siteIds)] : []),
        ),
      )
      .groupBy(dailyWasteEntries.entryDate, dailyWasteEntries.wasteTypeId);
    if (grouped.length === 0) return new Map();

    const types = await chunked([...new Set(grouped.map((g) => g.wasteTypeId))], (batch) =>
      this.d1.db
        .select({ id: wasteTypes.id, name: wasteTypes.name, sortOrder: wasteTypes.sortOrder })
        .from(wasteTypes)
        .where(
          and(inArray(wasteTypes.id, batch), eq(wasteTypes.organizationId, user.organizationId)),
        ),
    );
    const byId = new Map(types.map((t) => [t.id, t]));

    const out = new Map<string, { label: string; value: number; sortOrder: number }[]>();
    for (const g of grouped) {
      const key = g.entryDate;
      const type = byId.get(g.wasteTypeId);
      const list = out.get(key) ?? [];
      list.push({
        label: type?.name ?? 'Unknown type',
        value: Number(g.value ?? 0),
        sortOrder: type?.sortOrder ?? 0,
      });
      out.set(key, list);
    }
    return new Map(
      [...out].map(([day, list]) => [
        day,
        list
          .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
          .map(({ label, value }) => ({ label, value })),
      ]),
    );
  }

  /** Comments attached to a derived metric, which has no stored value. */
  private async commentsFor(
    user: AuthUser,
    metric: SafetyMetric,
    siteIds: string[] | null,
    start: Date,
    end: Date,
  ) {
    const rows = await this.d1.db
      .select({
        entryDate: dailySafetyEntries.entryDate,
        comment: dailySafetyEntries.comment,
        siteName: sites.name,
      })
      .from(dailySafetyEntries)
      .innerJoin(sites, eq(sites.id, dailySafetyEntries.siteId))
      .where(
        and(
          eq(dailySafetyEntries.organizationId, user.organizationId),
          eq(dailySafetyEntries.metric, metric),
          gte(dailySafetyEntries.entryDate, iso(start)),
          lte(dailySafetyEntries.entryDate, iso(end)),
          isNotNull(dailySafetyEntries.comment),
          ...(siteIds ? [inArray(dailySafetyEntries.siteId, siteIds)] : []),
        ),
      );
    const out = new Map<string, string | null>();
    for (const r of rows) {
      const key = r.entryDate;
      // Two sites commenting on the same day used to leave whichever row came
      // back last; both are kept and named instead.
      out.set(key, joinSiteComments(out.get(key), r.siteName, r.comment));
    }
    return out;
  }

  /**
   * Manpower day by day across the window, in the three shapes the headline
   * cards plot: that day's man-days, the running total, and the running total
   * as safe man-hours.
   *
   * The cards each show one number; without a series behind them there is
   * nothing to draw and the card is a figure floating in an empty box. The
   * cumulative arms need the count from before the window opened, or every
   * period would look like it started from nothing.
   */
  private async manpowerSeries(user: AuthUser, siteIds: string[] | null, start: Date, end: Date) {
    const where = this.sessionWhere(user, siteIds);
    const [sessions, priorTotal] = await Promise.all([
      this.d1.db
        .select({
          workDate: attendanceSessions.workDate,
          count: sql<number>`count(*)`.as('count'),
        })
        .from(attendanceSessions)
        .innerJoin(workers, eq(workers.id, attendanceSessions.workerId))
        .where(
          and(
            ...where,
            gte(attendanceSessions.workDate, iso(start)),
            lte(attendanceSessions.workDate, iso(end)),
          ),
        )
        .groupBy(attendanceSessions.workDate),
      this.countSessions(where, [lt(attendanceSessions.workDate, iso(start))]),
    ]);

    const perDay = new Map<string, number>();
    for (const row of sessions) perDay.set(row.workDate, Number(row.count));

    const days: string[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) days.push(iso(new Date(t)));

    let running = priorTotal;
    const daily: number[] = [];
    const cumulative: number[] = [];
    for (const d of days) {
      const n = perDay.get(d) ?? 0;
      running += n;
      daily.push(n);
      cumulative.push(running);
    }
    return {
      days,
      daily,
      cumulative,
      /** Running total at a flat shift length — the shape behind "to date". */
      safeManHours: cumulative.map((v) => v * SAFE_MAN_HOURS_PER_DAY),
      /** Hours earned each day — the shape behind the window's safe man-hours. */
      dailySafeManHours: daily.map((v) => v * SAFE_MAN_HOURS_PER_DAY),
    };
  }

  /** Sum of every typed metric over a date window. */
  private async totalsOver(user: AuthUser, siteIds: string[] | null, start: Date, end: Date) {
    const grouped = await this.d1.db
      .select({
        metric: dailySafetyEntries.metric,
        total: sql<number>`sum(${dailySafetyEntries.value})`.as('total'),
      })
      .from(dailySafetyEntries)
      .where(
        and(
          eq(dailySafetyEntries.organizationId, user.organizationId),
          gte(dailySafetyEntries.entryDate, iso(start)),
          lte(dailySafetyEntries.entryDate, iso(end)),
          ...(siteIds ? [inArray(dailySafetyEntries.siteId, siteIds)] : []),
        ),
      )
      .groupBy(dailySafetyEntries.metric);
    const out: Partial<Record<SafetyMetric, number>> = {};
    for (const g of grouped) out[g.metric as SafetyMetric] = Number(g.total ?? 0);
    return out;
  }

  /**
   * A YYYY-MM-DD query parameter as a UTC midnight.
   *
   * Checked rather than trusted: `new Date('rubbish')` is an Invalid Date, which
   * Prisma turns into an unreadable driver error somewhere much further down.
   */
  private day(value: string, field: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw Errors.validation({ message: `${field} must be a date, as YYYY-MM-DD` });
    }
    const d = midnight(value);
    // V8 rolls a nonexistent day forward rather than refusing it, so
    // '2026-02-30' parses happily as 2 March. Round-tripping is what catches it.
    if (Number.isNaN(d.getTime()) || iso(d) !== value) {
      throw Errors.validation({ message: `${field} is not a real date` });
    }
    return d;
  }

  /**
   * The window a `period=custom` request means: the two dates it names, both
   * ends inclusive.
   *
   * Capped at a year because the trend chart and the exported PDF draw one
   * point per day — a five-year range is not a chart, it is a smear, and it asks
   * the database for a table nobody can read.
   */
  private customWindow(from?: string, to?: string): { start: Date; end: Date } {
    if (!from || !to) {
      throw Errors.validation({ message: 'A custom range needs both a from and a to date' });
    }
    const start = this.day(from, 'from');
    const end = this.day(to, 'to');
    if (end.getTime() < start.getTime()) {
      throw Errors.validation({ message: 'The from date must not be after the to date' });
    }
    if ((end.getTime() - start.getTime()) / DAY_MS + 1 > MAX_CUSTOM_RANGE_DAYS) {
      throw Errors.validation({
        message: `A custom range covers at most ${MAX_CUSTOM_RANGE_DAYS} days`,
      });
    }
    return { start, end };
  }

  /**
   * Everything the statistics board shows, for one period and one site filter.
   *
   * The headline figures are always "as of" the anchor date rather than summed
   * over the period: a cumulative man-hour total has no meaning added up across
   * a month, and today's manpower is a snapshot by definition.
   */
  async stats(
    user: AuthUser,
    opts: { period?: SafetyPeriod; date?: string; siteId?: string; from?: string; to?: string },
  ) {
    const period = opts.period ?? 'daily';
    const siteIds = this.readScope(user, opts.siteId);

    let start: Date;
    let end: Date;
    let anchor: Date;
    if (period === 'custom') {
      ({ start, end } = this.customWindow(opts.from, opts.to));
      // The three headline cards and the month score read the anchor, and they
      // are "as of" figures. The last day of the range is the day the reader
      // means by "as of now", so a range ending in June does not quietly report
      // today's cumulative manpower.
      anchor = end;
    } else {
      anchor = opts.date ? this.day(opts.date, 'date') : await this.today(user);
      ({ start, end } = safetyWindow(period, anchor));
    }

    /**
     * A daily report still gets a week of trend behind it.
     *
     * Its own window is one day, and a line chart of one day is three dots
     * floating on an axis. The manpower report already answers this the same
     * way — six days of run-up for context — so the two behave alike. Only the
     * chart widens; every total on the page stays inside the chosen period.
     */
    const trendStart = period === 'daily' ? new Date(anchor.getTime() - 6 * DAY_MS) : start;

    const [counts, totals, trend, manpower, siteName] = await Promise.all([
      this.manpowerCounts(user, siteIds, start, end),
      this.totalsOver(user, siteIds, start, end),
      this.trendOver(user, siteIds, trendStart, end),
      // The selected window, on the same run-up rule as the trend: a daily
      // report gets six days of context so the sparklines are lines rather than
      // a single dot, and every other period plots exactly what was chosen.
      this.manpowerSeries(user, siteIds, trendStart, end),
      opts.siteId && opts.siteId !== 'all'
        ? this.d1.db
            .select({ name: sites.name })
            .from(sites)
            .where(
              and(eq(sites.id, opts.siteId), eq(sites.organizationId, user.organizationId)),
            )
            .limit(1)
            .then((rows) => rows[0]?.name ?? null)
        : Promise.resolve(null),
    ]);

    // The observations bars compare the three windows against each other, so all
    // three are needed whichever period is selected.
    const [dailyW, weeklyW, monthlyW] = (['daily', 'weekly', 'monthly'] as const).map((p) =>
      safetyWindow(p, anchor),
    );
    const [dTot, wTot, mTot] = await Promise.all([
      this.totalsOver(user, siteIds, dailyW.start, dailyW.end),
      this.totalsOver(user, siteIds, weeklyW.start, weeklyW.end),
      this.totalsOver(user, siteIds, monthlyW.start, monthlyW.end),
    ]);

    const n = (t: Partial<Record<SafetyMetric, number>>, m: SafetyMetric) => t[m] ?? 0;
    const raised = (t: Partial<Record<SafetyMetric, number>>) =>
      n(t, 'UNSAFE_ACTS') + n(t, 'UNSAFE_CONDITIONS') + n(t, 'SAFETY_OBSERVATION');
    const closed = (t: Partial<Record<SafetyMetric, number>>) =>
      n(t, 'UNSAFE_ACTS_CLOSED') +
      n(t, 'UNSAFE_CONDITIONS_CLOSED') +
      n(t, 'SAFETY_OBSERVATION_CLOSED');

    /**
     * The score follows the selected window, not the calendar month.
     *
     * Switching period used to leave the dial where it was, which read as a
     * broken filter. The inactivity deductions are held back on anything
     * shorter than a month: charging a Tuesday for having no training on it
     * would open every daily report at 96 and say nothing about safety.
     */
    const windowDays = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
    const periodScore = safetyPerformance(totals, {
      scoreInactivity: windowDays >= SCORE_INACTIVITY_MIN_DAYS,
    });

    const derived = {
      // The window's man-days, so the headline moves with the filter.
      DAILY_MANPOWER: counts.inWindow,
      // Still cumulative — "as of" the last day of the window rather than of
      // whichever date happened to be in the picker.
      TOTAL_MANPOWER: counts.toDate,
      // Hours earned inside the window, matching the manpower beside it.
      TOTAL_SAFE_MAN_HOURS: counts.inWindow * SAFE_MAN_HOURS_PER_DAY,
    } satisfies Partial<Record<SafetyMetric, number>>;

    const breakup = [
      { key: 'UNSAFE_ACTS', label: 'Unsafe acts', value: n(totals, 'UNSAFE_ACTS') },
      {
        key: 'UNSAFE_CONDITIONS',
        label: 'Unsafe conditions',
        value: n(totals, 'UNSAFE_CONDITIONS'),
      },
      { key: 'NEAR_MISS', label: 'Near misses', value: n(totals, 'NEAR_MISS') },
      {
        key: 'LOST_TIME_INJURY',
        label: 'Lost time injuries',
        value: n(totals, 'LOST_TIME_INJURY'),
      },
    ];
    const breakupTotal = breakup.reduce((a, b) => a + b.value, 0);

    return {
      period,
      date: iso(anchor),
      from: iso(start),
      to: iso(end),
      siteId: opts.siteId ?? 'all',
      siteName,
      kpis: {
        // Named for what they now measure: two window figures and one running
        // total. The old dailyManpower/totalSafeManHours names described an
        // anchor-date snapshot and would lie about the numbers underneath.
        periodManpower: derived.DAILY_MANPOWER,
        totalManpower: derived.TOTAL_MANPOWER,
        periodSafeManHours: derived.TOTAL_SAFE_MAN_HOURS,
        safetyPerformance: periodScore.score,
        safetyPerformanceDeductions: periodScore.deductions,
        safetyPerformanceTarget: SAFETY_PERFORMANCE_TARGET,
        /** Whether the routine-activity deductions were in play for this window. */
        safetyPerformanceScoredInactivity: windowDays >= SCORE_INACTIVITY_MIN_DAYS,
      },
      trend,
      // Series behind the three headline cards, so each has a shape to plot.
      manpower,
      // The donut: activity that is counted rather than found.
      summary: [
        { key: 'WORK_PERMIT', label: 'Work permit', value: n(totals, 'WORK_PERMIT') },
        { key: 'TRAINING', label: 'Total training', value: n(totals, 'TRAINING') },
        { key: 'WASTE_DISPOSAL', label: 'Waste disposal', value: n(totals, 'WASTE_DISPOSAL') },
        {
          key: 'VISITOR_INDUCTION',
          label: 'Visitor induction',
          value: n(totals, 'VISITOR_INDUCTION'),
        },
      ],
      observations: [
        { bucket: 'Daily', raised: raised(dTot), closed: closed(dTot) },
        { bucket: 'Weekly', raised: raised(wTot), closed: closed(wTot) },
        { bucket: 'Monthly', raised: raised(mTot), closed: closed(mTot) },
      ],
      glance: {
        totalInspection: n(totals, 'SAFETY_INSPECTION'),
        unsafeActsClosed: n(totals, 'UNSAFE_ACTS_CLOSED'),
        unsafeConditionsClosed: n(totals, 'UNSAFE_CONDITIONS_CLOSED'),
      },
      // Every catalogue metric with its period figure, for the big list.
      statistics: METRIC_CATALOG.map((spec) => ({
        metric: spec.metric,
        // The catalogue labels belong to the daily sheet, where every automated
        // figure is one day's. On a board showing a week, "Daily manpower"
        // against a week's man-days is simply the wrong word.
        label: WINDOW_METRIC_LABELS[spec.metric] ?? spec.label,
        kind: spec.kind,
        group: spec.group,
        value:
          spec.kind === 'AUTOMATED'
            ? derived[spec.metric as keyof typeof derived]
            : n(totals, spec.metric),
      })),
      categoryBreakup: {
        total: breakupTotal,
        rows: breakup.map((b) => ({
          ...b,
          percent: breakupTotal > 0 ? Math.round((b.value / breakupTotal) * 100) : 0,
        })),
      },
      reportingSummary: {
        daily: raised(dTot) + closed(dTot),
        weekly: raised(wTot) + closed(wTot),
        monthly: raised(mTot) + closed(mTot),
      },
    };
  }

  /**
   * The trend lines: inductions, toolbox talks and visitor inductions per day.
   *
   * A day with nothing recorded plots as zero rather than being skipped, so the
   * line does not silently join across a gap and imply a level that was never
   * entered.
   */
  private async trendOver(user: AuthUser, siteIds: string[] | null, start: Date, end: Date) {
    const metrics: SafetyMetric[] = ['LABOUR_INDUCTION', 'TOOLBOX_TALK', 'VISITOR_INDUCTION'];
    const rows = await this.d1.db
      .select({
        entryDate: dailySafetyEntries.entryDate,
        metric: dailySafetyEntries.metric,
        value: dailySafetyEntries.value,
      })
      .from(dailySafetyEntries)
      .where(
        and(
          eq(dailySafetyEntries.organizationId, user.organizationId),
          inArray(dailySafetyEntries.metric, [...metrics]),
          gte(dailySafetyEntries.entryDate, iso(start)),
          lte(dailySafetyEntries.entryDate, iso(end)),
          ...(siteIds ? [inArray(dailySafetyEntries.siteId, siteIds)] : []),
        ),
      );

    const days: string[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) days.push(iso(new Date(t)));
    const index = new Map(days.map((d, i) => [d, i]));
    const series = metrics.map((m) => ({
      metric: m,
      label: specFor(m)?.label ?? m,
      values: new Array<number>(days.length).fill(0),
    }));
    for (const r of rows) {
      const i = index.get(r.entryDate);
      const s = series.find((x) => x.metric === r.metric);
      if (i !== undefined && s) s.values[i] += r.value ?? 0;
    }
    return { days, series };
  }

  /**
   * The statistics board as a PDF, for the review meeting.
   *
   * Renders from exactly the `stats` payload the screen draws, so an exported
   * sheet cannot disagree with the page it was exported from.
   */
  async statsPdf(
    user: AuthUser,
    opts: { period?: SafetyPeriod; date?: string; siteId?: string; from?: string; to?: string },
  ) {
    const s = await this.stats(user, opts);
    const [org] = await this.d1.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, user.organizationId))
      .limit(1);
    const periodName =
      s.period === 'custom' ? 'Custom range' : s.period[0].toUpperCase() + s.period.slice(1);
    const fmtDay = (v: string) =>
      new Date(`${v}T00:00:00.000Z`).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });

    const buffer = await renderSafetyPdf(
      {
        periodLabel: s.from === s.to ? fmtDay(s.from) : `${fmtDay(s.from)} — ${fmtDay(s.to)}`,
        from: s.from,
        to: s.to,
        siteName: s.siteName,
        kpis: s.kpis,
        safetyPerformanceDeductions: s.kpis.safetyPerformanceDeductions,
        trend: {
          days: s.trend.days,
          series: s.trend.series.map((x) => ({ label: x.label, values: x.values })),
        },
        observations: s.observations,
        statistics: s.statistics.map((x) => ({ label: x.label, kind: x.kind, value: x.value })),
        categoryBreakup: { rows: s.categoryBreakup.rows },
      },
      org?.name ?? '',
      periodName,
    );

    // A custom export is named by the range it covers; one anchor date would
    // give every range that ends on the same day the same filename.
    const stamp = s.period === 'custom' ? `${s.from}_to_${s.to}` : s.date;
    return { buffer, filename: `safety-${s.period}-${stamp}.pdf` };
  }

  /** The metric catalogue, so a client never hardcodes twenty-one labels. */
  catalog() {
    return {
      metrics: METRIC_CATALOG,
      safeManHoursPerDay: SAFE_MAN_HOURS_PER_DAY,
      performanceTarget: SAFETY_PERFORMANCE_TARGET,
    };
  }
}
