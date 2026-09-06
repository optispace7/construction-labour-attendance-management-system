import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PUBLIC_KEY } from '../rbac/rbac.decorators';
import { Errors } from '../errors/app.exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { authUserFromBetterAuthSession } from './better-auth-session';

/**
 * Authenticates every request against a Better Auth session.
 *
 * This replaced a passport JWT strategy. There is deliberately no fallback to
 * it: two ways to authenticate against one set of accounts is how one of them
 * goes on working after the other is secured, and a signing secret that still
 * mints valid tokens is a credential nobody is watching.
 *
 * Identity comes from the session; role, organization and site scopes are read
 * from our own user row. Better Auth does not know about deactivation, so a
 * session belonging to a disabled or deleted account is refused here.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const user = await authUserFromBetterAuthSession(req, this.prisma);
    if (!user) throw Errors.unauthenticated();

    // Everything downstream — @CurrentUser, the policy guard — reads it here,
    // which is where passport used to leave it.
    (req as Request & { user?: unknown }).user = user;
    return true;
  }
}
