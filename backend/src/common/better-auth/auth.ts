import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer, username } from 'better-auth/plugins';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

/**
 * Better Auth configuration — spike.
 *
 * Stands beside the existing auth rather than replacing it, so nothing that
 * works today stops working while this is being evaluated. Nothing routes to
 * it until the flag in the module turns it on.
 *
 * Built on first use, not at import. Constructing a PrismaClient at module
 * scope fails on the serverless runtime before a request is ever served —
 * "PrismaClient failed to initialize because it wasn't configured to run in
 * this environment" — because the client needs the driver adapter there and
 * the deploy validates the module by loading it.
 *
 * It builds its own client rather than taking PrismaService: the schema
 * generator has to read this file from the command line, where the Nest
 * container does not exist. The adapter branch mirrors PrismaService's, for
 * the same reason it exists there — a native query engine cannot load on a
 * runtime that only runs JS and WebAssembly.
 */
function createPrisma(): PrismaClient {
  if (process.env.DATABASE_DRIVER_ADAPTER !== '1') return new PrismaClient();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not configured');
  // maxUses: 1 for the reason given in PrismaService: a socket does not
  // survive between requests here, and a pooled one is a dead one.
  return new PrismaClient({
    adapter: new PrismaPg(new Pool({ connectionString, max: 5, maxUses: 1 })),
  } as never);
}

export function createAuth() {
  return betterAuth({
  database: prismaAdapter(createPrisma(), { provider: 'postgresql' }),

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

  // These three have to be the same string, which is not obvious and is not
  // documented: Better Auth indexes the Prisma client with the model name
  // (db[model]), and its schema check compares that same name against real
  // table names. So the Prisma model, the Prisma client property and the
  // physical table must all read `auth_user`. Naming the model AuthUser and
  // mapping it to auth_user fails twice over — the check reports the table
  // missing, and the adapter cannot find db['AuthUser'].
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
