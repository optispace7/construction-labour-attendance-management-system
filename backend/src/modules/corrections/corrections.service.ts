import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { CorrectionStatus } from '../../common/enums';
import { D1Service } from '../../infra/d1/d1.service';
import {
  attendanceSessions,
  correctionItems,
  correctionRequests,
  users,
  workers,
} from '../../infra/d1/schema.generated';
import { applyCorrectionOnD1 } from '../../infra/d1/correction-apply.d1';
import { chunked } from '../../infra/d1/chunked';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { CreateCorrectionDto, ReviewCorrectionDto } from './dto/correction.dto';

/** A correction item as callers read it: the value parsed back out of its text. */
function parseItem(row: typeof correctionItems.$inferSelect) {
  let proposedValue: unknown = null;
  try {
    proposedValue = JSON.parse(row.proposedValue);
  } catch {
    proposedValue = row.proposedValue;
  }
  return { ...row, proposedValue };
}

@Injectable()
export class CorrectionsService {
  constructor(
    private readonly d1: D1Service,
    private readonly audit: AuditService,
  ) {}

  /**
   * May this person's corrections skip the queue?
   *
   * Read from the row on every call rather than from the token: the grant is
   * per person and the Super Admin must be able to take it back now, not
   * fifteen minutes from now when an access token happens to expire.
   */
  private async mayApplyDirectly(user: AuthUser): Promise<boolean> {
    const [row] = await this.d1.db
      .select({ canApplyCorrections: users.canApplyCorrections })
      .from(users)
      .where(
        and(
          eq(users.id, user.userId),
          eq(users.organizationId, user.organizationId),
          // A deleted account keeps nothing, including this.
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    return row?.canApplyCorrections ?? false;
  }

  /** A request with its items, in the shape the panel reads. */
  private async withItems(id: string) {
    const [request] = await this.d1.db
      .select()
      .from(correctionRequests)
      .where(eq(correctionRequests.id, id))
      .limit(1);
    if (!request) throw Errors.notFound('Correction request');
    const items = await this.d1.db
      .select()
      .from(correctionItems)
      .where(eq(correctionItems.requestId, id));
    return { ...request, items: items.map(parseItem) };
  }

  async create(user: AuthUser, dto: CreateCorrectionDto) {
    const applyNow = await this.mayApplyDirectly(user);
    const id = randomUUID();
    const now = new Date();

    const recordFiling = () =>
      this.audit.record({
        organizationId: user.organizationId,
        actorUserId: user.userId,
        actorRole: user.role,
        action: 'CORRECTION_REQUEST',
        entityType: 'CorrectionRequest',
        entityId: id,
        newValue: { type: dto.type, reason: dto.reason, items: dto.items, autoApplied: applyNow },
      });

    // The request and its items go in one batch: Prisma's nested create, and
    // for the same reason — a request with no items is a correction that
    // proposes nothing, which no reviewer could act on.
    await this.d1.db.batch([
      this.d1.db.insert(correctionRequests).values({
        id,
        organizationId: user.organizationId,
        workerId: dto.workerId,
        siteId: dto.siteId,
        sessionId: dto.sessionId ?? null,
        // A calendar day, stored as text.
        workDate: new Date(dto.workDate).toISOString().slice(0, 10),
        type: dto.type,
        reason: dto.reason,
        notes: dto.notes ?? null,
        requestedBy: user.userId,
        status: 'PENDING',
        autoApplied: false,
        createdAt: now,
        updatedAt: now,
      }),
      this.d1.db.insert(correctionItems).values(
        dto.items.map((i) => ({
          id: randomUUID(),
          requestId: id,
          field: i.field,
          // Serialised here: the column is text on SQLite, and handing it an
          // object stores "[object Object]".
          proposedValue: JSON.stringify(i.proposedValue),
        })),
      ),
    ] as never);

    if (!applyNow) {
      await recordFiling();
      return this.withItems(id);
    }

    // Filed and applied in immediate succession: a request that was never going
    // to wait for a reviewer must not survive its own failed application and
    // sit in the queue as if somebody still had to look at it. The apply step
    // is the same one an approver runs, and it is itself one guarded batch.
    try {
      const applied = await applyCorrectionOnD1(
        this.d1.d1,
        { userId: user.userId, organizationId: user.organizationId },
        id,
        { reviewNotes: dto.notes, autoApplied: true },
      );
      await recordFiling();
      await this.recordApply(user, id, applied, { reviewNotes: dto.notes, autoApplied: true });
    } catch (e) {
      // The apply failed, so the request must not be left PENDING — nobody
      // filed it for review, and a queue entry nobody expects is worse than
      // the error the author is about to see.
      await this.d1.db
        .update(correctionRequests)
        .set({ status: 'CANCELLED', updatedAt: new Date() })
        .where(eq(correctionRequests.id, id));
      throw e;
    }
    return this.withItems(id);
  }

  async list(
    user: AuthUser,
    status?: CorrectionStatus,
    siteId?: string,
    workerId?: string,
    autoApplied?: boolean,
  ) {
    const filters: SQL[] = [eq(correctionRequests.organizationId, user.organizationId)];
    if (status) filters.push(eq(correctionRequests.status, status));
    if (siteId) filters.push(eq(correctionRequests.siteId, siteId));
    if (workerId) filters.push(eq(correctionRequests.workerId, workerId));
    if (autoApplied !== undefined) filters.push(eq(correctionRequests.autoApplied, autoApplied));

    const rows = await this.d1.db
      .select({
        request: correctionRequests,
        workerFullName: workers.fullName,
        workerCode: workers.workerCode,
      })
      .from(correctionRequests)
      .innerJoin(workers, eq(workers.id, correctionRequests.workerId))
      .where(and(...filters))
      .orderBy(desc(correctionRequests.createdAt));

    // The items for the whole page, rather than one query per row — read in
    // chunks because D1 binds at most 100 parameters and this list is as long
    // as the page.
    const items = await chunked(
      rows.map((r) => r.request.id),
      (ids) =>
        this.d1.db.select().from(correctionItems).where(inArray(correctionItems.requestId, ids)),
    );
    const itemsFor = new Map<string, ReturnType<typeof parseItem>[]>();
    for (const i of items) {
      const list = itemsFor.get(i.requestId) ?? [];
      list.push(parseItem(i));
      itemsFor.set(i.requestId, list);
    }

    // Resolve the requester/reviewer UUIDs to human names so the admin sees
    // *who* filed each correction and who reviewed it, not raw IDs.
    const userIds = [
      ...new Set(
        rows
          .flatMap((r) => [r.request.requestedBy, r.request.reviewedBy])
          .filter(Boolean) as string[],
      ),
    ];
    const people = await chunked(userIds, (ids) =>
      this.d1.db
        .select({ id: users.id, fullName: users.fullName, role: users.role })
        .from(users)
        .where(inArray(users.id, ids)),
    );
    const nameOf = new Map(people.map((u) => [u.id, u.fullName]));

    return rows.map((r) => ({
      ...r.request,
      items: itemsFor.get(r.request.id) ?? [],
      worker: { fullName: r.workerFullName, workerCode: r.workerCode },
      requestedByName: nameOf.get(r.request.requestedBy) ?? null,
      reviewedByName: r.request.reviewedBy ? (nameOf.get(r.request.reviewedBy) ?? null) : null,
    }));
  }

  async get(user: AuthUser, id: string) {
    const [req] = await this.d1.db
      .select()
      .from(correctionRequests)
      .where(
        and(
          eq(correctionRequests.id, id),
          eq(correctionRequests.organizationId, user.organizationId),
        ),
      )
      .limit(1);
    if (!req) throw Errors.notFound('Correction request');

    const items = await this.d1.db
      .select()
      .from(correctionItems)
      .where(eq(correctionItems.requestId, id));
    const [session] = req.sessionId
      ? await this.d1.db
          .select()
          .from(attendanceSessions)
          .where(eq(attendanceSessions.id, req.sessionId))
          .limit(1)
      : [];
    return { ...req, items: items.map(parseItem), session: session ?? null };
  }

  async cancel(user: AuthUser, id: string) {
    const req = await this.get(user, id);
    if (req.status !== 'PENDING')
      throw Errors.businessRule('Only pending requests can be cancelled');
    await this.d1.db
      .update(correctionRequests)
      .set({ status: 'CANCELLED', updatedAt: new Date() })
      .where(eq(correctionRequests.id, id));
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'CORRECTION_CANCEL',
      entityType: 'CorrectionRequest',
      entityId: id,
    });
    return this.get(user, id);
  }

