import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../../infra/prisma/prisma.service';
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
const META_SELECT = {
  id: true,
  siteId: true,
  site: { select: { name: true } },
  name: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  validUntil: true,
  remindDaysBefore: true,
  reminderSentFor: true,
  uploadedBy: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CompanyDocumentSelect;

type DocumentMeta = Prisma.CompanyDocumentGetPayload<{ select: typeof META_SELECT }>;

/** "2026-12-31" → the UTC midnight a DATE column round-trips unchanged. */
export function parseDay(iso: string): Date {
  const d = DateTime.fromISO(iso, { zone: 'utc' }).startOf('day');
  if (!d.isValid) throw Errors.validation({ message: `Invalid date: ${iso}` });
  return d.toJSDate();
}

/** A DATE column back to "2026-12-31" — read in UTC, never the server's zone. */
export function formatDay(value: Date | null): string | null {
  return value ? DateTime.fromJSDate(value, { zone: 'utc' }).toFormat('yyyy-LL-dd') : null;
}

/**
 * Whole days from today (in `timezone`) to a validity date. Negative = expired.
 *
 * The stored DATE is read in UTC and re-anchored to midnight in the company's
 * zone before the subtraction, so the answer is a count of calendar days and
 * never the off-by-one an offset would introduce.
 */
export function daysUntil(validUntil: Date, timezone: string): number {
  const due = DateTime.fromJSDate(validUntil, { zone: 'utc' });
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
    private readonly prisma: PrismaService,
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
  private scopeWhere(user: AuthUser): Prisma.CompanyDocumentWhereInput {
    if (user.role === 'SUPER_ADMIN' || user.siteScopes.length === 0) return {};
    return { siteId: { in: user.siteScopes } };
  }

  /** Soonest expiry first; undated documents sit at the bottom. */
  async list(user: AuthUser, siteId?: string) {
    const [rows, timezone] = await Promise.all([
      this.prisma.companyDocument.findMany({
        // AND rather than one flat object: both fragments key on `siteId`, and
        // spreading them would let the requested site quietly overwrite — and
        // so escape — the caller's scope.
        where: {
          organizationId: user.organizationId,
          AND: [this.scopeWhere(user), siteId ? { siteId } : {}],
        },
        orderBy: [{ validUntil: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        select: META_SELECT,
      }),
      this.timezone(user.organizationId),
    ]);
    return rows.map((r) => this.toResponse(r, timezone));
  }

  /** The site must be one of this organization's — a UUID alone proves nothing. */
  private async assertSite(user: AuthUser, siteId: string) {
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, organizationId: user.organizationId },
      select: { id: true },
    });
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

    const doc = await this.prisma.companyDocument.create({
      data: {
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
      },
      select: META_SELECT,
    });

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

    const data: Prisma.CompanyDocumentUpdateInput = {};
    if (dto.siteId !== undefined) {
      await this.assertSite(user, dto.siteId);
      data.site = { connect: { id: dto.siteId } };
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

    const doc = await this.prisma.companyDocument.update({
      where: { id },
      data,
      select: META_SELECT,
    });

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
    const stored = await this.prisma.companyDocument.findUnique({
      where: { id },
      select: { storageKey: true },
    });
    await this.prisma.companyDocument.delete({ where: { id } });
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
    const doc = await this.prisma.companyDocument.findFirst({
      // Scoped like the list: a document the caller cannot see listed is not
      // one they can open by pasting its id either.
      where: { id, organizationId: user.organizationId, ...this.scopeWhere(user) },
      select: { fileName: true, mimeType: true, storageKey: true, data: true },
    });
    if (!doc) throw Errors.notFound('Document');
    // Documents uploaded before the move still carry their bytes in the column.
    const data = await readStoredBytes(doc);
    if (!data) throw Errors.notFound('Document');
    return { ...doc, data };
  }

  private async getMeta(user: AuthUser, id: string): Promise<DocumentMeta> {
    const doc = await this.prisma.companyDocument.findFirst({
      where: { id, organizationId: user.organizationId },
      select: META_SELECT,
    });
    if (!doc) throw Errors.notFound('Document');
    return doc;
  }

  private async timezone(organizationId: string): Promise<string> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone ?? 'Asia/Kolkata';
  }

  /**
   * Dates leave as plain YYYY-MM-DD strings, and the countdown is computed here
   * in the company's own timezone — a browser in another zone must not be the
   * thing that decides whether a licence expires today or tomorrow.
   */
  private toResponse(doc: DocumentMeta, timezone: string) {
    const daysUntilExpiry = doc.validUntil ? daysUntil(doc.validUntil, timezone) : null;
    const { site, ...rest } = doc;
    return {
      ...rest,
      // Flattened: every caller wants the name beside the row, none of them
      // want to reach through a nested object for it.
      siteName: site?.name ?? null,
      validUntil: formatDay(doc.validUntil),
      reminderSentFor: formatDay(doc.reminderSentFor),
      daysUntilExpiry,
      remindOn:
        doc.validUntil && daysUntilExpiry !== null
          ? formatDay(
              DateTime.fromJSDate(doc.validUntil, { zone: 'utc' })
                .minus({ days: doc.remindDaysBefore })
                .toJSDate(),
            )
          : null,
    };
  }
}

/** "PF-registration.pdf" → "PF-registration". */
function defaultName(fileName: string): string {
  const base = fileName.replace(/\.[^./\\]+$/, '').trim();
  return base || fileName.trim() || 'Document';
}
