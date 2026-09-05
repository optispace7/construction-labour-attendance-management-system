import { Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PasswordHashService } from '../../common/crypto/password-hash.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { CreateUserDto, SetSiteScopesDto, UpdateUserDto } from './dto/user.dto';

const PUBLIC_SELECT = {
  id: true,
  role: true,
  fullName: true,
  email: true,
  username: true,
  phone: true,
  isActive: true,
  canApplyCorrections: true,
  lastLoginAt: true,
  createdAt: true,
  organizationId: true,
  siteScopes: { select: { siteId: true } },
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
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordHashService,
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

  private assertCanManage(actor: AuthUser, targetRole: UserRole) {
    if (!MANAGEABLE[actor.role]?.includes(targetRole)) {
      throw Errors.forbidden(
        actor.role === 'SITE_ADMIN'
          ? 'Admins can only manage Safety Officer and Watchman accounts — ask your Super Admin.'
          : 'Not allowed to manage this account.',
      );
    }
  }

  list(user: AuthUser) {
    return this.prisma.user.findMany({
      where: { organizationId: user.organizationId, deletedAt: null },
      select: PUBLIC_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(user: AuthUser, id: string) {
    const found = await this.prisma.user.findFirst({
      where: { id, organizationId: user.organizationId, deletedAt: null },
      select: PUBLIC_SELECT,
    });
    if (!found) throw Errors.notFound('User');
    return found;
  }

  async create(user: AuthUser, dto: CreateUserDto) {
    this.assertCanManage(user, dto.role);
    this.assertCanGrantDirectApply(user, dto.canApplyCorrections);
    // Watchmen sign in with a user ID (no email); every other role resets
    // passwords via email OTP, so email is mandatory for them.
    if (dto.role === 'WATCHMAN' && !dto.username?.trim()) {
      throw Errors.businessRule('Watchman accounts need a user ID (username).');
    }
    if (dto.role !== 'WATCHMAN' && !dto.email?.trim()) {
      throw Errors.businessRule('Email is required for this role (used for password reset).');
    }
    const passwordHash = await this.passwords.hash(dto.password);
    const created = await this.prisma.user.create({
      data: {
        organizationId: user.organizationId,
        role: dto.role,
        fullName: dto.fullName,
        email: dto.email?.trim() || null,
        username: dto.username?.trim() || null,
        phone: dto.phone,
        passwordHash,
        canApplyCorrections: dto.canApplyCorrections ?? false,
        siteScopes: dto.siteIds?.length
          ? { create: dto.siteIds.map((siteId) => ({ siteId })) }
          : undefined,
      },
      select: PUBLIC_SELECT,
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'USER_CREATE',
      entityType: 'User',
      entityId: created.id,
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
    // by username, everyone else by email (which also receives reset codes).
    const role = dto.role ?? target.role;
    const nextEmail = email === undefined ? target.email : email;
    const nextUsername = username === undefined ? target.username : username;
    if (role === 'WATCHMAN' && !nextUsername) {
      throw Errors.businessRule('Watchman accounts need a user ID (username).');
    }
    if (role !== 'WATCHMAN' && !nextEmail) {
      throw Errors.businessRule('Email is required for this role (used for password reset).');
    }

    const data: Record<string, unknown> = {
      role: dto.role,
      fullName: dto.fullName,
      email,
      username,
      phone: dto.phone,
      isActive: dto.isActive,
      canApplyCorrections: dto.canApplyCorrections,
    };
    if (dto.password) data.passwordHash = await this.passwords.hash(dto.password);

    const updated = await this.prisma.user.update({
      where: { id },
      data,
      select: PUBLIC_SELECT,
    });
    // A password set by an admin invalidates existing sessions.
    if (dto.password && id !== user.userId) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
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

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false, email: null, username: null },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.device.updateMany({
        where: { userId: id, status: { not: 'REVOKED' } },
        data: { status: 'REVOKED' },
      }),
    ]);
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
    await this.prisma.$transaction([
      this.prisma.userSiteScope.deleteMany({ where: { userId: id } }),
      this.prisma.userSiteScope.createMany({
        data: dto.siteIds.map((siteId) => ({ userId: id, siteId })),
        skipDuplicates: true,
      }),
    ]);
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
