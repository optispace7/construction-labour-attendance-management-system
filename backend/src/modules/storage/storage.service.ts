import { Injectable, Logger } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { DateTime } from 'luxon';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { D1Service } from '../../infra/d1/d1.service';
import { chunked, chunkedWrite } from '../../infra/d1/chunked';
import {
  attendanceSessions,
  attendanceTaps,
  designations,
  photoBlobs,
  sites,
  vendors,
  workerSiteAssignments,
  workers,
} from '../../infra/d1/schema.generated';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { blobStore } from '../files/blob-store';

export const STORAGE_WARN_PCT = 0.8;
export const STORAGE_CRITICAL_PCT = 0.9;

// Rough per-row estimates for attendance data (the dominant freeable cost is
// images, which we size exactly; these only colour the attendance portion).
const SESSION_BYTES = 512;
const TAP_BYTES = 400;

// A backup must have been generated within this window before a purge is
// allowed (enforced server-side so the API can't be used to skip the backup).
const BACKUP_VALID_MS = 30 * 60 * 1000;

export interface SiteUsage {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  createdAt: Date;
  isOldest: boolean;
  imageBytes: number; // exact, from PhotoBlob.sizeBytes (exclusive-site workers)
  attendanceBytesEstimate: number;
  freeableBytesEstimate: number;
  sessionCount: number;
  tapCount: number;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  /** siteId -> last backup timestamp (ms). In-memory; gates purge. */
  private readonly backups = new Map<string, number>();

