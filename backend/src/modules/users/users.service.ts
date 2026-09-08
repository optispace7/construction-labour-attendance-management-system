import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { D1Service } from '../../infra/d1/d1.service';
import { chunked } from '../../infra/d1/chunked';
import { devices, userSiteScopes, users } from '../../infra/d1/schema.generated';
import { IdentityService } from '../../common/better-auth/identity.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { CreateUserDto, SetSiteScopesDto, UpdateUserDto } from './dto/user.dto';

type UserRole = 'SUPER_ADMIN' | 'SITE_ADMIN' | 'SUPERVISOR' | 'WATCHMAN';

/** The columns the panel is allowed to see. A password never was among them. */
const PUBLIC_COLUMNS = {
  id: users.id,
  role: users.role,
  fullName: users.fullName,
  email: users.email,
  username: users.username,
  phone: users.phone,
  isActive: users.isActive,
  canApplyCorrections: users.canApplyCorrections,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  organizationId: users.organizationId,
};

/**
 * Role hierarchy for user management: an Admin (SITE_ADMIN) may only manage
 * Safety Officers and Watchmen. Admin accounts themselves (password/email
 * changes, deactivation) are managed by the Super Admin.
 */
const MANAGEABLE: Record<UserRole, UserRole[]> = {
  SUPER_ADMIN: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR', 'WATCHMAN'],
  SITE_ADMIN: ['SUPERVISOR', 'WATCHMAN'],
  SUPERVISOR: [],
  WATCHMAN: [],
};

@Injectable()
export class UsersService {
  constructor(
    private readonly d1: D1Service,
    private readonly identity: IdentityService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Handing out the approval bypass is the Super Admin's alone.
   *
   * An Admin manages Safety Officer accounts, so without this they could grant
   * an officer the right to apply corrections unreviewed — or grant it to
   * themselves through an account they control — which is a way around the
   * approval step rather than a use of it.
   */
  private assertCanGrantDirectApply(actor: AuthUser, requested: boolean | undefined) {
    if (requested === undefined) return;
    if (actor.role !== 'SUPER_ADMIN') {
      throw Errors.forbidden(
        'Only the Super Admin can decide whose corrections apply without approval.',
      );
    }
  }

  private assertCanManage(actor: AuthUser, targetRole: string) {
    if (!MANAGEABLE[actor.role as UserRole]?.includes(targetRole as UserRole)) {
      throw Errors.forbidden(
        actor.role === 'SITE_ADMIN'
          ? 'Admins can only manage Safety Officer and Watchman accounts — ask your Super Admin.'
          : 'Not allowed to manage this account.',
      );
    }
  }

  /**
   * Attaches each user's site scopes.
   *
   * Prisma nested this through a relation select. Here it is one extra query
   * for the whole page rather than one per row — the shape callers receive is
   * unchanged, which is the part that matters.
   */
  private async withScopes<T extends { id: string }>(rows: T[]) {
    if (!rows.length) return [] as (T & { siteScopes: { siteId: string }[] })[];
    const scopes = await chunked(
      rows.map((r) => r.id),
      (ids) =>
        this.d1.db
          .select({ userId: userSiteScopes.userId, siteId: userSiteScopes.siteId })
          .from(userSiteScopes)
          .where(inArray(userSiteScopes.userId, ids)),
    );
    const byUser = new Map<string, { siteId: string }[]>();
    for (const s of scopes) {
      const list = byUser.get(s.userId) ?? [];
      list.push({ siteId: s.siteId });
      byUser.set(s.userId, list);
    }
    return rows.map((r) => ({ ...r, siteScopes: byUser.get(r.id) ?? [] }));
  }

  async list(user: AuthUser) {
    const rows = await this.d1.db
      .select(PUBLIC_COLUMNS)
      .from(users)
      .where(and(eq(users.organizationId, user.organizationId), isNull(users.deletedAt)))
      .orderBy(desc(users.createdAt));
    return this.withScopes(rows);
  }

  async get(user: AuthUser, id: string) {
    const [found] = await this.d1.db
      .select(PUBLIC_COLUMNS)
      .from(users)
      .where(
        and(
          eq(users.id, id),
          eq(users.organizationId, user.organizationId),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!found) throw Errors.notFound('User');
    const [withScopes] = await this.withScopes([found]);
    return withScopes;
  }

  async create(user: AuthUser, dto: CreateUserDto) {
    this.assertCanManage(user, dto.role);
    this.assertCanGrantDirectApply(user, dto.canApplyCorrections);
    // Watchmen sign in with a user ID (no email); every other role resets
    // passwords via email, so an address is mandatory for them.
    if (dto.role === 'WATCHMAN' && !dto.username?.trim()) {
      throw Errors.businessRule('Watchman accounts need a user ID (username).');
    }
    if (dto.role !== 'WATCHMAN' && !dto.email?.trim()) {
      throw Errors.businessRule('Email is required for this role (used for password reset).');
    }

    const id = randomUUID();
    const now = new Date();
    // Typed loosely on purpose: a batch mixes statements against different
    // tables, and inferring the array from its first element pins it to that
    // one table.
    const writes: unknown[] = [
      this.d1.db
        .insert(users)
        .values({
          id,
          organizationId: user.organizationId,
          role: dto.role,
          fullName: dto.fullName,
          email: dto.email?.trim() || null,
          username: dto.username?.trim() || null,
          phone: dto.phone ?? null,
          canApplyCorrections: dto.canApplyCorrections ?? false,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        }),
    ];
    // Prisma created the scope rows through the nested write; here they are
    // part of the same batch, so a user cannot appear without them.
    if (dto.siteIds?.length) {
      writes.push(
        this.d1.db
          .insert(userSiteScopes)
          .values(dto.siteIds.map((siteId) => ({ userId: id, siteId }))),
      );
    }
    await this.d1.db.batch(writes as never);

    // The account is not usable until Better Auth knows about it: the user row
    // carries what they may do, and the identity rows are what a login reads.
    await this.identity.create({
      id,
      fullName: dto.fullName,
      email: dto.email?.trim() || null,
      username: dto.username?.trim() || null,
      password: dto.password,
    });

    const created = await this.get(user, id);
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'USER_CREATE',
      entityType: 'User',
      entityId: id,
      newValue: { role: created.role, email: created.email, username: created.username },
    });
    return created;
  }

