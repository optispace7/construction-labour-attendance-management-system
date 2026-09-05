import { AuthService } from './auth.service';

/**
 * Focused unit test for refresh-token reuse detection: presenting an already
 * revoked refresh token must revoke the whole family and throw REFRESH_REUSE.
 */
describe('AuthService refresh reuse detection', () => {
  const updateMany = jest.fn();
  const prisma: any = {
    refreshToken: {
      findUnique: jest.fn(),
      updateMany,
      update: jest.fn(),
      create: jest.fn(),
    },
    user: { findUnique: jest.fn() },
  };
  const jwt: any = { signAsync: jest.fn().mockResolvedValue('jwt') };
  const crypto: any = { hashToken: jest.fn(), verifyToken: jest.fn() };
  const passwords: any = { hash: jest.fn(), verify: jest.fn(), needsRehash: jest.fn() };
  const audit: any = { record: jest.fn() };
  const mail: any = { send: jest.fn() };

  const svc = new AuthService(prisma, jwt, crypto, passwords, audit, mail);

  beforeEach(() => jest.clearAllMocks());

  it('revokes the family and throws on reuse of a revoked token', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'jti-1',
      familyId: 'fam-1',
      revokedAt: new Date(), // already revoked → reuse
      expiresAt: new Date(Date.now() + 1000),
      tokenHash: 'h',
      userId: 'u1',
    });

    await expect(svc.refresh('jti-1.secret')).rejects.toMatchObject({ code: 'REFRESH_REUSE' });
    expect(updateMany).toHaveBeenCalledWith({
      where: { familyId: 'fam-1', revokedAt: null },
      data: expect.objectContaining({ revokedAt: expect.any(Date) }),
    });
  });

  it('throws on unknown refresh token', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(null);
    await expect(svc.refresh('nope.secret')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
