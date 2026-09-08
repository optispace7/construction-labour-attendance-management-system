import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { D1Service } from '../../infra/d1/d1.service';
import { companyDocuments, organizations, sites } from '../../infra/d1/schema.generated';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { randomUUID } from 'node:crypto';
import { blobStore, blobStoreConfigured } from '../files/blob-store';
import { readStoredBytes } from '../files/read-blob';
import {
  ALLOWED_DOCUMENT_TYPES,
  DEFAULT_REMIND_DAYS_BEFORE,
  UpdateCompanyDocumentDto,
  UploadCompanyDocumentDto,
} from './dto/company-document.dto';

/** Upload cap. Base64 inflates by a third, and the API body limit is 16 MB. */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** Every PDF starts with this signature; anything else is not one. */
const PDF_MAGIC = '%PDF-';

/** Row shape for list/response — everything except the bytes. */
const META_COLUMNS = {
  id: companyDocuments.id,
  siteId: companyDocuments.siteId,
  siteName: sites.name,
  name: companyDocuments.name,
  fileName: companyDocuments.fileName,
  mimeType: companyDocuments.mimeType,
  sizeBytes: companyDocuments.sizeBytes,
  validUntil: companyDocuments.validUntil,
  remindDaysBefore: companyDocuments.remindDaysBefore,
  reminderSentFor: companyDocuments.reminderSentFor,
  uploadedBy: companyDocuments.uploadedBy,
  createdAt: companyDocuments.createdAt,
  updatedAt: companyDocuments.updatedAt,
} as const;

/**
 * One document's metadata as the join returns it.
 *
 * The two date columns are DATE on Postgres and text here, so they arrive as
 * 'YYYY-MM-DD' rather than as the UTC midnight Prisma produced. Everything
 * downstream formats them to exactly that string anyway.
 */
