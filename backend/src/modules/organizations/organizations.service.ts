import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { D1Service } from '../../infra/d1/d1.service';
import { organizations } from '../../infra/d1/schema.generated';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import {
  CreateOrganizationDto,
  UpdateOrganizationDto,
  UpdateOrganizationProfileDto,
} from './dto/organization.dto';

type OrganizationInsert = typeof organizations.$inferInsert;

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly d1: D1Service,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.d1.db.select().from(organizations).orderBy(desc(organizations.createdAt));
  }

  /** The caller's own organization (company profile for the ID card). */
  getCurrent(user: AuthUser) {
    return this.get(user.organizationId);
  }

  /** Update the caller's own company profile. Editable by Super + Site Admin. */
  async updateProfile(user: AuthUser, dto: UpdateOrganizationProfileDto) {
    const before = await this.get(user.organizationId);
    // Blank strings clear the field; undefined leaves it untouched; numbers pass through.
    const data: Record<string, string | number | null> = {};
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue;
      data[k] = typeof v === 'string' && v.trim() === '' ? null : v;
    }
    const [org] = await this.d1.db
      .update(organizations)
      .set({ ...(data as Partial<OrganizationInsert>), updatedAt: new Date() })
      .where(eq(organizations.id, user.organizationId))
      .returning();

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'ORG_PROFILE_UPDATE',
      entityType: 'Organization',
      entityId: user.organizationId,
      oldValue: before,
      newValue: org,
    });
    return org;
  }

  async get(id: string) {
    const [org] = await this.d1.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);
    if (!org) throw Errors.notFound('Organization');
    return org;
  }

  async create(user: AuthUser, dto: CreateOrganizationDto) {
    const now = new Date();
    const [org] = await this.d1.db
      .insert(organizations)
      .values({
        ...(dto as Partial<OrganizationInsert>),
        // SQLite has no uuid default and the generated schema carries no
        // defaults at all, so identity and timestamps are stated here.
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
      } as OrganizationInsert)
      .returning();

    await this.audit.record({
      organizationId: org.id,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'ORG_CREATE',
      entityType: 'Organization',
      entityId: org.id,
      newValue: org,
    });
    return org;
  }

  async update(user: AuthUser, id: string, dto: UpdateOrganizationDto) {
    const before = await this.get(id);
    const [org] = await this.d1.db
      .update(organizations)
      .set({ ...(dto as Partial<OrganizationInsert>), updatedAt: new Date() })
      .where(eq(organizations.id, id))
      .returning();

    await this.audit.record({
      organizationId: id,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'ORG_UPDATE',
      entityType: 'Organization',
      entityId: id,
      oldValue: before,
      newValue: org,
    });
    return org;
  }
}
