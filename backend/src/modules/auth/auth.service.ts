import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { D1Service } from '../../infra/d1/d1.service';
import { userSiteScopes, users } from '../../infra/d1/schema.generated';
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
  constructor(private readonly d1: D1Service) {}

  async me(userId: string) {
    const [user] = await this.d1.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw Errors.notFound('User');
    // Prisma's include; one more query here rather than a join, because the
    // scopes are a list and a join would repeat the user row for each one.
    const scopes = await this.d1.db
      .select({ siteId: userSiteScopes.siteId })
      .from(userSiteScopes)
      .where(eq(userSiteScopes.userId, userId));
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      username: user.username,
      role: user.role,
      organizationId: user.organizationId,
      siteScopes: scopes.map((s) => s.siteId),
    };
  }
}
