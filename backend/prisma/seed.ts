import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '@better-auth/utils/password';

const prisma = new PrismaClient();

async function main() {
  const orgCode = process.env.SEED_ORG_CODE ?? 'DEFAULT';
  const org = await prisma.organization.upsert({
    where: { code: orgCode },
    update: {},
    create: {
      name: process.env.SEED_ORG_NAME ?? 'Default Organization',
      code: orgCode,
      timezone: process.env.SEED_ORG_TIMEZONE ?? 'Asia/Kolkata',
    },
  });

  const email = process.env.SEED_SUPERADMIN_EMAIL ?? 'admin@clams.local';
  const password = process.env.SEED_SUPERADMIN_PASSWORD ?? 'ChangeMe123!';
  // A seeded account needs both halves: the user row says what it may do, the
  // Better Auth rows are what a sign-in actually reads. Creating only the first
  // produces an account that exists, appears in the admin panel, and cannot log
  // in — which is a confusing thing to hand somebody on a fresh install.
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      organizationId: org.id,
      role: 'SUPER_ADMIN',
      fullName: 'Super Admin',
      email,
    },
  });

  const now = new Date();
  await prisma.auth_user.upsert({
    where: { id: user.id },
    update: {},
    create: {
      id: user.id,
      name: 'Super Admin',
      email,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    },
  });
  const credential = await prisma.auth_account.findFirst({
    where: { userId: user.id, providerId: 'credential' },
  });
  if (!credential) {
    await prisma.auth_account.create({
      data: {
        id: randomUUID(),
        accountId: user.id,
        providerId: 'credential',
        userId: user.id,
        password: await hashPassword(password),
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded org "${org.code}" and super admin "${email}"`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
