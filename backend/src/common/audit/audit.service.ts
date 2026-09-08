import { Injectable, Logger } from '@nestjs/common';
import { D1Service } from '../../infra/d1/d1.service';
import { auditLogs } from '../../infra/d1/schema.generated';

/** Kept as a plain union rather than Prisma's enum, which is on its way out. */
export type ActorRole = 'SUPER_ADMIN' | 'SITE_ADMIN' | 'SUPERVISOR' | 'WATCHMAN';

export interface AuditEntry {
  organizationId?: string | null;
  actorUserId?: string | null;
  actorRole?: ActorRole | string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  ipAddress?: string | null;
  deviceId?: string | null;
  requestId?: string | null;
}

/**
 * Append-only audit writer. Domain services call `record` explicitly for
 * meaningful actions, rather than anything being inferred from HTTP traffic.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly d1: D1Service) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.d1.db.insert(auditLogs).values({
        organizationId: entry.organizationId ?? null,
        actorUserId: entry.actorUserId ?? null,
        actorRole: (entry.actorRole as string) ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        // Postgres held these as jsonb and Prisma serialised them on the way
        // in. SQLite has no json type, so it is done here — passing an object
        // to a text column stores "[object Object]", which is a log entry that
        // records that something changed and nothing about what.
        oldValue: json(entry.oldValue),
        newValue: json(entry.newValue),
        reason: entry.reason ?? null,
        ipAddress: entry.ipAddress ?? null,
        deviceId: entry.deviceId ?? null,
        requestId: entry.requestId ?? null,
        createdAt: new Date(),
      });
    } catch (e) {
      // An audit write must not take the action down with it. The alternative
      // is a correction that was applied being rolled back because the note
      // about it could not be filed, which loses the more important of the two.
      this.logger.error(
        `Audit entry not written (${entry.action} on ${entry.entityType}): ` +
          `${(e as Error).message}`,
      );
    }
  }
}

/** Serialises for a text column, keeping null and undefined distinct. */
function json(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}