  constructor(
    private readonly d1: D1Service,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  /** Host-agnostic capacity cap (bytes). Null when unconfigured. */
  limitBytes(): number | null {
    const raw = process.env.DB_STORAGE_LIMIT_BYTES;
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Total bytes the database occupies.
   *
   * pg_database_size() has no equivalent on D1, but it does not need one: D1
   * reports the database's size on the metadata of every query it answers, so
   * the cheapest query there is carries the figure back.
   *
   * The PRAGMA fallback is for a D1 that stops reporting it, and for the
   * SQLite the tests run against — page_count times page_size is the same
   * number by a different route.
   */
  async usedBytes(): Promise<number> {
    const probe = (await this.d1.d1.prepare('SELECT 1').all()) as unknown as {
      meta?: { size_after?: number };
    };
    const reported = probe?.meta?.size_after;
    if (typeof reported === 'number' && reported > 0) return reported;

    const [pages, pageSize] = await Promise.all([
      this.d1.d1.prepare('PRAGMA page_count').first<{ page_count: number }>(),
      this.d1.d1.prepare('PRAGMA page_size').first<{ page_size: number }>(),
    ]);
    return Number(pages?.page_count ?? 0) * Number(pageSize?.page_size ?? 0);
  }

  async usage(user: AuthUser) {
    const [used, sites] = await Promise.all([
      this.usedBytes(),
      this.siteUsage(user.organizationId),
    ]);
    const limit = this.limitBytes();
    const usedPercent = limit ? used / limit : null;
    return {
      usedBytes: used,
      limitBytes: limit,
      usedPercent,
      warnPercent: STORAGE_WARN_PCT,
      criticalPercent: STORAGE_CRITICAL_PCT,
      level:
        usedPercent === null
          ? 'UNKNOWN'
          : usedPercent >= STORAGE_CRITICAL_PCT
            ? 'CRITICAL'
            : usedPercent >= STORAGE_WARN_PCT
              ? 'WARNING'
              : 'OK',
      oldestSiteId: sites[0]?.id ?? null,
      sites,
    };
  }

  /** Per-site freeable-space breakdown, oldest site first. */
  async siteUsage(organizationId: string): Promise<SiteUsage[]> {
    const siteRows = await this.d1.db
      .select({
        id: sites.id,
        name: sites.name,
        code: sites.code,
        isActive: sites.isActive,
        createdAt: sites.createdAt,
      })
      .from(sites)
      .where(eq(sites.organizationId, organizationId))
      .orderBy(asc(sites.createdAt));

    const out: SiteUsage[] = [];
    for (let i = 0; i < siteRows.length; i++) {
      const s = siteRows[i];
      const [imageBytes, sessionCount, tapCount] = await Promise.all([
        this.siteImageBytes(organizationId, s.id),
        this.countRows(attendanceSessions, organizationId, s.id),
        this.countRows(attendanceTaps, organizationId, s.id),
      ]);
      const attendanceBytesEstimate = sessionCount * SESSION_BYTES + tapCount * TAP_BYTES;
      out.push({
        id: s.id,
        name: s.name,
        code: s.code,
        isActive: s.isActive,
        createdAt: s.createdAt,
        isOldest: i === 0,
        imageBytes,
        attendanceBytesEstimate,
        freeableBytesEstimate: imageBytes + attendanceBytesEstimate,
        sessionCount,
        tapCount,
      });
    }
    return out;
  }

  /** How many rows one site holds in a table that carries org and site. */
  private async countRows(
    table: typeof attendanceSessions | typeof attendanceTaps,
    organizationId: string,
    siteId: string,
  ): Promise<number> {
    const [row] = await this.d1.db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(table)
      .where(and(eq(table.organizationId, organizationId), eq(table.siteId, siteId)));
    return Number(row?.count ?? 0);
  }

  /**
   * Blob ids of images owned by workers assigned EXCLUSIVELY to this site
   * (so deleting them never strips a photo from a worker still on another site).
   */
  private async exclusiveSiteBlobIds(organizationId: string, siteId: string): Promise<string[]> {
    // Everyone on this site, with a count of the sites they are on. A worker
    // whose only assignment is this one owns their photos exclusively; anyone
    // else keeps theirs, which is the whole point of the check.
    const people = await this.d1.db
      .select({
        photoUrl: workers.photoUrl,
        aadhaarFrontPhotoId: workers.aadhaarFrontPhotoId,
        aadhaarBackPhotoId: workers.aadhaarBackPhotoId,
        siteCount: sql<number>`(
          select count(distinct wsa2.site_id) from worker_site_assignments wsa2
           where wsa2.worker_id = ${workers.id}
        )`.as('siteCount'),
      })
      .from(workers)
      .innerJoin(workerSiteAssignments, eq(workerSiteAssignments.workerId, workers.id))
      .where(
        and(eq(workers.organizationId, organizationId), eq(workerSiteAssignments.siteId, siteId)),
      );

    const ids = new Set<string>();
    for (const w of people) {
      if (Number(w.siteCount) !== 1) continue;
      if (w.photoUrl?.startsWith('/files/')) ids.add(w.photoUrl.slice('/files/'.length));
      if (w.aadhaarFrontPhotoId) ids.add(w.aadhaarFrontPhotoId);
      if (w.aadhaarBackPhotoId) ids.add(w.aadhaarBackPhotoId);
    }
    return [...ids];
  }

  private async siteImageBytes(organizationId: string, siteId: string): Promise<number> {
    const ids = await this.exclusiveSiteBlobIds(organizationId, siteId);
    if (ids.length === 0) return 0;
    const sums = await chunked(ids, (batch) =>
      this.d1.db
        .select({ total: sql<number>`coalesce(sum(${photoBlobs.sizeBytes}), 0)`.as('total') })
        .from(photoBlobs)
        .where(and(eq(photoBlobs.organizationId, organizationId), inArray(photoBlobs.id, batch))),
    );
    return sums.reduce((n, r) => n + Number(r.total ?? 0), 0);
  }

  /** One of this organization's sites, or a 404. */
  private async ownSite(organizationId: string, siteId: string) {
    const [site] = await this.d1.db
      .select()
      .from(sites)
      .where(and(eq(sites.id, siteId), eq(sites.organizationId, organizationId)))
      .limit(1);
    if (!site) throw Errors.notFound('Site');
    return site;
  }

  // ---- Backup -------------------------------------------------------------

  /**
   * Multi-sheet XLSX backup of a site's data (workers with decrypted sensitive
   * fields, attendance, vendors). SUPER_ADMIN only. Records that a backup was
   * taken so the matching purge is permitted.
   */
  async backup(user: AuthUser, siteId: string): Promise<{ filename: string; buffer: Buffer }> {
    if (user.role !== 'SUPER_ADMIN') throw Errors.forbidden('Super admin only');
    const site = await this.ownSite(user.organizationId, siteId);

    const workerRows = await this.d1.db
      .select({ worker: workers, vendorName: vendors.name, designationName: designations.name })
      .from(workers)
      // Joined through the assignment rather than filtered by a list of ids:
      // the roll of a real site is hundreds of people, and D1 binds at most a
      // hundred parameters.
      .innerJoin(workerSiteAssignments, eq(workerSiteAssignments.workerId, workers.id))
      .leftJoin(vendors, eq(vendors.id, workers.vendorId))
      .leftJoin(designations, eq(designations.id, workers.designationId))
      .where(
        and(
          eq(workers.organizationId, user.organizationId),
          eq(workerSiteAssignments.siteId, siteId),
        ),
      );
    const workerList = workerRows.map((r) => ({
      ...r.worker,
      vendor: r.vendorName ? { name: r.vendorName } : null,
      designation: r.designationName ? { name: r.designationName } : null,
    }));

    const sessionRows = await this.d1.db
      .select({
        session: attendanceSessions,
        workerFullName: workers.fullName,
        workerCode: workers.workerCode,
      })
      .from(attendanceSessions)
      .innerJoin(workers, eq(workers.id, attendanceSessions.workerId))
      .where(
        and(
          eq(attendanceSessions.organizationId, user.organizationId),
          eq(attendanceSessions.siteId, siteId),
        ),
      )
      .orderBy(asc(attendanceSessions.loginAt))
      .limit(50_000);
    const sessions = sessionRows.map((r) => ({
      ...r.session,
      worker: { fullName: r.workerFullName, workerCode: r.workerCode },
    }));

    const vendorList = await this.d1.db
      .select()
      .from(vendors)
      .where(eq(vendors.organizationId, user.organizationId));

    const wb = new Workbook();
    wb.creator = 'CLAMS';

    const ws = wb.addWorksheet('Workers');
    ws.columns = [
      { header: 'Worker Code', key: 'code', width: 14 },
      { header: 'Full Name', key: 'name', width: 24 },
      { header: "Father's Name", key: 'father', width: 22 },
      { header: 'Category', key: 'cat', width: 10 },
      { header: 'Designation', key: 'desig', width: 18 },
      { header: 'Vendor', key: 'vendor', width: 18 },
      { header: 'Mobile', key: 'mobile', width: 14 },
      { header: 'DOB', key: 'dob', width: 12 },
      { header: 'Gender', key: 'gender', width: 8 },
      { header: 'Blood Group', key: 'blood', width: 10 },
      { header: 'Aadhaar', key: 'aadhaar', width: 16 },
      { header: 'PAN', key: 'pan', width: 12 },
      { header: 'Bank Name', key: 'bankName', width: 16 },
      { header: 'Bank Account', key: 'bankAcct', width: 18 },
      { header: 'IFSC', key: 'ifsc', width: 12 },
      { header: 'PF No', key: 'pf', width: 14 },
      { header: 'ESI No', key: 'esi', width: 14 },
      { header: 'Emergency Contact', key: 'emgName', width: 20 },
      { header: 'Emergency Number', key: 'emgNum', width: 16 },
      { header: 'Join Date', key: 'join', width: 12 },
      { header: 'Status', key: 'status', width: 10 },
    ];
    for (const w of workerList) {
      ws.addRow({
        code: w.workerCode,
        name: w.fullName,
        father: w.fatherName ?? '',
        cat: w.category,
        desig: w.designation?.name ?? '',
        vendor: w.vendor?.name ?? '',
        mobile: w.mobileNumber ?? '',
        dob: w.dateOfBirth ?? '',
        gender: w.gender ?? '',
        blood: w.bloodGroup ?? '',
        aadhaar: this.safeDecrypt(w.aadhaarCiphertext),
        pan: this.safeDecrypt(w.panCiphertext),
        bankName: w.bankName ?? '',
        bankAcct: this.safeDecrypt(w.bankAccountCiphertext) || (w.bankAccountNumber ?? ''),
        ifsc: w.ifscCode ?? '',
        pf: w.pfNumber ?? '',
        esi: w.esiNumber ?? '',
        emgName: w.emergencyContactName ?? '',
        emgNum: w.emergencyContactNumber ?? '',
        join: w.joinDate ?? '',
        status: w.status,
      });
    }
    ws.getRow(1).font = { bold: true };

    const as = wb.addWorksheet('Attendance');
    as.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Worker Code', key: 'code', width: 14 },
      { header: 'Worker', key: 'name', width: 24 },
      { header: 'Login', key: 'in', width: 20 },
      { header: 'Logout', key: 'out', width: 20 },
      { header: 'Worked (min)', key: 'worked', width: 12 },
      { header: 'Overtime (min)', key: 'ot', width: 12 },
      { header: 'State', key: 'state', width: 12 },
    ];
    for (const s of sessions) {
      as.addRow({
        // Already 'YYYY-MM-DD' — a calendar day, stored as text.
        date: s.workDate,
        code: s.worker.workerCode,
        name: s.worker.fullName,
        in: s.loginAt ? DateTime.fromJSDate(s.loginAt).toFormat('yyyy-LL-dd HH:mm') : '',
        out: s.logoutAt ? DateTime.fromJSDate(s.logoutAt).toFormat('yyyy-LL-dd HH:mm') : '',
        worked: s.workedMinutes ?? '',
        ot: s.overtimeMinutes ?? '',
        state: s.state,
      });
    }
    as.getRow(1).font = { bold: true };

    const vs = wb.addWorksheet('Vendors');
    vs.columns = [
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Code', key: 'code', width: 14 },
    ];
    for (const v of vendorList) vs.addRow({ name: v.name, code: (v as { code?: string }).code ?? '' });
    vs.getRow(1).font = { bold: true };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    this.backups.set(siteId, Date.now());

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'SITE_DATA_BACKUP',
      entityType: 'Site',
      entityId: siteId,
      newValue: { workers: workerList.length, sessions: sessions.length },
    });

