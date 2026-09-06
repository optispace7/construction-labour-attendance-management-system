import type { Request } from 'express';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { AuthUser } from './auth-user.interface';

/**
 * Turns a Better Auth session into the AuthUser the rest of the app expects.
 *
 * Better Auth owns identity and nothing else. Who someone is comes from its
 * session; what they may do — organization, role, site scopes — is read from
 * our users row, which shares the same id. That split is deliberate: those
 * three columns decide every permission in the system and are not something to
 * keep in a table a library migrates.
 *
 * Returns null rather than throwing for anything unrecognised, so the caller
 * can fall through to the token format that is still in use.
 */
export async function authUserFromBetterAuthSession(
  req: Request,
  prisma: PrismaService,
): Promise<AuthUser | null> {
  // Imported here rather than at the top of the file. Better Auth is ESM-only
  // and this guard is loaded on every request path, including in the test
  // runner, which cannot load it. Reaching it only when a session is actually
  // being checked keeps that cost where it belongs.
  const { getAuth } = await import('../better-auth/auth');

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
  }

  const result = await getAuth().api.getSession({ headers });
  if (!result?.user?.id) return null;

  const user = await prisma.user.findFirst({
    where: { id: result.user.id, deletedAt: null, isActive: true },
    include: { siteScopes: true },
  });
  // A session for somebody who has since been deactivated or removed is not a
  // session. Better Auth has no way to know that — deactivation is ours.
  if (!user) return null;

  return {
    userId: user.id,
    organizationId: user.organizationId,
    role: user.role,
    email: user.email,
    siteScopes: user.siteScopes.map((s) => s.siteId),
  };
}
