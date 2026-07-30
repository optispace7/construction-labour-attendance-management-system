import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AuditModule } from './common/audit/audit.module';
import { MailModule } from './common/mail/mail.module';
import { PushModule } from './common/push/push.module';
import { AuditInterceptor } from './common/audit/audit.interceptor';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { DeviceGuard } from './common/auth/device.guard';
import { PolicyGuard } from './common/rbac/policy.guard';

import { HealthController } from './common/health/health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { SitesModule } from './modules/sites/sites.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { UsersModule } from './modules/users/users.module';
import { DevicesModule } from './modules/devices/devices.module';
import { WorkersModule } from './modules/workers/workers.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { CorrectionsModule } from './modules/corrections/corrections.module';
import { ManualApprovalsModule } from './modules/manual-approvals/manual-approvals.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SafetyModule } from './modules/safety/safety.module';
import { AuditQueryModule } from './modules/audit/audit-query.module';
import { DesignationsModule } from './modules/designations/designations.module';
import { FilesModule } from './modules/files/files.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SosModule } from './modules/sos/sos.module';
import { StorageModule } from './modules/storage/storage.module';

@Module({
  imports: [
    // Local dev also picks up the shared infra/.env (gitignored); in Azure the
    // container app env vars take precedence over any file.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../infra/.env'] }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    RedisModule,
    CryptoModule,
    AuditModule,
    PushModule,
    AuthModule,
    OrganizationsModule,
    SitesModule,
    VendorsModule,
    UsersModule,
    DevicesModule,
    WorkersModule,
    AttendanceModule,
    CorrectionsModule,
    ManualApprovalsModule,
    ReportsModule,
    SafetyModule,
    AuditQueryModule,
    MailModule,
    DesignationsModule,
    FilesModule,
    NotificationsModule,
    SosModule,
    StorageModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: DeviceGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
