import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../infra/prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

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
    await this.prisma.auth_user.create({
      data: {
        id: input.id,
        name: input.fullName,
        email: this.addressFor(input.email, input.username, input.id),
        emailVerified: false,
        username: input.username?.trim() || null,
        displayUsername: input.username?.trim() || null,
        createdAt: now,
        updatedAt: now,
      },
    });
    await this.prisma.auth_account.create({
      data: {
        id: randomUUID(),
        accountId: input.id,
        providerId: 'credential',
        userId: input.id,
        password: await this.hash(input.password),
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  /** Mirrors a profile change, and sets a new password when one is given. */
  async update(input: {
    id: string;
    fullName?: string;
    email?: string | null;
    username?: string | null;
    password?: string;
  }): Promise<void> {
    const existing = await this.prisma.auth_user.findUnique({ where: { id: input.id } });
    if (!existing) return;

    await this.prisma.auth_user.update({
      where: { id: input.id },
      data: {
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
      },
    });

    if (input.password) {
      await this.prisma.auth_account.updateMany({
        where: { userId: input.id, providerId: 'credential' },
        data: { password: await this.hash(input.password), updatedAt: new Date() },
      });
      // A password set by somebody else ends the sessions opened with the old
      // one. Better Auth has no reason to do this on its own — it never saw
      // the change — so it is done here, where the change is known about.
      await this.prisma.auth_session.deleteMany({ where: { userId: input.id } });
    }
  }

  /** Ends every session for a user — used when an account is deactivated. */
  async revokeSessions(userId: string): Promise<void> {
    await this.prisma.auth_session.deleteMany({ where: { userId } });
  }
}
