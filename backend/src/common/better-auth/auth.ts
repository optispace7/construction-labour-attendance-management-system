import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, username } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import { env } from 'cloudflare:workers';
import { randomUUID } from 'node:crypto';
import * as schema from '../../infra/d1/schema.generated';

/**
 * Better Auth configuration.
 *
 * It reads and writes D1, through the same Drizzle schema the rest of the app
 * uses. This was the last thing still talking to Postgres: identity rows were
 * being written to D1 by IdentityService while Better Auth itself read them
 * from Supabase, so the two halves of an account lived in different databases
 * and every sign-in reached outside Cloudflare.
 *
 * Built on first use, not at import. The binding does not exist at module
 * scope on Workers, and the deploy validates the module by loading it.
 *
 * It reaches for the binding directly rather than taking D1Service: the schema
 * generator has to read this file from the command line, where the Nest
 * container does not exist.
 */
function database() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error('No D1 binding named DB for Better Auth');
  return drizzle(binding, { schema });
}

export function createAuth() {
  return betterAuth({
  database: drizzleAdapter(database(), {
    provider: 'sqlite',
    // The generated tables are exported under camelCase names; Better Auth
    // looks each model up by the name given below, so the two are mapped here
    // rather than renaming either side.
    schema: {
      auth_user: schema.authUser,
      auth_session: schema.authSession,
      auth_account: schema.authAccount,
      auth_verification: schema.authVerification,
    },
  }),

  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  // Must match where the controller is mounted. Better Auth builds every
  // path it hands out — reset links, callbacks — from these two, so a
  // mismatch produces URLs that route nowhere.
  basePath: '/api/better-auth',

  // Where a reset link is allowed to send somebody.
  //
  // Not optional: without it every password-reset request is refused with
  // INVALID_REDIRECT_URL, which reads like a broken endpoint rather than a
  // missing setting. It is a allowlist on purpose — the reset link carries a
  // token, and an unchecked redirect would let anyone who could craft the
  // request have that token delivered to a host of their choosing.
  trustedOrigins: (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  // Better Auth's own tables, named so they cannot collide with ours.
  //
  // Left at its defaults it wants a model called `User`, and we already have
  // one — the generator refuses, because our users table carries columns it
  // never writes (organization_id, role, full_name) and inserts would fail on
  // the NOT NULLs. Renaming ours instead would touch nineteen call sites and
  // put authorization data in a table a library owns.
  //
  // So identity lives in auth_user and authorization stays in users, joined on
  // the same id. Nothing existing is altered, which is the point: every
  // foreign key that references users.id keeps referencing it.
  advanced: {
    database: {
      // Better Auth's own ids are a 32-character random string, not a UUID.
      // Every other id in this database is a UUID, and these rows are joined
      // to users on the id, so a text column here would mean a cast on the
      // join and two id shapes in one schema for no reason.
      generateId: () => randomUUID(),
    },
  },

  // The model names, which the adapter's `schema` map above resolves to the
  // generated Drizzle tables. They are also the physical table names, which
  // keeps one word for one thing.
  user: { modelName: 'auth_user' },
  session: { modelName: 'auth_session' },
  account: { modelName: 'auth_account' },
  verification: { modelName: 'auth_verification' },

  emailAndPassword: {
    enabled: true,
    // Password reset stays on the mail path that already works from a Worker:
    // Gmail over SMTP. Only the flow around it is Better Auth's.
    sendResetPassword: async ({ user, url }) => {
      const { mailTransport } = await import('../mail/mail-transport');
      // bcc rather than to: the shared transport addresses everything that
      // way, so one recipient never sees the others.
      await mailTransport.send({
        bcc: user.email,
        subject: 'Reset your CLAMS password',
        text:
          `Open this link to set a new password:\n\n${url}\n\n` +
          'If you did not ask for this, ignore this message.',
      });
    },
  },

  plugins: [
    // Site staff sign in with a user ID, not an e-mail address. Five of the
    // eleven accounts — every Watchman and both Site Admins — have no mailbox
    // at all, so username is not a convenience here, it is the only way in.
    username(),

    // Sessions, carried in an Authorization header instead of a cookie.
    //
    // Still a real server-side session — revocable, and revoked centrally —
    // which is what a JWT would not have been. The header is for the phones:
    // the Flutter app talks to the API through Dio and stores its own
    // credentials, and cookie handling across an app restart and a long
    // offline stretch is not something to rely on at a site gate.
    bearer(),
  ],
  });
}

/** Memoised, so one Worker isolate builds it once. */
let cached: ReturnType<typeof createAuth> | null = null;
export function getAuth() {
  cached ??= createAuth();
  return cached;
}
