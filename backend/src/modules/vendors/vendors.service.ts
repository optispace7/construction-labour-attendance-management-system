import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { D1Service } from '../../infra/d1/d1.service';
import { vendors, workers, workerSiteAssignments } from '../../infra/d1/schema.generated';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { CreateVendorDto, UpdateVendorDto } from './dto/vendor.dto';

type VendorInsert = typeof vendors.$inferInsert;

@Injectable()
export class VendorsService {
  constructor(
    private readonly d1: D1Service,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser) {
    return this.d1.db
      .select()
      .from(vendors)
      .where(eq(vendors.organizationId, user.organizationId))
      .orderBy(asc(vendors.name));
  }

  async get(user: AuthUser, id: string) {
    const [vendor] = await this.d1.db
      .select()
      .from(vendors)
      .where(and(eq(vendors.id, id), eq(vendors.organizationId, user.organizationId)))
      .limit(1);
    if (!vendor) throw Errors.notFound('Vendor');
    return vendor;
  }

  async create(user: AuthUser, dto: CreateVendorDto) {
    const now = new Date();
    const [vendor] = await this.d1.db
      .insert(vendors)
      .values({
        ...(dto as Partial<VendorInsert>),
        id: randomUUID(),
        organizationId: user.organizationId,
        createdAt: now,
        updatedAt: now,
      } as VendorInsert)
      .returning();

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'VENDOR_CREATE',
      entityType: 'Vendor',
      entityId: vendor.id,
      newValue: vendor,
    });
    return vendor;
  }

  async update(user: AuthUser, id: string, dto: UpdateVendorDto) {
    const before = await this.get(user, id);
    const [vendor] = await this.d1.db
      .update(vendors)
      .set({ ...(dto as Partial<VendorInsert>), updatedAt: new Date() })
      .where(eq(vendors.id, id))
      .returning();

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'VENDOR_UPDATE',
      entityType: 'Vendor',
      entityId: id,
      oldValue: before,
      newValue: vendor,
    });
    return vendor;
  }

  /** Hard-delete when unreferenced; otherwise deactivate so history stays intact. */
  async remove(user: AuthUser, id: string) {
    const vendor = await this.get(user, id);

    const [[{ n: workerCount }], [{ n: assignmentCount }]] = await Promise.all([
      this.d1.db
        .select({ n: count() })
        .from(workers)
        .where(and(eq(workers.vendorId, id), isNull(workers.deletedAt))),
      this.d1.db
        .select({ n: count() })
        .from(workerSiteAssignments)
        .where(eq(workerSiteAssignments.vendorId, id)),
    ]);

    if (workerCount > 0 || assignmentCount > 0) {
      await this.d1.db
        .update(vendors)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(vendors.id, id));
      await this.audit.record({
        organizationId: user.organizationId,
        actorUserId: user.userId,
        actorRole: user.role,
        action: 'VENDOR_DEACTIVATE',
        entityType: 'Vendor',
        entityId: id,
        oldValue: vendor,
        reason:
          `${workerCount} worker(s) / ${assignmentCount} assignment(s) still reference ` +
          'this vendor',
      });
      return { deleted: false, deactivated: true, workersAssigned: workerCount };
    }

    await this.d1.db.delete(vendors).where(eq(vendors.id, id));
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'VENDOR_DELETE',
      entityType: 'Vendor',
      entityId: id,
      oldValue: vendor,
    });
    return { deleted: true };
  }
}
