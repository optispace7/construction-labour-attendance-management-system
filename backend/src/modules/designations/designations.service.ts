import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { D1Service } from '../../infra/d1/d1.service';
import { designations, workers } from '../../infra/d1/schema.generated';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { CreateDesignationDto, UpdateDesignationDto } from './dto/designation.dto';

@Injectable()
export class DesignationsService {
  constructor(
    private readonly d1: D1Service,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser, includeInactive = false) {
    return this.d1.db
      .select()
      .from(designations)
      .where(
        includeInactive
          ? eq(designations.organizationId, user.organizationId)
          : and(
              eq(designations.organizationId, user.organizationId),
              eq(designations.isActive, true),
            ),
      )
      .orderBy(asc(designations.name));
  }

  async create(user: AuthUser, dto: CreateDesignationDto) {
    // Prisma's `mode: 'insensitive'` has no SQLite equivalent, so the
    // comparison is spelled out. Without it "Mason" and "mason" both get
    // created and the dropdown grows a duplicate nobody can tell apart.
    const [existing] = await this.d1.db
      .select()
      .from(designations)
      .where(
        and(
          eq(designations.organizationId, user.organizationId),
          sql`lower(${designations.name}) = lower(${dto.name})`,
        ),
      )
      .limit(1);
    if (existing) throw Errors.conflict(`Designation "${dto.name}" already exists`);

    // Ids are generated here rather than by the database: SQLite has no uuid
    // default, and every other id in this system is a UUID.
    const now = new Date();
    const [designation] = await this.d1.db
      .insert(designations)
      .values({
        id: randomUUID(),
        organizationId: user.organizationId,
        name: dto.name.trim(),
        isActive: true,
        createdAt: now,
        // Explicit because the generated schema carries no defaults: every row
        // being migrated already had a value, and a default that disagreed with
        // Postgres's would only show up on rows written later.
        updatedAt: now,
      })
      .returning();

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'DESIGNATION_CREATE',
      entityType: 'Designation',
      entityId: designation.id,
      newValue: designation,
    });
    return designation;
  }

  async update(user: AuthUser, id: string, dto: UpdateDesignationDto) {
    const [before] = await this.d1.db
      .select()
      .from(designations)
      .where(and(eq(designations.id, id), eq(designations.organizationId, user.organizationId)))
      .limit(1);
    if (!before) throw Errors.notFound('Designation');

    const [designation] = await this.d1.db
      .update(designations)
      .set({
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(eq(designations.id, id))
      .returning();

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'DESIGNATION_UPDATE',
      entityType: 'Designation',
      entityId: id,
      oldValue: before,
      newValue: designation,
    });
    return designation;
  }

  /** Hard-delete when unused; otherwise deactivate so history stays intact. */
  async remove(user: AuthUser, id: string) {
    const [designation] = await this.d1.db
      .select()
      .from(designations)
      .where(and(eq(designations.id, id), eq(designations.organizationId, user.organizationId)))
      .limit(1);
    if (!designation) throw Errors.notFound('Designation');

    const [{ n: inUse }] = await this.d1.db
      .select({ n: count() })
      .from(workers)
      .where(and(eq(workers.designationId, id), isNull(workers.deletedAt)));

    if (inUse > 0) {
      await this.d1.db
        .update(designations)
        .set({ isActive: false })
        .where(eq(designations.id, id));
      await this.audit.record({
        organizationId: user.organizationId,
        actorUserId: user.userId,
        actorRole: user.role,
        action: 'DESIGNATION_DEACTIVATE',
        entityType: 'Designation',
        entityId: id,
        oldValue: designation,
        reason: `${inUse} worker(s) still assigned`,
      });
      return { deleted: false, deactivated: true, workersAssigned: inUse };
    }

    await this.d1.db.delete(designations).where(eq(designations.id, id));
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'DESIGNATION_DELETE',
      entityType: 'Designation',
      entityId: id,
      oldValue: designation,
    });
    return { deleted: true };
  }
}
