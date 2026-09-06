import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer, username } from 'better-auth/plugins';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

/**
 * Better Auth configuration — spike.
 *
 * Stands beside the existing auth rather than replacing it, so nothing that
 * works today stops working while this is being evaluated. Nothing routes to
 * it until the flag in the module turns it on.
 *
 * Its own PrismaClient rather than the injected PrismaService: the schema
 * generator has to be able to read this file from the command line, where the
 * Nest container does not exist.
 */
const prisma = new PrismaClient();

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),

  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

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

  user: { modelName: 'AuthUser' },
  session: { modelName: 'AuthSession' },
  account: { modelName: 'AuthAccount' },
  verification: { modelName: 'AuthVerification' },

  emailAndPassword: {
    enabled: true,
    // Password reset stays on the mail path that already works from a Worker:
    // Gmail over SMTP. Only the flow around it is Better Auth's.
    sendResetPassword: async ({ user, url }) => {
      const { mailer } = await import('../mail/mail-transport');
      await mailer.sendMail({
        to: user.email,
        subject: 'Reset your CLAMS password',
        text: `Open this link to set a new password:\n\n${url}\n\nIf you did not ask for this, ignore this message.`,
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
