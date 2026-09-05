import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomInt, randomUUID } from 'crypto';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../../common/audit/audit.service';
import { MailService } from '../../common/mail/mail.service';
import { Errors } from '../../common/errors/app.exception';
import { JwtPayload } from '../../common/auth/auth-user.interface';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  private accessTtl = Number(process.env.JWT_ACCESS_TTL ?? 900);
  private refreshTtl = Number(process.env.JWT_REFRESH_TTL ?? 2592000);

  /** Find a live (non-deleted) user by email or username. */
  private findByIdentifier(identifier: string) {
    return this.prisma.user.findFirst({
      where: {
        OR: [{ email: identifier }, { username: identifier }],
        deletedAt: null,
      },
      include: { siteScopes: true },
    });
  }

  async login(
    identifier: string,
    password: string,
    ip?: string,
  ): Promise<TokenPair & { user: unknown }> {
    const user = await this.findByIdentifier(identifier);
    if (!user || !user.isActive) throw Errors.unauthenticated('Invalid credentials');

    const valid = await this.crypto.verifyPassword(user.passwordHash, password);
    if (!valid) throw Errors.unauthenticated('Invalid credentials');

    // Rewrite an inherited hash at the current cost, now that we know the
    // password. Those were written at m=64MiB/t=3/p=4 and take seconds to
    // verify; this trades one slow login for fast ones thereafter. Failure is
    // swallowed on purpose — the user has authenticated, and a housekeeping
    // write must not turn a good login into a bad one.
    if (this.crypto.passwordNeedsRehash(user.passwordHash)) {
      try {
        const rehashed = await this.crypto.hashPassword(password);
        await this.prisma.user.update({
          where: { id: user.id },
          data: { passwordHash: rehashed },
        });
      } catch {
        /* keep the old hash; it still works, just slowly */
      }
    }

    const scopes = user.siteScopes.map((s) => s.siteId);
    const tokens = await this.issueTokens(
      user.id,
      user.organizationId,
      user.role,
      user.email,
      scopes,
    );

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.id,
      actorRole: user.role,
      action: 'AUTH_LOGIN',
      entityType: 'User',
      entityId: user.id,
      ipAddress: ip,
    });

    return {
      ...tokens,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        username: user.username,
        role: user.role,
        organizationId: user.organizationId,
      },
    };
  }

  private async issueTokens(
    userId: string,
    org: string,
    role: JwtPayload['role'],
    email: string | null,
    scopes: string[],
    familyId: string = randomUUID(),
  ): Promise<TokenPair> {
    const payload: JwtPayload = { sub: userId, org, role, email, scopes };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: process.env.JWT_ACCESS_SECRET ?? 'change_me_access_secret',
      expiresIn: this.accessTtl,
    });

    // Opaque refresh token = jti.secret; only the hash is stored. The secret is
    // a random UUID, so the hash guards a stolen database, not a guessing
    // attack — SHA-256, not Argon2id, which every client would otherwise pay
    // for on each token rotation.
    const jti = randomUUID();
    const secret = randomUUID();
    const refreshToken = `${jti}.${secret}`;
    const tokenHash = this.crypto.hashOpaqueToken(refreshToken);

    await this.prisma.refreshToken.create({
      data: {
        id: jti,
        userId,
        familyId,
        tokenHash,
        expiresAt: new Date(Date.now() + this.refreshTtl * 1000),
      },
    });

    return { accessToken, refreshToken };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const [jti] = refreshToken.split('.');
    if (!jti) throw Errors.unauthenticated('Malformed refresh token');

    const stored = await this.prisma.refreshToken.findUnique({ where: { id: jti } });
    if (!stored) throw Errors.unauthenticated('Unknown refresh token');

    // Reuse detection: a revoked/replaced token being presented again →
    // revoke the entire family and force re-login.
    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw Errors.refreshReuse();
    }
    if (stored.expiresAt < new Date()) throw Errors.unauthenticated('Refresh token expired');

    const matches = await this.crypto.verifyToken(stored.tokenHash, refreshToken);
    if (!matches) throw Errors.unauthenticated('Invalid refresh token');

    const user = await this.prisma.user.findUnique({
      where: { id: stored.userId },
      include: { siteScopes: true },
    });
    if (!user || !user.isActive || user.deletedAt) throw Errors.unauthenticated('User inactive');

    const scopes = user.siteScopes.map((s) => s.siteId);
    const next = await this.issueTokens(
      user.id,
      user.organizationId,
      user.role,
      user.email,
      scopes,
      stored.familyId,
    );

    const nextJti = next.refreshToken.split('.')[0];
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedBy: nextJti },
    });

    return next;
  }

  async logout(refreshToken: string): Promise<void> {
    const [jti] = refreshToken.split('.');
    if (!jti) return;
    await this.prisma.refreshToken.updateMany({
      where: { id: jti, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { siteScopes: true },
    });
    if (!user) throw Errors.notFound('User');
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      username: user.username,
      role: user.role,
      organizationId: user.organizationId,
      siteScopes: user.siteScopes.map((s) => s.siteId),
    };
  }

  // ---------------- Forgot password (email OTP) ----------------

  /**
   * Step 1: request an OTP. Watchmen (and anyone without an email on file)
   * cannot self-reset — they are told to ask their admin instead. Admins
   * without email are pointed at the super admin.
   */
  async forgotPassword(identifier: string): Promise<{ emailSent: boolean; message: string }> {
    const user = await this.findByIdentifier(identifier);
    if (!user || !user.isActive) {
      return {
        emailSent: false,
        message: 'No account found for this email or user ID. Please contact your admin.',
      };
    }
    if (user.role === 'WATCHMAN') {
      return {
        emailSent: false,
        message:
          'Watchman accounts cannot reset the password here. Please ask your Admin to reset it.',
      };
    }
    if (!user.email) {
      const who = user.role === 'SITE_ADMIN' ? 'Super Admin' : 'Admin';
      return {
        emailSent: false,
        message: `No email is linked to this account. Please ask your ${who} to reset your password.`,
      };
    }

    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const otpHash = await this.crypto.hashToken(otp);
    // Invalidate earlier outstanding OTPs so only the latest one works.
    await this.prisma.passwordReset.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    await this.prisma.passwordReset.create({
      data: { userId: user.id, otpHash, expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    });
    await this.mail.send(
      [user.email],
      'CLAMS password reset code',
      `Hi ${user.fullName},\n\nYour CLAMS password reset code is: ${otp}\n\n` +
        `It expires in 10 minutes. If you did not request this, you can ignore this email.`,
    );
    const masked = user.email.replace(/^(.{2}).*(@.*)$/, '$1***$2');
    return { emailSent: true, message: `A 6-digit code has been sent to ${masked}.` };
  }

  /** Step 2: verify the OTP; returns a short-lived reset token. */
  async verifyOtp(identifier: string, otp: string): Promise<{ resetToken: string }> {
    const user = await this.findByIdentifier(identifier);
    if (!user) throw Errors.unauthenticated('Invalid code');

    const reset = await this.prisma.passwordReset.findFirst({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!reset || reset.attempts >= OTP_MAX_ATTEMPTS) {
      throw Errors.unauthenticated('Code expired — request a new one');
    }

    const ok = await this.crypto.verifyToken(reset.otpHash, otp);
    if (!ok) {
      await this.prisma.passwordReset.update({
        where: { id: reset.id },
        data: { attempts: { increment: 1 } },
      });
      throw Errors.unauthenticated('Incorrect code');
    }

    const resetToken = `${reset.id}.${randomUUID()}`;
    await this.prisma.passwordReset.update({
      where: { id: reset.id },
      data: { resetTokenHash: await this.crypto.hashToken(resetToken) },
    });
    return { resetToken };
  }

  /** Step 3: set the new password; revokes every active session. */
  async resetPassword(resetToken: string, newPassword: string): Promise<void> {
    const [resetId] = resetToken.split('.');
    const reset = resetId
      ? await this.prisma.passwordReset.findUnique({ where: { id: resetId } })
      : null;
    if (
      !reset ||
      reset.usedAt ||
      !reset.resetTokenHash ||
      reset.expiresAt < new Date() ||
      !(await this.crypto.verifyToken(reset.resetTokenHash, resetToken))
    ) {
      throw Errors.unauthenticated('Reset link expired — start again');
    }

    const user = await this.prisma.user.findUnique({ where: { id: reset.userId } });
    if (!user || !user.isActive || user.deletedAt) throw Errors.unauthenticated('User inactive');

    const passwordHash = await this.crypto.hashPassword(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      this.prisma.passwordReset.update({
        where: { id: reset.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.id,
      actorRole: user.role,
      action: 'AUTH_PASSWORD_RESET',
      entityType: 'User',
      entityId: user.id,
    });
  }
}
