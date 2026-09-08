import type { Config } from 'drizzle-kit';

/**
 * Drizzle against D1.
 *
 * Migrations are generated as plain SQL and applied with `wrangler d1
 * migrations apply`, which is the supported path for D1 — unlike Prisma
 * Migrate, which does not cover D1 at all.
 */
export default {
  schema: './src/infra/d1/schema.generated.ts',
  out: './drizzle',
  dialect: 'sqlite',
  driver: 'd1-http',
} satisfies Config;