  async update(user: AuthUser, id: string, dto: UpdateUserDto) {
    const target = await this.get(user, id);
    // Editing yourself (profile/password) is always allowed; editing others
    // follows the role hierarchy.
    if (id !== user.userId) this.assertCanManage(user, target.role);
    if (dto.role && dto.role !== target.role) this.assertCanManage(user, dto.role);
    this.assertCanGrantDirectApply(user, dto.canApplyCorrections);

    // undefined = key absent = leave the column alone. null (or a blank string)
    // = clear it, which frees the email/username for reuse. Mapping blanks to
    // undefined, as this used to, silently ignored every attempt to clear one.
    const clearable = (v: string | null | undefined): string | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      return v.trim() || null;
    };

    const email = clearable(dto.email);
    const username = clearable(dto.username);

    // Whatever the edit leaves behind must still be able to sign in: watchmen
    // by username, everyone else by email.
    const role = dto.role ?? target.role;
    const nextEmail = email === undefined ? target.email : email;
    const nextUsername = username === undefined ? target.username : username;
    if (role === 'WATCHMAN' && !nextUsername) {
      throw Errors.businessRule('Watchman accounts need a user ID (username).');
    }
    if (role !== 'WATCHMAN' && !nextEmail) {
      throw Errors.businessRule('Email is required for this role (used for password reset).');
    }

    await this.d1.db
      .update(users)
      .set({
        ...(dto.role !== undefined ? { role: dto.role } : {}),
        ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(username !== undefined ? { username } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.canApplyCorrections !== undefined
          ? { canApplyCorrections: dto.canApplyCorrections }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));

    // Keep the identity half in step: a name, a user ID or a new password all
    // live on Better Auth's rows, not on the one just written.
    await this.identity.update({
      id,
      fullName: dto.fullName,
      email: dto.email !== undefined ? dto.email?.trim() || null : undefined,
      username: dto.username !== undefined ? username : undefined,
      password: dto.password,
    });
    // Deactivating somebody should log them out, not wait for their session to
    // expire on its own. The same goes for a password an admin set for them —
    // identity.update already ends those sessions, which is what the old
    // refresh-token revocation here was doing before that scheme was removed.
    if (dto.isActive === false) await this.identity.revokeSessions(id);

    const updated = await this.get(user, id);
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'USER_UPDATE',
      entityType: 'User',
      entityId: id,
      newValue: {
        role: updated.role,
        isActive: updated.isActive,
        passwordChanged: !!dto.password,
        canApplyCorrections: updated.canApplyCorrections,
      },
    });
    return updated;
  }

  /** Soft delete — Super Admin only. Frees email/username for reuse and kills sessions. */
  async remove(user: AuthUser, id: string) {
    if (user.role !== 'SUPER_ADMIN') {
      throw Errors.forbidden('Only the Super Admin can delete users.');
    }
    if (id === user.userId) throw Errors.businessRule('You cannot delete your own account.');
    const target = await this.get(user, id);

    await this.d1.db.batch([
      this.d1.db
        .update(users)
        .set({ deletedAt: new Date(), isActive: false, email: null, username: null })
        .where(eq(users.id, id)),
      this.d1.db
        .update(devices)
        .set({ status: 'REVOKED' })
        .where(and(eq(devices.userId, id), ne(devices.status, 'REVOKED'))),
    ] as never);
    // Sessions are Better Auth's, so they are ended through it rather than by
    // revoking the refresh tokens the old scheme used.
    await this.identity.revokeSessions(id);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'USER_DELETE',
      entityType: 'User',
      entityId: id,
      oldValue: { role: target.role, email: target.email, username: target.username },
    });
    return { deleted: true };
  }

  async setSiteScopes(user: AuthUser, id: string, dto: SetSiteScopesDto) {
    const target = await this.get(user, id);
    if (id !== user.userId) this.assertCanManage(user, target.role);

    // Replace, in one batch: a delete that committed without its insert would
    // leave somebody scoped to nothing, which reads as access to every site.
    const writes: unknown[] = [
      this.d1.db.delete(userSiteScopes).where(eq(userSiteScopes.userId, id)),
    ];
    if (dto.siteIds.length) {
      writes.push(
        this.d1.db
          .insert(userSiteScopes)
          .values(dto.siteIds.map((siteId) => ({ userId: id, siteId })))
          .onConflictDoNothing(),
      );
    }
    await this.d1.db.batch(writes as never);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'USER_SCOPES_SET',
      entityType: 'User',
      entityId: id,
      newValue: { siteIds: dto.siteIds },
    });
    return this.get(user, id);
  }
}
