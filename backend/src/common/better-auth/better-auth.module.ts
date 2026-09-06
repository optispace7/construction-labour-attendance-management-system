import { Module } from '@nestjs/common';
import { BetterAuthController } from './better-auth.controller';

/**
 * Better Auth, behind a flag.
 *
 * Registered only when BETTER_AUTH_ENABLED is set, so an evaluation branch
 * cannot start answering on an auth route by accident. With the flag off the
 * controller is never constructed and the routes do not exist — which also
 * means the ESM-only package is never loaded on a runtime that has not been
 * checked against it.
 */
export function betterAuthEnabled(): boolean {
  return process.env.BETTER_AUTH_ENABLED === '1';
}

@Module({
  controllers: betterAuthEnabled() ? [BetterAuthController] : [],
})
export class BetterAuthModule {}