    const stamp = DateTime.now().toFormat('yyyyLLdd-HHmm');
    const safeName = site.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    return { filename: `clams-backup-${safeName}-${stamp}.xlsx`, buffer };
  }

  private safeDecrypt(blob: Uint8Array | null): string {
    if (!blob) return '';
    try {
      return this.crypto.decrypt(Buffer.from(blob));
    } catch {
      return '';
    }
  }

  // ---- Purge --------------------------------------------------------------

  /**
   * Deletes a site's attendance (sessions + taps) and the images of workers
   * assigned exclusively to it. Worker master records are kept. Requires a
   * fresh backup (see {@link backup}) and SUPER_ADMIN.
   */
  async purge(user: AuthUser, siteId: string) {
    if (user.role !== 'SUPER_ADMIN') throw Errors.forbidden('Super admin only');
    const site = await this.ownSite(user.organizationId, siteId);

    const backedUpAt = this.backups.get(siteId);
    if (!backedUpAt || Date.now() - backedUpAt > BACKUP_VALID_MS) {
      throw Errors.validation({
        message: 'Download the Excel backup first (within 30 minutes) before clearing this site.',
      });
    }

    const blobIds = await this.exclusiveSiteBlobIds(user.organizationId, siteId);
    // Read the object keys before the rows are deleted — afterwards there is
    // nothing left to say where the images were, and they would sit in the
    // bucket for ever, still holding this site's Aadhaar photos.
    const storageKeys = (
      await chunked(blobIds, (batch) =>
        this.d1.db
          .select({ storageKey: photoBlobs.storageKey })
          .from(photoBlobs)
          .where(
            and(
              eq(photoBlobs.organizationId, user.organizationId),
              inArray(photoBlobs.id, batch),
            ),
          ),
      )
    )
      .map((b) => b.storageKey)
      .filter((k): k is string => Boolean(k));
    const before = await this.usedBytes();

    // The taps and the sessions go together, as they did in the transaction:
    // a site left with taps but no sessions, or the reverse, is a half-purged
    // site nobody could reason about.
    const results = (await this.d1.db.batch([
      this.d1.db
        .delete(attendanceTaps)
        .where(
          and(
            eq(attendanceTaps.organizationId, user.organizationId),
            eq(attendanceTaps.siteId, siteId),
          ),
        ),
      this.d1.db
        .delete(attendanceSessions)
        .where(
          and(
            eq(attendanceSessions.organizationId, user.organizationId),
            eq(attendanceSessions.siteId, siteId),
          ),
        ),
    ] as never)) as unknown as { meta?: { changes?: number } }[];
    const taps = { count: results[0]?.meta?.changes ?? 0 };
    const sessions = { count: results[1]?.meta?.changes ?? 0 };

    // The blobs are their own chunked pass: the id list is as long as the
    // site's roll, and one batch cannot carry it.
    let blobCount = 0;
    await chunkedWrite(blobIds, async (batch) => {
      const r = (await this.d1.db
        .delete(photoBlobs)
        .where(
          and(
            eq(photoBlobs.organizationId, user.organizationId),
            inArray(photoBlobs.id, batch),
          ),
        )) as unknown as { meta?: { changes?: number } };
      blobCount += r?.meta?.changes ?? 0;
    });
    const blobs = { count: blobCount };

    // The rows are gone; now the objects. Failures here are logged rather than
    // raised: the purge has already happened and its audit entry is about to be
    // written, so aborting now would misreport what actually took place. What
    // is left behind is storage, not data.
    for (const key of storageKeys) {
      await blobStore.delete(key).catch((e: unknown) => {
        this.logger.warn(`Left an orphaned object ${key} after purge: ${String(e)}`);
      });
    }

    // Null out worker photo references whose blobs we just removed.
    if (blobIds.length) {
      const urls = blobIds.map((id) => `/files/${id}`);
      await chunkedWrite(urls, (batch) =>
        this.d1.db
          .update(workers)
          .set({ photoUrl: null })
          .where(
            and(
              eq(workers.organizationId, user.organizationId),
              inArray(workers.photoUrl, batch),
            ),
          ),
      );
      await chunkedWrite(blobIds, (batch) =>
        this.d1.db
          .update(workers)
          .set({ aadhaarFrontPhotoId: null })
          .where(
            and(
              eq(workers.organizationId, user.organizationId),
              inArray(workers.aadhaarFrontPhotoId, batch),
            ),
          ),
      );
      await chunkedWrite(blobIds, (batch) =>
        this.d1.db
          .update(workers)
          .set({ aadhaarBackPhotoId: null })
          .where(
            and(
              eq(workers.organizationId, user.organizationId),
              inArray(workers.aadhaarBackPhotoId, batch),
            ),
          ),
      );
    }

    this.backups.delete(siteId);
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'SITE_DATA_PURGE',
      entityType: 'Site',
      entityId: siteId,
      newValue: { taps: taps.count, sessions: sessions.count, images: blobs.count },
    });

    return {
      siteId,
      deletedTaps: taps.count,
      deletedSessions: sessions.count,
      deletedImages: blobs.count,
      // Postgres reclaims to free space lazily (VACUUM); report logical delta.
      usedBytesBefore: before,
    };
  }
}
