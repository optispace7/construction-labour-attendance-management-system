import { Injectable } from '@nestjs/common';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { env } from 'cloudflare:workers';
import * as schema from './schema.generated';

/**
 * The application database, as Drizzle over D1.
 *
 * This is what replaces PrismaService. Two differences are worth stating,
 * because they change how code is written against it rather than only which
 * library is imported:
 *
 * There is no interactive transaction. D1 is auto-commit, so anything that
 * needs to be all-or-nothing reads first, decides in memory, and writes as one
 * batch — see correction-apply.d1.ts, which does exactly that for the hardest
 * case in the system.
 *
 * There is no connection to manage. A D1 binding is not a pool and does not go
 * stale between requests, which removes the whole class of problem the pg pool
 * had here: a socket that did not survive an isolate being frozen.
 */
@Injectable()
export class D1Service {
  private cached: DrizzleD1Database<typeof schema> | null = null;

  /**
   * Built on first use, not in the constructor.
   *
   * Reaching for the binding while the module graph is still being constructed
   * fails on this runtime, and it fails at deploy time rather than at a
   * request — which reads as a broken build rather than a missing binding.
   */
  get db(): DrizzleD1Database<typeof schema> {
    if (!this.cached) this.cached = drizzle(binding(), { schema });
    return this.cached;
  }

  /** The raw binding, for the batch API Drizzle does not expose usefully. */
  get d1(): D1Database {
    return binding();
  }
}

/**
 * The binding, read on use rather than at module scope.
 *
 * The import has to be static — a dynamic require of `cloudflare:workers` is
 * not supported by the bundler and fails at the first request, not at build.
 * Reading `env.DB` is what stays lazy: touching a binding while the module
 * graph is still being built is refused by the runtime.
 */
function binding(): D1Database {
  const bound = (env as unknown as { DB?: D1Database }).DB;
  if (!bound) {
    throw new Error(
      'No D1 binding named DB. Check d1_databases in wrangler.jsonc — without it every ' +
        'query fails at the first request rather than at startup.',
    );
  }
  return bound;
}
