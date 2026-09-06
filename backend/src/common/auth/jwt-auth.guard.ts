import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { PUBLIC_KEY } from '../rbac/rbac.decorators';
import { Errors } from '../errors/app.exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { authUserFromBetterAuthSession } from './better-auth-session';

/**
 * Accepts either signed JWT or a Better Auth session.
 *
 * Both, on purpose, and for as long as the migration takes. The phones carry a
 * JWT and are updated by shipping an APK to every site, which is not something
 * to do on the same day the panel changes. Refusing one of the two would mean
 * both have to move at once.
 *
 * The JWT is tried first because it is the cheaper check — no database read —
 * and it is what most requests still present.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    try {
      const ok = await super.canActivate(context);
      if (ok) return true;
    } catch {
      // Not a JWT we accept. That is not yet a refusal — it may be a session.
    }

    const req = context.switchToHttp().getRequest<Request>();
    const user = await authUserFromBetterAuthSession(req, this.prisma);
    if (!user) throw Errors.unauthenticated();

    // Passport would have put it here, and everything downstream reads it here.
    (req as Request & { user?: unknown }).user = user;
    return true;
  }

  handleRequest<TUser>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw Errors.unauthenticated();
    }
    return user;
  }
}
