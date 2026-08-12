import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Soonest expiry first; undated documents sit at the bottom. */
  async list(user: AuthUser) {
    const [rows, timezone] = await Promise.all([
      this.prisma.companyDocument.findMany({
        where: { organizationId: user.organizationId },
        orderBy: [{ validUntil: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        select: META_SELECT,
      }),
      this.timezone(user.organizationId),
    ]);
    return rows.map((r) => this.toResponse(r, timezone));
  }

  async create(user: AuthUser, dto: UploadCompanyDocumentDto) {
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

    const doc = await this.prisma.companyDocument.create({
      data: {
        organizationId: user.organizationId,
        // The file's own name is the opening suggestion; the client renames it.
        name: (dto.name?.trim() || defaultName(dto.fileName)).slice(0, 160),
        fileName: dto.fileName,
        mimeType: dto.mimeType,
        data: raw,
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
    await this.prisma.companyDocument.delete({ where: { id } });
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
      where: { id, organizationId: user.organizationId },
      select: { fileName: true, mimeType: true, data: true },
    });
    if (!doc) throw Errors.notFound('Document');
    return { ...doc, data: Buffer.from(doc.data) };
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
    return {
      ...doc,
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
