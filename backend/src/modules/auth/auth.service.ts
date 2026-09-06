import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { Errors } from '../../common/errors/app.exception';

/**
 * What CLAMS knows about the signed-in person.
 *
 * Signing in, refreshing, signing out and resetting a password all moved to
 * Better Auth, under /api/better-auth. What is left is the one question Better
 * Auth cannot answer: who this account is inside CLAMS — its role, its
 * organization, and the sites it is scoped to. None of those live in Better
 * Auth's tables, on purpose: they decide every permission in the system and
 * are not something to keep in a table a library owns and migrates.
 */
@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { siteScopes: true },
    });
    if (!user) throw Errors.notFound('User');
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      username: user.username,
      role: user.role,
      organizationId: user.organizationId,
      siteScopes: user.siteScopes.map((s) => s.siteId),
    };
  }
}
