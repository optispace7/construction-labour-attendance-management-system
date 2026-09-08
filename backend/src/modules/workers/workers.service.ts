import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { and, asc, count, desc, eq, gte, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { D1Service } from '../../infra/d1/d1.service';
import {
  designations,
  organizations,
  photoBlobs,
  sites,
  vendors,
  workerCredentials,
  workerSiteAssignments,
  workers,
} from '../../infra/d1/schema.generated';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { readStoredBytes } from '../files/read-blob';
import { blobStore } from '../files/blob-store';
import {
  AssignSiteDto,
  BindCredentialDto,
  CreateWorkerDto,
  ExitWorkerDto,
  RehireWorkerDto,
  UpdateWorkerDto,
} from './dto/worker.dto';

/**
 * Makes a name safe to use as a zip path segment: strips separators and the
 * characters Windows rejects, and refuses "." / ".." so an entry can never
 * escape its folder when extracted.
 */
function sanitizeSegment(raw: string): string {
  const cleaned = raw
    .replace(/[/\\:*?"<>|]/g, ' ')
    // Control characters have no business in a filename.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Trailing dots/spaces are silently dropped by Windows.
    .replace(/[. ]+$/, '');
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'unnamed' : cleaned;
}

/** "/files/<uuid>" -> "<uuid>". Anything else (external url) has no blob. */
function blobIdFromPhotoUrl(url: string | null): string | null {
  if (!url?.startsWith('/files/')) return null;
  const id = url.slice('/files/'.length);
  return id.length > 0 ? id : null;
}

type PersonCategory = 'WORKER' | 'STAFF' | 'VISITOR';
type CredentialKind = 'NFC_UID' | 'QR';
type WorkerRow = typeof workers.$inferSelect;

/**
 * The columns the list endpoint returns.
 *
 * Prisma's `select` decided this; here it is a projection applied after the
 * row is read. Written out rather than returning the whole row on purpose —
 * the row now carries the Aadhaar, PAN and bank ciphertext, and a list that
 * quietly started including them would be a leak rather than a bug.
 */
function LIST_FIELDS(w: WorkerRow) {
  return {
    id: w.id,
    workerCode: w.workerCode,
    fullName: w.fullName,
    fatherName: w.fatherName,
    gender: w.gender,
    dateOfBirth: w.dateOfBirth,
    photoUrl: w.photoUrl,
    mobileNumber: w.mobileNumber,
    email: w.email,
    status: w.status,
    vendorId: w.vendorId,
    category: w.category,
    escortName: w.escortName,
    visitorCompany: w.visitorCompany,
    idProofPhotoId: w.idProofPhotoId,
    designationId: w.designationId,
    natureOfContractor: w.natureOfContractor,
    pfNumber: w.pfNumber,
    esiNumber: w.esiNumber,
    govIdType: w.govIdType,
    aadhaarLast4: w.aadhaarLast4,
    panLast4: w.panLast4,
    bloodGroup: w.bloodGroup,
    emergencyContactName: w.emergencyContactName,
    emergencyContactNumber: w.emergencyContactNumber,
    screeningDoneOn: w.screeningDoneOn,
    screeningDoneBy: w.screeningDoneBy,
    inductionDoneOn: w.inductionDoneOn,
    inductedBy: w.inductedBy,
    validityTill: w.validityTill,
  };
}

/**
 * A stored blob as a Buffer.
 *
 * D1 hands back an ArrayBuffer where Postgres gave bytea and Prisma gave a
 * Buffer. The ciphertext has to reach the decipher byte for byte, so the
 * conversion is stated once here rather than at each of the three columns.
 */
function toBuffer(value: unknown): Buffer {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    const v = value as ArrayBufferView;
    return Buffer.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  return Buffer.from(value as never);
}

/**
 * A calendar date as SQLite stores it.
 *
 * These columns are days, not instants — a date of birth has no time and no
 * timezone — so they are text, and giving one a time component is how a
 * birthday shifts by a day for anyone east of Greenwich.
 */
function dateOnly(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

@Injectable()
export class WorkersService {
  private readonly logger = new Logger(WorkersService.name);

  constructor(
    private readonly d1: D1Service,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  // ---- Shapers -------------------------------------------------------------
  private limitedCard(w: {
    id: string;
    fullName: string;
    photoUrl: string | null;
    bloodGroup: string | null;
    emergencyContactName: string | null;
    emergencyContactNumber: string | null;
    workerCode: string;
    category?: string | null;
    // A day, held as text now, so it is passed through rather than formatted.
    validityTill?: string | Date | null;
    vendor?: { name: string } | null;
    designation?: { name: string } | null;
  }) {
    return {
      id: w.id,
      workerCode: w.workerCode,
      fullName: w.fullName,
      photoUrl: w.photoUrl,
      bloodGroup: w.bloodGroup,
      emergencyContactName: w.emergencyContactName,
      emergencyContactNumber: w.emergencyContactNumber,
      category: w.category ?? 'WORKER',
      // Date-only: the device compares it against its own local calendar day.
      // It is already stored as 'YYYY-MM-DD', so there is nothing to format —
      // dateOnly is kept for the Date the older callers still pass.
      validityTill: dateOnly(w.validityTill),
      vendorName: w.vendor?.name ?? null,
      designationName: w.designation?.name ?? null,
    };
  }

  /** Auto-generate a unique code: W-0001 (workers), S-0001 (staff), V-0001 (visitors). */
  private async generateWorkerCode(organizationId: string, category: PersonCategory) {
    const prefix = category === 'STAFF' ? 'S' : category === 'VISITOR' ? 'V' : 'W';
    const [{ n }] = await this.d1.db
      .select({ n: count() })
      .from(workers)
      .where(and(eq(workers.organizationId, organizationId), eq(workers.category, category)));
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = `${prefix}-${String(n + 1 + attempt).padStart(4, '0')}`;
      const [exists] = await this.d1.db
        .select({ id: workers.id })
        .from(workers)
        .where(and(eq(workers.organizationId, organizationId), eq(workers.workerCode, code)))
        .limit(1);
      if (!exists) return code;
    }
    return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
  }

  // ---- Queries -------------------------------------------------------------
  async list(
    user: AuthUser,
    opts: {
      siteId?: string;
      vendorId?: string;
      status?: string;
      q?: string;
      limit?: number;
      cursor?: string;
      category?: string;
      sortBy?: string;
    },
  ) {
    const limit = Math.min(opts.limit ?? 50, 200);

    const filters: SQL[] = [
      eq(workers.organizationId, user.organizationId),
      isNull(workers.deletedAt),
    ];
    if (opts.category) filters.push(eq(workers.category, opts.category));
    if (opts.vendorId) filters.push(eq(workers.vendorId, opts.vendorId));
    if (opts.status) filters.push(eq(workers.status, opts.status));
    if (opts.siteId) {
      // `assignments: { some: ... }` becomes an EXISTS, which is what it always
      // was underneath — and unlike a join it cannot duplicate a worker who has
      // more than one assignment.
      filters.push(
        sql`EXISTS (SELECT 1 FROM worker_site_assignments a
                     WHERE a.worker_id = ${workers.id}
                       AND a.site_id = ${opts.siteId} AND a.end_date IS NULL)`,
      );
    }
    if (opts.q) {
      // Two of these were case-insensitive on Postgres and would quietly stop
      // matching on SQLite; the third never was. LIKE is case-insensitive for
      // ASCII in SQLite, but lower() is written out so it does not depend on
      // that being true for the next character somebody types.
      const term = `%${opts.q.toLowerCase()}%`;
      filters.push(
        sql`(lower(${workers.fullName}) LIKE ${term}
             OR lower(${workers.workerCode}) LIKE ${term}
             OR ${workers.mobileNumber} LIKE ${`%${opts.q}%`})`,
      );
    }

    // Prisma took a cursor row by id and paged from its position. Keyset
    // paging says the same thing directly, but it needs the sort values of
    // that row, so they are looked up first.
    let after: typeof workers.$inferSelect | undefined;
    if (opts.cursor) {
      [after] = await this.d1.db
        .select()
        .from(workers)
        .where(eq(workers.id, opts.cursor))
        .limit(1);
    }

    const sortBy = opts.sortBy;
    if (after) {
      if (sortBy === 'name') {
        filters.push(
          sql`(${workers.fullName}, ${workers.id}) > (${after.fullName}, ${after.id})`,
        );
      } else if (sortBy !== 'designation' && sortBy !== 'vendor') {
        filters.push(
          sql`(${workers.createdAt}, ${workers.id}) < (${after.createdAt}, ${after.id})`,
        );
      }
      // designation/vendor sorts page in memory below — their keys live on
      // another table and are not unique, so a keyset on them is not stable.
    }

    const base = this.d1.db
      .select({
        worker: workers,
        vendorName: vendors.name,
        designationName: designations.name,
      })
      .from(workers)
      .leftJoin(vendors, eq(vendors.id, workers.vendorId))
      .leftJoin(designations, eq(designations.id, workers.designationId))
      .where(and(...filters));

    const ordered =
      sortBy === 'designation'
        ? base.orderBy(asc(designations.name), asc(workers.fullName), asc(workers.id))
        : sortBy === 'vendor'
          ? base.orderBy(asc(vendors.name), asc(workers.fullName), asc(workers.id))
          : sortBy === 'name'
            ? base.orderBy(asc(workers.fullName), asc(workers.id))
            : base.orderBy(desc(workers.createdAt), desc(workers.id));

    // The two relation sorts cannot use a keyset, so they are paged by offset
    // from the cursor row's position — the same answer, one extra scan.
    let rows = await ordered.limit(limit + 1 + (after && (sortBy === 'designation' || sortBy === 'vendor') ? 1000 : 0));
    if (after && (sortBy === 'designation' || sortBy === 'vendor')) {
      const at = rows.findIndex((r) => r.worker.id === after!.id);
      rows = at >= 0 ? rows.slice(at + 1, at + 1 + limit + 1) : rows.slice(0, limit + 1);
    }

    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? page[page.length - 1]?.worker.id ?? null : null;

    // The current site assignment supplies the "Project Name" line on the ID
    // card. Fetched for the page rather than joined, so a worker with several
    // assignments still appears once.
    const currentSites = await this.currentSiteNames(page.map((r) => r.worker.id));

    const data = page.map((r) => ({
      ...LIST_FIELDS(r.worker),
      vendor: r.vendorName ? { name: r.vendorName } : null,
      designation: r.designationName ? { name: r.designationName } : null,
      assignments: currentSites.has(r.worker.id)
        ? [{ site: { name: currentSites.get(r.worker.id) as string } }]
        : [],
    }));
    return { data, nextCursor };
  }

  /** Current (open) site name per worker, for a page of rows. */
  private async currentSiteNames(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.d1.db
      .select({
        workerId: workerSiteAssignments.workerId,
        siteName: sites.name,
        startDate: workerSiteAssignments.startDate,
      })
      .from(workerSiteAssignments)
      .innerJoin(sites, eq(sites.id, workerSiteAssignments.siteId))
      .where(
        and(
          inArray(workerSiteAssignments.workerId, ids),
          isNull(workerSiteAssignments.endDate),
        ),
      )
      .orderBy(desc(workerSiteAssignments.startDate));
    const byWorker = new Map<string, string>();
    // First wins, and the ordering above makes that the most recent one.
    for (const r of rows) if (!byWorker.has(r.workerId)) byWorker.set(r.workerId, r.siteName);
    return byWorker;
  }

  /** Full profile. Aadhaar is decrypted only when reveal=true and is audited. */
  async get(user: AuthUser, id: string, reveal = false) {
    const [row] = await this.d1.db
      .select({ worker: workers, vendor: vendors, designation: designations })
      .from(workers)
      .leftJoin(vendors, eq(vendors.id, workers.vendorId))
      .leftJoin(designations, eq(designations.id, workers.designationId))
      .where(
        and(
          eq(workers.id, id),
          eq(workers.organizationId, user.organizationId),
          isNull(workers.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw Errors.workerNotFound();

    // The two collections are fetched separately rather than joined: joining
    // both would multiply the row by assignments x credentials and the counts
    // would have to be undone afterwards.
    const [assignmentRows, credentialRows] = await Promise.all([
      this.d1.db
        .select({ assignment: workerSiteAssignments, site: sites })
        .from(workerSiteAssignments)
        .innerJoin(sites, eq(sites.id, workerSiteAssignments.siteId))
        .where(
          and(
            eq(workerSiteAssignments.workerId, id),
            isNull(workerSiteAssignments.endDate),
          ),
        ),
      this.d1.db
        .select()
        .from(workerCredentials)
        .where(
          and(eq(workerCredentials.workerId, id), eq(workerCredentials.isActive, true)),
        ),
    ]);

    const worker = {
      ...row.worker,
      vendor: row.vendor,
      designation: row.designation,
      assignments: assignmentRows.map((a) => ({ ...a.assignment, site: a.site })),
      credentials: credentialRows,
    };

    let aadhaar: string | undefined;
    let pan: string | undefined;
    let bankAccount: string | undefined;
    if (
      reveal &&
      (worker.aadhaarCiphertext || worker.panCiphertext || worker.bankAccountCiphertext)
    ) {
      if (worker.aadhaarCiphertext) {
        aadhaar = this.crypto.decrypt(toBuffer(worker.aadhaarCiphertext));
      }
      if (worker.panCiphertext) {
        pan = this.crypto.decrypt(toBuffer(worker.panCiphertext));
      }
      if (worker.bankAccountCiphertext) {
        bankAccount = this.crypto.decrypt(toBuffer(worker.bankAccountCiphertext));
      }
      await this.audit.record({
        organizationId: user.organizationId,
        actorUserId: user.userId,
        actorRole: user.role,
        action: 'WORKER_AADHAAR_REVEAL',
        entityType: 'Worker',
        entityId: id,
      });
    }

    // Never return raw ciphertext or the legacy plaintext bank column.
    const {
      aadhaarCiphertext: _omit,
      panCiphertext: _omit2,
      bankAccountCiphertext: _omit3,
      bankAccountNumber: _omit4,
      ...rest
    } = worker;
    void _omit;
    void _omit2;
    void _omit3;
    void _omit4;
    return { ...rest, aadhaar, pan, bankAccount };
  }

  // ---- Document export -----------------------------------------------------

  /**
   * Yields every stored image for the given people, one at a time, as
   * `<folder>/<file>` entries ready to be zipped. Streaming rather than
   * returning an array: a few hundred people is hundreds of MB of decrypted
   * JPEG, which we do not want resident all at once.
   *
   * Blob rows are fetched one by one for the same reason — `data` is the whole
   * image, so a findMany over a page of people would pull every card into
   * memory before the first byte reaches the client.
   */
  async *documentFiles(
    user: AuthUser,
    ids: string[],
  ): AsyncGenerator<{ path: string; data: Buffer }> {
    const people = await this.d1.db
      .select({
        id: workers.id,
        fullName: workers.fullName,
        workerCode: workers.workerCode,
        photoUrl: workers.photoUrl,
        aadhaarFrontPhotoId: workers.aadhaarFrontPhotoId,
        aadhaarBackPhotoId: workers.aadhaarBackPhotoId,
        idProofPhotoId: workers.idProofPhotoId,
      })
      .from(workers)
      .where(
        and(
          inArray(workers.id, ids),
          eq(workers.organizationId, user.organizationId),
          isNull(workers.deletedAt),
        ),
      )
      .orderBy(asc(workers.fullName), asc(workers.id));
    if (people.length === 0) throw Errors.notFound('Worker');

    for (const p of people) {
      // Two people can share a name, so the code disambiguates the folder.
      const folder = `${sanitizeSegment(p.fullName)} (${sanitizeSegment(p.workerCode)})`;
      const wanted: [string, string | null][] = [
        // The profile photo is stored as a "/files/<id>" url; cards as bare ids.
        ['photo', blobIdFromPhotoUrl(p.photoUrl)],
        ['aadhaar-front', p.aadhaarFrontPhotoId],
        ['aadhaar-back', p.aadhaarBackPhotoId],
        ['id-proof', p.idProofPhotoId],
      ];
      for (const [name, blobId] of wanted) {
        if (!blobId) continue;
        const [blob] = await this.d1.db
          .select()
          .from(photoBlobs)
          .where(
            and(eq(photoBlobs.id, blobId), eq(photoBlobs.organizationId, user.organizationId)),
          )
          .limit(1);
        // A dangling id is not worth failing the whole export over.
        if (!blob) continue;
        // Bytes may be in object storage or, for rows written before that move,
        // still in the column — readStoredBytes covers both. A missing object
        // is treated like a dangling id: skipped, not fatal.
        const stored = await readStoredBytes({
          storageKey: blob.storageKey,
          // D1 types a blob column as unknown; readStoredBytes wants the bytes.
          data: blob.data == null ? null : new Uint8Array(toBuffer(blob.data)),
        });
        if (!stored) continue;
        const data = blob.isEncrypted ? this.crypto.decryptBuffer(stored) : stored;
        yield { path: `${folder}/${name}${extensionFor(blob.mimeType)}`, data };
      }
    }

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'WORKER_DOCUMENTS_EXPORT',
      entityType: 'Worker',
      entityId: people.length === 1 ? people[0].id : null,
      newValue: { count: people.length, workerIds: people.map((p) => p.id) },
    });
  }

  // ---- Mutations -----------------------------------------------------------
  async create(user: AuthUser, dto: CreateWorkerDto) {
    const category = dto.category ?? 'WORKER';
    // Every visitor must have an escort recorded.
    if (category === 'VISITOR' && !dto.escortName?.trim()) {
      throw Errors.businessRule('Escort name is required for visitors.');
    }
    // Visitors are day passes — default the visit date to today so the pass
    // can auto-expire at end of day.
    const joinDate = dto.joinDate
      ? new Date(dto.joinDate)
      : category === 'VISITOR'
        ? new Date()
        : undefined;

    // Retry on the (rare) auto-ID race: two simultaneous creates can pick the
    // same next number; regenerate and try again.
    let worker: { id: string; workerCode: string; fullName: string } | null = null;
    for (let attempt = 0; worker === null; attempt++) {
      const workerCode =
        dto.workerCode?.trim() || (await this.generateWorkerCode(user.organizationId, category));
      try {
        worker = await this.createWithCode(user, dto, category, workerCode, joinDate);
      } catch (e) {
        // SQLite reports this as a message rather than Prisma's P2002 code.
        const isUnique = /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));
        if (isUnique && !dto.workerCode && attempt < 3) continue;
        if (isUnique) throw Errors.conflict(`ID "${workerCode}" is already in use`);
        throw e;
      }
    }

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'WORKER_CREATE',
      entityType: 'Worker',
      entityId: worker.id,
      newValue: { workerCode: worker.workerCode, fullName: worker.fullName },
    });
    return this.get(user, worker.id);
  }

  private async createWithCode(
    user: AuthUser,
    dto: CreateWorkerDto,
    category: PersonCategory,
    workerCode: string,
    joinDate: Date | undefined,
  ) {
    const aadhaarCiphertext = dto.aadhaar ? this.crypto.encrypt(dto.aadhaar) : undefined;
    const aadhaarLast4 = dto.aadhaar ? dto.aadhaar.replace(/\s/g, '').slice(-4) : undefined;
    const pan = dto.pan?.replace(/\s/g, '').toUpperCase();
    const panCiphertext = pan ? this.crypto.encrypt(pan) : undefined;
    const panLast4 = pan ? pan.slice(-4) : undefined;
    const bankAcct = dto.bankAccountNumber?.replace(/\s/g, '');
    const bankAccountCiphertext = bankAcct ? this.crypto.encrypt(bankAcct) : undefined;
    const bankAccountLast4 = bankAcct ? bankAcct.slice(-4) : undefined;

    // One batch instead of an interactive transaction: the id is generated
    // here, so the credential and assignment rows can be written alongside the
    // worker rather than after reading it back. A worker that appeared without
    // its NFC card bound would be a person who cannot scan in.
    const id = randomUUID();
    const now = new Date();
    const writes: unknown[] = [
      this.d1.db.insert(workers).values({
        id,
        organizationId: user.organizationId,
        workerCode,
        category,
        designationId: dto.designationId || null,
        createdById: user.userId,
        updatedById: user.userId,
        fullName: dto.fullName,
        fatherName: dto.fatherName ?? null,
        gender: dto.gender ?? null,
        dateOfBirth: dateOnly(dto.dateOfBirth),
        language: dto.language ?? null,
        pincode: dto.pincode ?? null,
        mobileNumber: dto.mobileNumber ?? null,
        email: dto.email ?? null,
        bloodGroup: dto.bloodGroup ?? null,
        emergencyContactName: dto.emergencyContactName ?? null,
        emergencyContactNumber: dto.emergencyContactNumber ?? null,
        screeningDoneOn: dateOnly(dto.screeningDoneOn),
        screeningDoneBy: dto.screeningDoneBy ?? null,
        inductionDoneOn: dateOnly(dto.inductionDoneOn),
        inductedBy: dto.inductedBy ?? null,
        validityTill: dateOnly(dto.validityTill),
        nomineeName: dto.nomineeName ?? null,
        nomineeRelation: dto.nomineeRelation ?? null,
        vendorId: dto.vendorId ?? null,
        natureOfContractor: dto.natureOfContractor ?? null,
        bankName: dto.bankName ?? null,
        bankAccountCiphertext: bankAccountCiphertext ?? null,
        bankAccountLast4: bankAccountLast4 ?? null,
        ifscCode: dto.ifscCode ?? null,
        pfNumber: dto.pfNumber ?? null,
        esiNumber: dto.esiNumber ?? null,
        govIdType: dto.govIdType ?? null,
        aadhaarCiphertext: aadhaarCiphertext ?? null,
        aadhaarLast4: aadhaarLast4 ?? null,
        aadhaarFrontPhotoId: dto.aadhaarFrontPhotoId ?? null,
        aadhaarBackPhotoId: dto.aadhaarBackPhotoId ?? null,
        panCiphertext: panCiphertext ?? null,
        panLast4: panLast4 ?? null,
        joinDate: joinDate ? joinDate.toISOString().slice(0, 10) : null,
        escortName: dto.escortName ?? null,
        visitorCompany: dto.visitorCompany ?? null,
        idProofPhotoId: dto.idProofPhotoId ?? null,
        notes: dto.notes ?? null,
        nfcUid: dto.nfcUid ?? null,
        qrIdentifier: dto.qrIdentifier ?? null,
        photoUrl: dto.photoUrl ?? null,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      }),
    ];
    if (dto.nfcUid) {
      writes.push(
        this.d1.db.insert(workerCredentials).values({
          id: randomUUID(),
          workerId: id,
          kind: 'NFC_UID',
          value: dto.nfcUid,
          isActive: true,
          issuedAt: now,
        }),
      );
    }
    if (dto.qrIdentifier) {
      writes.push(
        this.d1.db.insert(workerCredentials).values({
          id: randomUUID(),
          workerId: id,
          kind: 'QR',
          value: dto.qrIdentifier,
          isActive: true,
          issuedAt: now,
        }),
      );
    }
    if (dto.siteId) {
      writes.push(
        this.d1.db.insert(workerSiteAssignments).values({
          id: randomUUID(),
          workerId: id,
          siteId: dto.siteId,
          vendorId: dto.vendorId ?? null,
          startDate: (joinDate ?? now).toISOString().slice(0, 10),
          isPrimary: true,
          createdAt: now,
        }),
      );
    }
    await this.d1.db.batch(writes as never);
    return { id, workerCode, fullName: dto.fullName };
  }

  async update(user: AuthUser, id: string, dto: UpdateWorkerDto) {
    const [before] = await this.d1.db
      .select()
      .from(workers)
      .where(
        and(
          eq(workers.id, id),
          eq(workers.organizationId, user.organizationId),
          isNull(workers.deletedAt),
        ),
      )
      .limit(1);
    if (!before) throw Errors.workerNotFound();

    // Only keys the caller actually sent are written. Prisma treated undefined
    // as "leave alone"; Drizzle would write it as null, which would blank a
    // column the request never mentioned.
    const set: Record<string, unknown> = {};
    const put = (k: string, v: unknown) => {
      if (v !== undefined) set[k] = v;
    };
    const data = {
      fullName: dto.fullName,
      fatherName: dto.fatherName,
      gender: dto.gender,
      dateOfBirth: dto.dateOfBirth ? dateOnly(dto.dateOfBirth) : undefined,
      // Correcting a mis-keyed joining date changes which days the attendance
      // sheet treats as "not employed", so the before/after is audited below.
      joinDate: dto.joinDate ? dateOnly(dto.joinDate) : undefined,
      language: dto.language,
      pincode: dto.pincode,
      mobileNumber: dto.mobileNumber,
      email: dto.email,
      bloodGroup: dto.bloodGroup,
      emergencyContactName: dto.emergencyContactName,
      emergencyContactNumber: dto.emergencyContactNumber,
      screeningDoneOn: dto.screeningDoneOn ? dateOnly(dto.screeningDoneOn) : undefined,
      screeningDoneBy: dto.screeningDoneBy,
      inductionDoneOn: dto.inductionDoneOn ? dateOnly(dto.inductionDoneOn) : undefined,
      inductedBy: dto.inductedBy,
      validityTill: dto.validityTill ? dateOnly(dto.validityTill) : undefined,
      nomineeName: dto.nomineeName,
      nomineeRelation: dto.nomineeRelation,
      natureOfContractor: dto.natureOfContractor,
      bankName: dto.bankName,
      ifscCode: dto.ifscCode,
      pfNumber: dto.pfNumber,
      esiNumber: dto.esiNumber,
      govIdType: dto.govIdType,
      escortName: dto.escortName,
      visitorCompany: dto.visitorCompany,
      idProofPhotoId: dto.idProofPhotoId,
      notes: dto.notes,
      photoUrl: dto.photoUrl,
      aadhaarFrontPhotoId: dto.aadhaarFrontPhotoId,
      aadhaarBackPhotoId: dto.aadhaarBackPhotoId,
      status: dto.status,
      category: dto.category,
      updatedById: user.userId,
      // Relation connect/disconnect is just the foreign key here. An empty
      // designation means clear it, which is what disconnect meant.
      ...(dto.vendorId ? { vendorId: dto.vendorId } : {}),
      ...(dto.designationId !== undefined
        ? { designationId: dto.designationId || null }
        : {}),
    } as Record<string, unknown>;
    for (const [k, v] of Object.entries(data)) put(k, v);
    if (dto.aadhaar) {
      set.aadhaarCiphertext = this.crypto.encrypt(dto.aadhaar);
      set.aadhaarLast4 = dto.aadhaar.replace(/\s/g, '').slice(-4);
    }
    if (dto.pan) {
      const pan = dto.pan.replace(/\s/g, '').toUpperCase();
      set.panCiphertext = this.crypto.encrypt(pan);
      set.panLast4 = pan.slice(-4);
    }
    if (dto.bankAccountNumber !== undefined) {
      const bankAcct = dto.bankAccountNumber.replace(/\s/g, '');
      set.bankAccountCiphertext = bankAcct ? this.crypto.encrypt(bankAcct) : null;
      set.bankAccountLast4 = bankAcct ? bankAcct.slice(-4) : null;
    }
    set.updatedAt = new Date();

    await this.d1.db.update(workers).set(set).where(eq(workers.id, id));
    // Drop the previous photo blob when the photo changed (avoids DB bloat).
    if (dto.photoUrl !== undefined && before.photoUrl && before.photoUrl !== dto.photoUrl) {
      await this.deletePhotoBlobIfOrphan(user.organizationId, before.photoUrl);
    }
    // Same for replaced Aadhaar images (referenced by blob id, not URL).
    if (
      dto.aadhaarFrontPhotoId !== undefined &&
      before.aadhaarFrontPhotoId &&
      before.aadhaarFrontPhotoId !== dto.aadhaarFrontPhotoId
    ) {
      await this.deletePhotoBlobById(user.organizationId, before.aadhaarFrontPhotoId);
    }
    if (
      dto.aadhaarBackPhotoId !== undefined &&
      before.aadhaarBackPhotoId &&
      before.aadhaarBackPhotoId !== dto.aadhaarBackPhotoId
    ) {
      await this.deletePhotoBlobById(user.organizationId, before.aadhaarBackPhotoId);
    }
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'WORKER_UPDATE',
      entityType: 'Worker',
      entityId: id,
      oldValue: {
        fullName: before.fullName,
        status: before.status,
        joinDate: before.joinDate ?? null,
      },
      newValue: {
        fullName: dto.fullName ?? before.fullName,
        status: dto.status ?? before.status,
        joinDate: dto.joinDate ?? before.joinDate ?? null,
      },
    });
    return this.get(user, id);
  }

  async softDelete(user: AuthUser, id: string) {
    const [worker] = await this.d1.db
      .select()
      .from(workers)
      .where(
        and(
          eq(workers.id, id),
          eq(workers.organizationId, user.organizationId),
          isNull(workers.deletedAt),
        ),
      )
      .limit(1);
    if (!worker) throw Errors.workerNotFound();

    const now = new Date();
    // One batch: a worker marked deleted while their card stayed active would
    // still open the gate, which is the opposite of what deleting them means.
    await this.d1.db.batch([
      // Free UID/QR from active-uniqueness and clear credentials.
      this.d1.db
        .update(workers)
        .set({
          deletedAt: now,
          nfcUid: null,
          qrIdentifier: null,
          status: 'INACTIVE',
          updatedAt: now,
        })
        .where(eq(workers.id, id)),
      this.d1.db
        .update(workerCredentials)
        .set({ isActive: false, revokedAt: now, reason: 'worker deleted' })
        .where(
          and(eq(workerCredentials.workerId, id), eq(workerCredentials.isActive, true)),
        ),
    ] as never);

    await this.deletePhotoBlobIfOrphan(user.organizationId, worker.photoUrl);
    await this.deletePhotoBlobById(user.organizationId, worker.aadhaarFrontPhotoId);
    await this.deletePhotoBlobById(user.organizationId, worker.aadhaarBackPhotoId);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'WORKER_DELETE',
      entityType: 'Worker',
      entityId: id,
      oldValue: { status: worker.status },
    });
    return { deleted: true };
  }

  /** Deletes a /files/<id> photo blob once no worker references it anymore. */
  private async deletePhotoBlobIfOrphan(organizationId: string, url: string | null) {
    if (!url || !url.startsWith('/files/')) return;
    const blobId = url.slice('/files/'.length);
    const [{ n: stillUsed }] = await this.d1.db
      .select({ n: count() })
      .from(workers)
      .where(eq(workers.photoUrl, url));
    if (stillUsed === 0) {
      await this.deletePhotoBlobById(organizationId, blobId);
    }
  }

  /**
   * Deletes a photo blob: the row, then the stored object.
   *
   * That order matters. Removing the object first would leave a row pointing at
   * nothing, which reads as a corrupt image; this way a failure leaves an
   * unreferenced object instead — wasted space, which is recoverable, rather
   * than a broken record, which is not.
   */
  private async deletePhotoBlobById(organizationId: string, blobId: string | null) {
    if (!blobId) return;
    const blob = await this.d1.db
      .select({ storageKey: photoBlobs.storageKey })
      .from(photoBlobs)
      .where(and(eq(photoBlobs.id, blobId), eq(photoBlobs.organizationId, organizationId)))
      .limit(1)
      .then((r) => r[0])
      .catch(() => null);
    await this.d1.db
      .delete(photoBlobs)
      .where(and(eq(photoBlobs.id, blobId), eq(photoBlobs.organizationId, organizationId)))
      .catch(() => undefined);
    if (blob?.storageKey) {
      await blobStore.delete(blob.storageKey).catch((e: unknown) => {
        // Deliberately not fatal: the record is already gone, and an orphaned
        // object costs storage, not correctness.
        this.logger.warn(`Left an orphaned object ${blob.storageKey}: ${String(e)}`);
      });
    }
  }

  /** Bind a credential (UID/QR), revoking any prior active of the same kind. */
  async bindCredential(user: AuthUser, id: string, dto: BindCredentialDto) {
    const [worker] = await this.d1.db
      .select()
      .from(workers)
      .where(
        and(
          eq(workers.id, id),
          eq(workers.organizationId, user.organizationId),
          isNull(workers.deletedAt),
        ),
      )
      .limit(1);
    if (!worker) throw Errors.workerNotFound();

    const now = new Date();
    // Revoke, issue and point the worker at the new value together. Half of
    // this — the old card revoked, the new one not yet issued — is a person
    // who cannot get through the gate.
    await this.d1.db.batch([
      this.d1.db
        .update(workerCredentials)
        .set({ isActive: false, revokedAt: now, reason: dto.reason ?? 'reissued' })
        .where(
          and(
            eq(workerCredentials.workerId, id),
            eq(workerCredentials.kind, dto.kind),
            eq(workerCredentials.isActive, true),
          ),
        ),
      this.d1.db.insert(workerCredentials).values({
        id: randomUUID(),
        workerId: id,
        kind: dto.kind,
        value: dto.value,
        isActive: true,
        issuedAt: now,
      }),
      this.d1.db
        .update(workers)
        .set(
          dto.kind === 'NFC_UID'
            ? { nfcUid: dto.value, updatedAt: now }
            : { qrIdentifier: dto.value, updatedAt: now },
        )
        .where(eq(workers.id, id)),
    ] as never);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'WORKER_CREDENTIAL_BIND',
      entityType: 'Worker',
      entityId: id,
      newValue: { kind: dto.kind },
      reason: dto.reason,
    });
    return this.get(user, id);
  }

  async assignSite(user: AuthUser, id: string, dto: AssignSiteDto) {
    const [worker] = await this.d1.db
      .select()
      .from(workers)
      .where(
        and(
          eq(workers.id, id),
          eq(workers.organizationId, user.organizationId),
          isNull(workers.deletedAt),
        ),
      )
      .limit(1);
    if (!worker) throw Errors.workerNotFound();

    const start = dateOnly(dto.startDate) as string;
    const now = new Date();
    // Closing the old assignment and opening the new one belong together: a
    // worker with two open assignments is on two sites at once, and one with
    // none has no project on their card.
    const writes: unknown[] = [
      this.d1.db
        .update(workerSiteAssignments)
        .set({ endDate: start })
        .where(
          and(eq(workerSiteAssignments.workerId, id), isNull(workerSiteAssignments.endDate)),
        ),
      this.d1.db.insert(workerSiteAssignments).values({
        id: randomUUID(),
        workerId: id,
        siteId: dto.siteId,
        vendorId: dto.vendorId ?? null,
        startDate: start,
        isPrimary: true,
        createdAt: now,
      }),
    ];
    if (dto.vendorId) {
      writes.push(
        this.d1.db
          .update(workers)
          .set({ vendorId: dto.vendorId, updatedAt: now })
          .where(eq(workers.id, id)),
      );
    }
    await this.d1.db.batch(writes as never);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'WORKER_ASSIGN_SITE',
      entityType: 'Worker',
      entityId: id,
      newValue: { siteId: dto.siteId, vendorId: dto.vendorId },
    });
    return this.get(user, id);
  }

  async exit(user: AuthUser, id: string, dto: ExitWorkerDto) {
    const [worker] = await this.d1.db
      .select()
      .from(workers)
      .where(
        and(
          eq(workers.id, id),
          eq(workers.organizationId, user.organizationId),
          isNull(workers.deletedAt),
        ),
      )
      .limit(1);
    if (!worker) throw Errors.workerNotFound();

    const exitDate = dateOnly(dto.exitDate) as string;
    await this.d1.db.batch([
      this.d1.db
        .update(workers)
        .set({ status: 'EXITED', exitDate, updatedAt: new Date() })
        .where(eq(workers.id, id)),
      this.d1.db
        .update(workerSiteAssignments)
        .set({ endDate: exitDate })
        .where(
          and(eq(workerSiteAssignments.workerId, id), isNull(workerSiteAssignments.endDate)),
        ),
    ] as never);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'WORKER_EXIT',
      entityType: 'Worker',
      entityId: id,
      newValue: { exitDate: dto.exitDate },
      reason: dto.reason,
    });
    return this.get(user, id);
  }

  async rehire(user: AuthUser, id: string, dto: RehireWorkerDto) {
    // No deletedAt filter here, on purpose: rehiring is how a deleted worker
    // comes back, so this is the one lookup that has to see them.
    const [worker] = await this.d1.db
      .select()
      .from(workers)
      .where(and(eq(workers.id, id), eq(workers.organizationId, user.organizationId)))
      .limit(1);
    if (!worker) throw Errors.workerNotFound();

    const joinDate = dateOnly(dto.joinDate) as string;
    const now = new Date();
    await this.d1.db.batch([
      this.d1.db
        .update(workers)
        .set({
          status: 'ACTIVE',
          exitDate: null,
          deletedAt: null,
          joinDate,
          vendorId: dto.vendorId ?? worker.vendorId,
          updatedAt: now,
        })
        .where(eq(workers.id, id)),
      this.d1.db.insert(workerSiteAssignments).values({
        id: randomUUID(),
        workerId: id,
        siteId: dto.siteId,
        vendorId: dto.vendorId ?? null,
        startDate: joinDate,
        isPrimary: true,
        createdAt: now,
      }),
    ] as never);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'WORKER_REHIRE',
      entityType: 'Worker',
      entityId: id,
      newValue: { joinDate: dto.joinDate, siteId: dto.siteId },
    });
    return this.get(user, id);
  }

  // ---- Lookup / search / emergency ----------------------------------------
  async lookup(user: AuthUser, by: { uid?: string; qr?: string; code?: string }) {
    if (!by.uid && !by.qr && !by.code) {
      throw Errors.validation({ message: 'Provide one of uid, qr or code' });
    }
    const filters: SQL[] = [
      eq(workers.organizationId, user.organizationId),
      isNull(workers.deletedAt),
    ];
    if (by.uid) filters.push(eq(workers.nfcUid, by.uid));
    if (by.qr) filters.push(eq(workers.qrIdentifier, by.qr));
    if (by.code) filters.push(eq(workers.workerCode, by.code));

    const [row] = await this.d1.db
      .select({ worker: workers, vendorName: vendors.name, designationName: designations.name })
      .from(workers)
      .leftJoin(vendors, eq(vendors.id, workers.vendorId))
      .leftJoin(designations, eq(designations.id, workers.designationId))
      .where(and(...filters))
      .limit(1);
    const worker = row
      ? {
          ...row.worker,
          vendor: row.vendorName ? { name: row.vendorName } : null,
          designation: row.designationName ? { name: row.designationName } : null,
        }
      : null;
    if (!worker) throw Errors.workerNotFound();
    return this.limitedCard(worker);
  }

  /**
   * Limited worker list for a site, accessible to WATCHMAN/SUPERVISOR so the
   * device can warm its offline cache. Includes nfcUid/qrIdentifier (not PII)
   * for local tap resolution; excludes Aadhaar/PF/ESI.
   */
  async listBySite(user: AuthUser, siteId: string) {
    if (!siteId) throw Errors.validation({ message: 'siteId is required' });
    const rows = await this.d1.db
      .select({
        id: workers.id,
        workerCode: workers.workerCode,
        fullName: workers.fullName,
        photoUrl: workers.photoUrl,
        bloodGroup: workers.bloodGroup,
        emergencyContactName: workers.emergencyContactName,
        emergencyContactNumber: workers.emergencyContactNumber,
        nfcUid: workers.nfcUid,
        qrIdentifier: workers.qrIdentifier,
        category: workers.category,
        // The device refuses a login on an expired card while offline, so it
        // needs the expiry date in its cache.
        validityTill: workers.validityTill,
        vendorName: vendors.name,
        designationName: designations.name,
      })
      .from(workers)
      .leftJoin(vendors, eq(vendors.id, workers.vendorId))
      .leftJoin(designations, eq(designations.id, workers.designationId))
      .where(
        and(
          eq(workers.organizationId, user.organizationId),
          isNull(workers.deletedAt),
          eq(workers.status, 'ACTIVE'),
          sql`EXISTS (SELECT 1 FROM worker_site_assignments a
                       WHERE a.worker_id = ${workers.id}
                         AND a.site_id = ${siteId} AND a.end_date IS NULL)`,
        ),
      )
      .limit(1000);
    return { data: rows };
  }

  /**
   * Workers/staff created or last updated by the calling user today (org-local
   * day) — powers the safety officer's "bulk print today's badges".
   */
  async myRecent(user: AuthUser) {
    const [org] = await this.d1.db
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, user.organizationId))
      .limit(1);
    const startOfDay = DateTime.now()
      .setZone(org?.timezone ?? 'Asia/Kolkata')
      .startOf('day')
      .toJSDate();

    const rows = await this.d1.db
      .select({
        id: workers.id,
        workerCode: workers.workerCode,
        fullName: workers.fullName,
        photoUrl: workers.photoUrl,
        bloodGroup: workers.bloodGroup,
        emergencyContactName: workers.emergencyContactName,
        emergencyContactNumber: workers.emergencyContactNumber,
        category: workers.category,
        createdAt: workers.createdAt,
        vendorName: vendors.name,
        designationName: designations.name,
      })
      .from(workers)
      .leftJoin(vendors, eq(vendors.id, workers.vendorId))
      .leftJoin(designations, eq(designations.id, workers.designationId))
      .where(
        and(
          eq(workers.organizationId, user.organizationId),
          isNull(workers.deletedAt),
          gte(workers.updatedAt, startOfDay),
          sql`(${workers.createdById} = ${user.userId} OR ${workers.updatedById} = ${user.userId})`,
        ),
      )
      .orderBy(desc(workers.createdAt))
      .limit(500);

    const siteNames = await this.currentSiteNames(rows.map((r) => r.id));
    return {
      data: rows.map((r) => ({ ...r, siteName: siteNames.get(r.id) ?? null })),
    };
  }

  async search(user: AuthUser, q: string) {
    if (!q || q.length < 2) throw Errors.validation({ message: 'q must be at least 2 chars' });
    const term = `%${q.toLowerCase()}%`;
    const rows = await this.d1.db
      .select({ worker: workers, vendorName: vendors.name, designationName: designations.name })
      .from(workers)
      .leftJoin(vendors, eq(vendors.id, workers.vendorId))
      .leftJoin(designations, eq(designations.id, workers.designationId))
      .where(
        and(
          eq(workers.organizationId, user.organizationId),
          isNull(workers.deletedAt),
          sql`(lower(${workers.fullName}) LIKE ${term}
               OR lower(${workers.workerCode}) LIKE ${term}
               OR ${workers.mobileNumber} LIKE ${`%${q}%`})`,
        ),
      )
      .limit(25);
    return rows.map((r) =>
      this.limitedCard({
        ...r.worker,
        vendor: r.vendorName ? { name: r.vendorName } : null,
        designation: r.designationName ? { name: r.designationName } : null,
      }),
    );
  }

  async emergency(user: AuthUser, id: string) {
    const [worker] = await this.d1.db
      .select({
        id: workers.id,
        fullName: workers.fullName,
        bloodGroup: workers.bloodGroup,
        emergencyContactName: workers.emergencyContactName,
        emergencyContactNumber: workers.emergencyContactNumber,
      })
      .from(workers)
      .where(and(eq(workers.id, id), eq(workers.organizationId, user.organizationId)))
      .limit(1);
    if (!worker) throw Errors.workerNotFound();
    return worker;
  }
}
