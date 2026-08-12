import { UsersService } from './users.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { UpdateUserDto } from './dto/user.dto';
import { AppException } from '../../common/errors/app.exception';

/** AppException.message is the title; the human sentence lives in `detail`. */
async function detailOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppException) return e.detail ?? '';
    throw e;
  }
  throw new Error('expected the update to be rejected');
}

/**
 * Focused on what an edit does to the login handles: a blank email must
 * actually clear the column (Prisma reads `undefined` as "leave alone"), and no
 * edit may leave an account with no way to sign in.
 */
describe('UsersService.update — email/username clearing', () => {
  const superAdmin: AuthUser = {
    userId: 'admin-1',
    organizationId: 'org-1',
    role: 'SUPER_ADMIN',
    siteScopes: [],
  } as AuthUser;

  const watchman = {
    id: 'u-1',
    role: 'WATCHMAN',
    email: 'gate@clams.local',
    username: 'gate1',
  };
  const siteAdmin = {
    id: 'u-2',
    role: 'SITE_ADMIN',
    email: 'boss@clams.local',
    username: null,
  };

  let prisma: {
    user: { findFirst: jest.Mock; update: jest.Mock; updateMany?: jest.Mock };
    refreshToken: { updateMany: jest.Mock };
  };
  let service: UsersService;

  const build = (target: Record<string, unknown>) => {
    prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue(target),
        update: jest.fn().mockImplementation(({ data }) => ({ ...target, ...data })),
      },
      refreshToken: { updateMany: jest.fn() },
    };
    const crypto = { hashPassword: jest.fn().mockResolvedValue('hashed') };
    const audit = { record: jest.fn() };
    service = new UsersService(prisma as never, crypto as never, audit as never);
  };

  const dataSentToPrisma = () => prisma.user.update.mock.calls[0][0].data;

  it("clears a watchman's email when null is sent", async () => {
    build(watchman);
    await service.update(superAdmin, 'u-1', { email: null } as UpdateUserDto);
    expect(dataSentToPrisma().email).toBeNull();
  });

  it('treats a blank string as a clear, not as "leave alone"', async () => {
    build(watchman);
    await service.update(superAdmin, 'u-1', { email: '  ' } as UpdateUserDto);
    expect(dataSentToPrisma().email).toBeNull();
  });

  it('leaves the email untouched when the key is absent', async () => {
    build(watchman);
    await service.update(superAdmin, 'u-1', { fullName: 'Gate Keeper' } as UpdateUserDto);
    expect(dataSentToPrisma().email).toBeUndefined();
  });

  it('refuses to strand a watchman without a username', async () => {
    build(watchman);
    const detail = await detailOf(
      service.update(superAdmin, 'u-1', { username: null } as UpdateUserDto),
    );
    expect(detail).toMatch(/user ID/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses to strand an email-login role without an email', async () => {
    build(siteAdmin);
    const detail = await detailOf(
      service.update(superAdmin, 'u-2', { email: null } as UpdateUserDto),
    );
    expect(detail).toMatch(/Email is required/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('lets a watchman become an admin when an email is supplied in the same edit', async () => {
    build(watchman);
    await service.update(superAdmin, 'u-1', {
      role: 'SITE_ADMIN',
      email: 'boss2@clams.local',
      username: null,
    } as UpdateUserDto);
    const data = dataSentToPrisma();
    expect(data.email).toBe('boss2@clams.local');
    expect(data.username).toBeNull();
  });

  it('rejects promoting a watchman to admin while clearing their only email', async () => {
    build({ ...watchman, email: null });
    const detail = await detailOf(
      service.update(superAdmin, 'u-1', { role: 'SITE_ADMIN' } as UpdateUserDto),
    );
    expect(detail).toMatch(/Email is required/i);
  });

  /**
   * Who may hand out the right to apply corrections unreviewed.
   *
   * An Admin manages Safety Officer accounts, so without this check they could
   * grant one the approval bypass — or take it for themselves through an
   * account they control — which is a route around the approval step rather
   * than a use of it.
   */
  describe('canApplyCorrections grant', () => {
    const officer = { id: 'u-3', role: 'SUPERVISOR', email: 'so@clams.local', username: null };
    const admin: AuthUser = {
      userId: 'admin-2',
      organizationId: 'org-1',
      role: 'SITE_ADMIN',
      siteScopes: [],
    } as AuthUser;

    it('lets the Super Admin grant it', async () => {
      build(officer);
      await service.update(superAdmin, 'u-3', {
        canApplyCorrections: true,
      } as UpdateUserDto);
      expect(dataSentToPrisma().canApplyCorrections).toBe(true);
    });

    it('lets the Super Admin take it back', async () => {
      build({ ...officer, canApplyCorrections: true });
      await service.update(superAdmin, 'u-3', {
        canApplyCorrections: false,
      } as UpdateUserDto);
      expect(dataSentToPrisma().canApplyCorrections).toBe(false);
    });

    it('refuses an Admin trying to grant it', async () => {
      build(officer);
      const detail = await detailOf(
        service.update(admin, 'u-3', { canApplyCorrections: true } as UpdateUserDto),
      );
      expect(detail).toMatch(/Only the Super Admin/i);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('leaves the grant alone on an edit that does not mention it', async () => {
      build({ ...officer, canApplyCorrections: true });
      await service.update(admin, 'u-3', { fullName: 'Safety Officer' } as UpdateUserDto);
      expect(dataSentToPrisma().canApplyCorrections).toBeUndefined();
    });
  });
});
