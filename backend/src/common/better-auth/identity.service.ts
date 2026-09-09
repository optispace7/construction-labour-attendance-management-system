import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { D1Service } from '../../infra/d1/d1.service';
import { authAccount, authSession, authUser } from '../../infra/d1/schema.generated';

/**
 * Creates and updates the Better Auth rows that back an account.
 *
 * Authentication reads from Better Auth's tables; everything about what a
 * person may do stays on our user row. Both are keyed by the same id, so this
 * keeps the identity half in step whenever the authorization half changes.
 *
 * It writes those rows directly rather than going through Better Auth's HTTP
 * API. Its sign-up endpoint also issues a session and insists on a deliverable
 * address — neither of which is wanted when an administrator is creating an
 * account for somebody else, least of all a Watchman who has no mailbox.
 */
@Injectable()
export class IdentityService {
  constructor(private readonly d1: D1Service) {}

  /**
   * Better Auth requires an address on every user, unique and not null, even
   * for an account that only ever signs in with a user ID. Site staff have no
   * mailbox, so one is synthesised in the reserved .invalid TLD: unique, and
   * provably undeliverable rather than looking like an address nobody reads.
   */
  private addressFor(email: string | null, username: string | null, id: string): string {
    const real = email?.trim();
    if (real) return real;
    const handle = username?.trim() || id;
    return `${handle}@watchman.clams.invalid`;
  }

  /** Hashes the way Better Auth hashes, so its own verify accepts the result. */
  private async hash(password: string): Promise<string> {
    const { hashPassword } = await import('@better-auth/utils/password');
    return hashPassword(password);
  }

  /** Creates the identity and credential rows for a newly created user. */
  async create(input: {
    id: string;
    fullName: string;
    email: string | null;
    username: string | null;
    password: string;
  }): Promise<void> {
    const now = new Date();
    const password = await this.hash(input.password);
    // Both rows or neither: a user with no credential row cannot sign in, and
    // there is nothing in the product that would tell anybody why.
    await this.d1.db.batch([
      this.d1.db.insert(authUser).values({
        id: input.id,
        name: input.fullName,
        email: this.addressFor(input.email, input.username, input.id),
        emailVerified: false,
        username: input.username?.trim() || null,
        displayUsername: input.username?.trim() || null,
        createdAt: now,
        updatedAt: now,
      }),
      this.d1.db.insert(authAccount).values({
        id: randomUUID(),
        accountId: input.id,
        providerId: 'credential',
        userId: input.id,
        password,
        createdAt: now,
        updatedAt: now,
      }),
    ] as never);
  }

  /** Mirrors a profile change, and sets a new password when one is given. */
  async update(input: {
    id: string;
    fullName?: string;
    email?: string | null;
    username?: string | null;
    password?: string;
  }): Promise<void> {
    const [existing] = await this.d1.db
      .select()
      .from(authUser)
      .where(eq(authUser.id, input.id))
      .limit(1);
    if (!existing) return;

    await this.d1.db
      .update(authUser)
      .set({
        ...(input.fullName !== undefined ? { name: input.fullName } : {}),
        ...(input.email !== undefined || input.username !== undefined
          ? {
              email: this.addressFor(
                input.email !== undefined ? input.email : null,
                input.username !== undefined ? input.username : existing.username,
                input.id,
              ),
            }
          : {}),
        ...(input.username !== undefined
          ? {
              username: input.username?.trim() || null,
              displayUsername: input.username?.trim() || null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(authUser.id, input.id));

    if (input.password) {
      // The new password and the end of the old sessions go together: a
      // password changed without the sessions closing leaves whoever was
      // using the old one still signed in.
      await this.d1.db.batch([
        this.d1.db
          .update(authAccount)
          .set({ password: await this.hash(input.password), updatedAt: new Date() })
          .where(
            and(eq(authAccount.userId, input.id), eq(authAccount.providerId, 'credential')),
          ),
        // A password set by somebody else ends the sessions opened with the old
        // one. Better Auth has no reason to do this on its own — it never saw
        // the change — so it is done here, where the change is known about.
        this.d1.db.delete(authSession).where(eq(authSession.userId, input.id)),
      ] as never);
    }
  }

  /** Ends every session for a user — used when an account is deactivated. */
  async revokeSessions(userId: string): Promise<void> {
    await this.d1.db.delete(authSession).where(eq(authSession.userId, userId));
  }
}