type DocumentMeta = {
  id: string;
  siteId: string;
  siteName: string | null;
  name: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  validUntil: string | null;
  remindDaysBefore: number;
  reminderSentFor: string | null;
  uploadedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * "2026-12-31" validated and returned as itself.
 *
 * The column is a calendar day, and it is text on SQLite for that reason — a
 * day given a time component drifts across the boundary at +05:30. This used
 * to hand back the UTC midnight a DATE column round-tripped.
 */
export function parseDay(iso: string): string {
  const d = DateTime.fromISO(iso, { zone: 'utc' }).startOf('day');
  if (!d.isValid) throw Errors.validation({ message: `Invalid date: ${iso}` });
  return d.toFormat('yyyy-LL-dd');
}

/** The stored day, which is already "2026-12-31". */
export function formatDay(value: string | null): string | null {
  return value ?? null;
}

/**
 * Whole days from today (in `timezone`) to a validity date. Negative = expired.
 *
 * The stored DATE is read in UTC and re-anchored to midnight in the company's
 * zone before the subtraction, so the answer is a count of calendar days and
 * never the off-by-one an offset would introduce.
 */
export function daysUntil(validUntil: string, timezone: string): number {
  const due = DateTime.fromISO(validUntil, { zone: 'utc' });
  const dueLocal = DateTime.fromObject(
    { year: due.year, month: due.month, day: due.day },
    { zone: timezone },
  );
  const today = DateTime.now().setZone(timezone).startOf('day');
  return Math.round(dueLocal.diff(today, 'days').as('days'));
}

@Injectable()
export class CompanyDocumentsService {
  private readonly logger = new Logger(CompanyDocumentsService.name);

  constructor(
    private readonly d1: D1Service,
    private readonly audit: AuditService,
  ) {}

  /**
   * The sites this caller may read paperwork for, as a `where` fragment.
   *
   * Same rule as `assertSiteInScope`: scopes are an opt-in restriction, so a
   * user with none sees the whole organization. It only started to matter when
   * the Safety Officer — a role that is routinely pinned to one site — was let
   * in to read these.
   */
  private scopeWhere(user: AuthUser): SQL[] {
    if (user.role === 'SUPER_ADMIN' || user.siteScopes.length === 0) return [];
    return [inArray(companyDocuments.siteId, user.siteScopes)];
  }

  /** The metadata join, which every read of a document shares. */
  private metaQuery() {
    return this.d1.db
      .select(META_COLUMNS)
      .from(companyDocuments)
      .leftJoin(sites, eq(sites.id, companyDocuments.siteId));
  }

  /** Soonest expiry first; undated documents sit at the bottom. */
  async list(user: AuthUser, siteId?: string) {
    const [rows, timezone] = await Promise.all([
      this.metaQuery()
        // Both conditions key on siteId and both are applied — the requested
        // site narrows the caller's scope, it cannot widen past it.
        .where(
          and(
            eq(companyDocuments.organizationId, user.organizationId),
            ...this.scopeWhere(user),
            ...(siteId ? [eq(companyDocuments.siteId, siteId)] : []),
          ),
        )
        // Undated documents sit at the bottom. SQLite sorts NULL first, so the
        // nulls-last that Prisma expressed as an option is spelled out here.
        .orderBy(
          sql`case when ${companyDocuments.validUntil} is null then 1 else 0 end`,
          asc(companyDocuments.validUntil),
          desc(companyDocuments.createdAt),
        ),
      this.timezone(user.organizationId),
    ]);
    return rows.map((r) => this.toResponse(r, timezone));
  }

  /** The site must be one of this organization's — a UUID alone proves nothing. */
  private async assertSite(user: AuthUser, siteId: string) {
    const [site] = await this.d1.db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, siteId), eq(sites.organizationId, user.organizationId)))
      .limit(1);
    if (!site) throw Errors.notFound('Site');
  }

  async create(user: AuthUser, dto: UploadCompanyDocumentDto) {
    await this.assertSite(user, dto.siteId);
    if (!ALLOWED_DOCUMENT_TYPES.includes(dto.mimeType)) {
      throw Errors.validation({ message: 'Only PDF documents can be uploaded' });
    }

    let raw: Buffer;
    try {
      raw = Buffer.from(dto.dataBase64, 'base64');
    } catch {
      throw Errors.validation({ message: 'dataBase64 is not valid base64' });
    }
    if (raw.length === 0) throw Errors.validation({ message: 'Empty file' });
    if (raw.length > MAX_DOCUMENT_BYTES) {
      throw Errors.validation({
        message: `File too large (max ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB)`,
      });
    }
    // Trust the bytes, not the declared mime type — a renamed .exe would
    // otherwise be handed back to a browser as application/pdf.
    if (raw.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) {
      throw Errors.validation({ message: 'That file is not a PDF' });
    }

    // The PDF goes to object storage and the row keeps only metadata. Written
    // before the row, so a failed upload leaves nothing behind rather than a
    // document that lists but will not open.
    const id = randomUUID();
    const useStore = blobStoreConfigured();
    const storageKey = `org/${user.organizationId}/documents/${id}`;
    if (useStore) {
      await blobStore.put(storageKey, raw, dto.mimeType);
    }

    const now = new Date();
    await this.d1.db.insert(companyDocuments).values({
      id,
      organizationId: user.organizationId,
      siteId: dto.siteId,
      // The file's own name is the opening suggestion; the client renames it.
      name: (dto.name?.trim() || defaultName(dto.fileName)).slice(0, 160),
      fileName: dto.fileName,
      mimeType: dto.mimeType,
      storageKey: useStore ? storageKey : null,
      data: useStore ? null : raw,
      sizeBytes: raw.length,
      validUntil: dto.validUntil ? parseDay(dto.validUntil) : null,
      remindDaysBefore: dto.remindDaysBefore ?? DEFAULT_REMIND_DAYS_BEFORE,
      uploadedBy: user.userId,
      createdAt: now,
      updatedAt: now,
    });
    // Read back through the join, which is what carries the site's name.
    const doc = await this.getMeta(user, id);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'COMPANY_DOCUMENT_UPLOAD',
      entityType: 'CompanyDocument',
      entityId: doc.id,
      newValue: doc,
    });
    return this.toResponse(doc, await this.timezone(user.organizationId));
  }

  async update(user: AuthUser, id: string, dto: UpdateCompanyDocumentDto) {
    const before = await this.getMeta(user, id);

    const data: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.siteId !== undefined) {
      await this.assertSite(user, dto.siteId);
      data.siteId = dto.siteId;
    }
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.validUntil !== undefined) {
      data.validUntil = dto.validUntil ? parseDay(dto.validUntil) : null;
    }
    if (dto.remindDaysBefore !== undefined) data.remindDaysBefore = dto.remindDaysBefore;
    // Re-dating the document or moving the lead time means the mail that already
    // went out described the old schedule, so both reminders are armed again.
    if (dto.validUntil !== undefined || dto.remindDaysBefore !== undefined) {
      data.reminderSentFor = null;
      data.expirySentFor = null;
    }

    await this.d1.db.update(companyDocuments).set(data).where(eq(companyDocuments.id, id));
    const doc = await this.getMeta(user, id);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'COMPANY_DOCUMENT_UPDATE',
      entityType: 'CompanyDocument',
      entityId: id,
      oldValue: before,
      newValue: doc,
    });
    return this.toResponse(doc, await this.timezone(user.organizationId));
  }

  async remove(user: AuthUser, id: string) {
    const before = await this.getMeta(user, id);
    const [stored] = await this.d1.db
      .select({ storageKey: companyDocuments.storageKey })
      .from(companyDocuments)
      .where(eq(companyDocuments.id, id))
      .limit(1);
    await this.d1.db.delete(companyDocuments).where(eq(companyDocuments.id, id));
    if (stored?.storageKey) {
      // After the row, deliberately: a failure here leaves an unreferenced
      // object, where the reverse order leaves a document that lists but
      // cannot be opened.
      await blobStore.delete(stored.storageKey).catch((e: unknown) => {
        this.logger.warn(`Left an orphaned object ${stored.storageKey}: ${String(e)}`);
      });
    }
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'COMPANY_DOCUMENT_DELETE',
      entityType: 'CompanyDocument',
      entityId: id,
      oldValue: before,
    });
    return { deleted: true };
  }

  /** The file itself, for streaming back to the browser. */
  async file(user: AuthUser, id: string) {
    const [doc] = await this.d1.db
      .select({
        fileName: companyDocuments.fileName,
        mimeType: companyDocuments.mimeType,
        storageKey: companyDocuments.storageKey,
        data: companyDocuments.data,
      })
      .from(companyDocuments)
      // Scoped like the list: a document the caller cannot see listed is not
      // one they can open by pasting its id either.
      .where(
        and(
          eq(companyDocuments.id, id),
          eq(companyDocuments.organizationId, user.organizationId),
          ...this.scopeWhere(user),
        ),
      )
      .limit(1);
    if (!doc) throw Errors.notFound('Document');
    // Documents uploaded before the move still carry their bytes in the column.
    const data = await readStoredBytes(doc);
    if (!data) throw Errors.notFound('Document');
    return { ...doc, data };
  }

  private async getMeta(user: AuthUser, id: string): Promise<DocumentMeta> {
    const [doc] = await this.metaQuery()
      .where(
        and(
          eq(companyDocuments.id, id),
          eq(companyDocuments.organizationId, user.organizationId),
        ),
      )
      .limit(1);
    if (!doc) throw Errors.notFound('Document');
    return doc;
  }

  private async timezone(organizationId: string): Promise<string> {
    const [org] = await this.d1.db
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return org?.timezone ?? 'Asia/Kolkata';
  }

  /**
   * Dates leave as plain YYYY-MM-DD strings, and the countdown is computed here
   * in the company's own timezone — a browser in another zone must not be the
   * thing that decides whether a licence expires today or tomorrow.
   */
  private toResponse(doc: DocumentMeta, timezone: string) {
    const daysUntilExpiry = doc.validUntil ? daysUntil(doc.validUntil, timezone) : null;
    return {
      ...doc,
      // Flattened: every caller wants the name beside the row, none of them
      // want to reach through a nested object for it.
      siteName: doc.siteName ?? null,
      validUntil: formatDay(doc.validUntil),
      reminderSentFor: formatDay(doc.reminderSentFor),
      daysUntilExpiry,
      remindOn:
        doc.validUntil && daysUntilExpiry !== null
          ? DateTime.fromISO(doc.validUntil, { zone: 'utc' })
              .minus({ days: doc.remindDaysBefore })
              .toFormat('yyyy-LL-dd')
          : null,
    };
  }
}

/** "PF-registration.pdf" → "PF-registration". */
function defaultName(fileName: string): string {
  const base = fileName.replace(/\.[^./\\]+$/, '').trim();
  return base || fileName.trim() || 'Document';
}