  async reject(user: AuthUser, id: string, dto: ReviewCorrectionDto) {
    const req = await this.get(user, id);
    if (req.status !== 'PENDING') throw Errors.businessRule('Request is not pending');
    await this.d1.db
      .update(correctionRequests)
      .set({
        status: 'REJECTED',
        reviewedBy: user.userId,
        reviewedAt: new Date(),
        reviewNotes: dto.reviewNotes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(correctionRequests.id, id));
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'CORRECTION_REJECT',
      entityType: 'CorrectionRequest',
      entityId: id,
      reason: dto.reviewNotes,
    });
    return this.get(user, id);
  }

  /**
   * APPROVE — a reviewer signs off a request somebody else filed.
   *
   * The work happens in applyCorrectionOnD1, which is the only path that
   * mutates attendance from a correction and is shared with the author who
   * holds canApplyCorrections. It reads and decides first, then commits the
   * session change and the APPROVED stamp as one guarded batch — so a request
   * can never be marked approved without the attendance having moved, and a
   * session that changed under it fails the guard instead of being overwritten.
   */
  async approve(user: AuthUser, id: string, dto: ReviewCorrectionDto) {
    const applied = await applyCorrectionOnD1(
      this.d1.d1,
      { userId: user.userId, organizationId: user.organizationId },
      id,
      { reviewNotes: dto.reviewNotes },
    );
    await this.recordApply(user, id, applied, dto);
    return this.get(user, id);
  }

  /** The audit row for an apply, whichever of the two paths ran it. */
  private async recordApply(
    user: AuthUser,
    id: string,
    applied: Awaited<ReturnType<typeof applyCorrectionOnD1>>,
    dto: ReviewCorrectionDto & { autoApplied?: boolean },
  ) {
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      // A distinct action, so "who changed attendance without review" is a
      // question the audit log can answer on its own.
      action: dto.autoApplied ? 'CORRECTION_AUTO_APPLY' : 'CORRECTION_APPROVE',
      entityType: 'AttendanceSession',
      entityId: applied.sessionId ?? id,
      oldValue: applied.before,
      newValue: applied.after,
      reason: dto.reviewNotes,
    });
  }
}
