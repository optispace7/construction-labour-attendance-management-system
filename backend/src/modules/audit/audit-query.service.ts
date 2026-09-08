import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt, lte, notInArray, type SQL } from 'drizzle-orm';
import { D1Service } from '../../infra/d1/d1.service';
import { chunked } from '../../infra/d1/chunked';
import {
  auditLogs,
  correctionRequests,
  designations,
  devices,
  shifts,
  sites,
  users,
  vendors,
  workers,
} from '../../infra/d1/schema.generated';
import { AuthUser } from '../../common/auth/auth-user.interface';

export interface AuditQuery {
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  action?: string;
  /** Actions to leave out — lets a summary feed drop high-volume scan events. */
  excludeActions?: string[];
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

type AuditRow = typeof auditLogs.$inferSelect;

@Injectable()
export class AuditQueryService {
  constructor(private readonly d1: D1Service) {}

  async query(user: AuthUser, q: AuditQuery) {
    const limit = Math.min(q.limit ?? 50, 200);

    const filters: SQL[] = [eq(auditLogs.organizationId, user.organizationId)];
    if (q.entityType) filters.push(eq(auditLogs.entityType, q.entityType));
    if (q.entityId) filters.push(eq(auditLogs.entityId, q.entityId));
    if (q.actorUserId) filters.push(eq(auditLogs.actorUserId, q.actorUserId));
    if (q.action) filters.push(eq(auditLogs.action, q.action));
    if (q.excludeActions?.length) filters.push(notInArray(auditLogs.action, q.excludeActions));
    if (q.from) filters.push(gte(auditLogs.createdAt, new Date(q.from)));
    if (q.to) filters.push(lte(auditLogs.createdAt, new Date(q.to)));

    // Prisma's cursor took an id and skipped it. Here the same thing is said
    // directly: rows are ordered newest first and the page after a cursor is
    // everything with a smaller id, which is stable even when two entries share
    // a timestamp — the id is monotonic and created_at is not unique.
    if (q.cursor) filters.push(lt(auditLogs.id, Number(q.cursor)));

    const rows = await this.d1.db
      .select()
      .from(auditLogs)
      .where(and(...filters))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit + 1);

    const nextCursor = rows.length > limit ? String(rows[limit].id) : null;
    const page = rows.slice(0, limit);
    const names = await this.resolveNames(page);

    const data = page.map((r) => ({
      ...r,
      id: String(r.id),
      // Stored as JSON text; the panel expects objects, as it got from jsonb.
      oldValue: parse(r.oldValue),
      newValue: parse(r.newValue),
      actorName: r.actorUserId ? (names.users.get(r.actorUserId) ?? null) : null,
      entityName: r.entityId ? (names.byType(r.entityType)?.get(r.entityId) ?? null) : null,
    }));
    return { data, nextCursor };
  }

  /** Batch-resolve actor users and referenced entities to display names. */
  private async resolveNames(rows: AuditRow[]) {
    const idsOf = (type: string) => [
      ...new Set(
        rows.filter((r) => r.entityType === type && r.entityId).map((r) => r.entityId as string),
      ),
    ];
    const userIds = [
      ...new Set([
        ...(rows.map((r) => r.actorUserId).filter(Boolean) as string[]),
        ...idsOf('User'),
      ]),
    ];
    const workerIds = idsOf('Worker');
    const siteIds = idsOf('Site');
    const vendorIds = idsOf('Vendor');
    const designationIds = idsOf('Designation');
    const deviceIds = idsOf('Device');
    const correctionIds = idsOf('CorrectionRequest');
    const shiftIds = idsOf('Shift');

    const db = this.d1.db;
    // Each list is as long as the page of audit rows it came from, so the
    // reads are chunked — D1 binds at most 100 parameters per query.
    const pick = <T>(ids: string[], run: (batch: string[]) => Promise<T[]>) =>
      chunked(ids, run);

    const [
      userRows, workerRows, siteRows, vendorRows,
      designationRows, deviceRows, correctionRows, shiftRows,
    ] = await Promise.all([
      pick(userIds, (batch) =>
        db.select({ id: users.id, fullName: users.fullName }).from(users)
          .where(inArray(users.id, batch))),
      pick(workerIds, (batch) =>
        db.select({ id: workers.id, fullName: workers.fullName, workerCode: workers.workerCode })
          .from(workers).where(inArray(workers.id, batch))),
      pick(siteIds, (batch) =>
        db.select({ id: sites.id, name: sites.name }).from(sites)
          .where(inArray(sites.id, batch))),
      pick(vendorIds, (batch) =>
        db.select({ id: vendors.id, name: vendors.name }).from(vendors)
          .where(inArray(vendors.id, batch))),
      pick(designationIds, (batch) =>
        db.select({ id: designations.id, name: designations.name }).from(designations)
          .where(inArray(designations.id, batch))),
      pick(deviceIds, (batch) =>
        db.select({ id: devices.id, label: devices.label, deviceUid: devices.deviceUid })
          .from(devices).where(inArray(devices.id, batch))),
      // Prisma fetched the worker through the relation. There is no relation
      // loader here, so it is a join — one query either way.
      pick(correctionIds, (batch) =>
        db.select({
            id: correctionRequests.id,
            fullName: workers.fullName,
            workerCode: workers.workerCode,
          })
          .from(correctionRequests)
          .innerJoin(workers, eq(workers.id, correctionRequests.workerId))
          .where(inArray(correctionRequests.id, batch))),
      pick(shiftIds, (batch) =>
        db.select({ id: shifts.id, name: shifts.name }).from(shifts)
          .where(inArray(shifts.id, batch))),
    ]);

    return {
      users: new Map(userRows.map((u) => [u.id, u.fullName])),
      workers: new Map(workerRows.map((w) => [w.id, `${w.fullName} (${w.workerCode})`])),
      sites: new Map(siteRows.map((s) => [s.id, s.name])),
      vendors: new Map(vendorRows.map((v) => [v.id, v.name])),
      designations: new Map(designationRows.map((d) => [d.id, d.name])),
      devices: new Map(deviceRows.map((d) => [d.id, d.label ?? d.deviceUid])),
      corrections: new Map(
        correctionRows.map((c) => [c.id, `${c.fullName} (${c.workerCode})`]),
      ),
      shifts: new Map(shiftRows.map((s) => [s.id, s.name])),
      byType(type: string): Map<string, string> | undefined {
        switch (type) {
          case 'User':
            return this.users;
          case 'Worker':
            return this.workers;
          case 'Site':
            return this.sites;
          case 'Vendor':
            return this.vendors;
          case 'Designation':
            return this.designations;
          case 'Device':
            return this.devices;
          case 'CorrectionRequest':
            return this.corrections;
          case 'Shift':
            return this.shifts;
          default:
            return undefined;
        }
      },
    };
  }
}

/** Text back to the object the panel expects; bad JSON reads as absent. */
function parse(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
