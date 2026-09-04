import { Injectable, Logger } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { DateTime } from 'luxon';
import { PrismaService } from '../../infra/prisma/prisma.service';
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
    private readonly prisma: PrismaService,
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

  /** Total bytes consumed by the Postgres database (works on any host). */
  async usedBytes(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ size: bigint }[]>`
      SELECT pg_database_size(current_database()) AS size`;
    return Number(rows[0]?.size ?? 0);
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
    const sites = await this.prisma.site.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, code: true, isActive: true, createdAt: true },
    });

    const out: SiteUsage[] = [];
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      const [imageBytes, sessionCount, tapCount] = await Promise.all([
        this.siteImageBytes(organizationId, s.id),
        this.prisma.attendanceSession.count({ where: { organizationId, siteId: s.id } }),
        this.prisma.attendanceTap.count({ where: { organizationId, siteId: s.id } }),
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

  /**
   * Blob ids of images owned by workers assigned EXCLUSIVELY to this site
   * (so deleting them never strips a photo from a worker still on another site).
   */
  private async exclusiveSiteBlobIds(organizationId: string, siteId: string): Promise<string[]> {
    const workers = await this.prisma.worker.findMany({
      where: { organizationId, assignments: { some: { siteId } } },
      select: {
        photoUrl: true,
        aadhaarFrontPhotoId: true,
        aadhaarBackPhotoId: true,
        assignments: { select: { siteId: true } },
      },
    });
    const ids = new Set<string>();
    for (const w of workers) {
      const exclusive = w.assignments.every((a) => a.siteId === siteId);
      if (!exclusive) continue;
      if (w.photoUrl?.startsWith('/files/')) ids.add(w.photoUrl.slice('/files/'.length));
      if (w.aadhaarFrontPhotoId) ids.add(w.aadhaarFrontPhotoId);
      if (w.aadhaarBackPhotoId) ids.add(w.aadhaarBackPhotoId);
    }
    return [...ids];
  }

  private async siteImageBytes(organizationId: string, siteId: string): Promise<number> {
    const ids = await this.exclusiveSiteBlobIds(organizationId, siteId);
    if (ids.length === 0) return 0;
    const agg = await this.prisma.photoBlob.aggregate({
      where: { organizationId, id: { in: ids } },
      _sum: { sizeBytes: true },
    });
    return agg._sum.sizeBytes ?? 0;
  }

  // ---- Backup -------------------------------------------------------------

  /**
   * Multi-sheet XLSX backup of a site's data (workers with decrypted sensitive
   * fields, attendance, vendors). SUPER_ADMIN only. Records that a backup was
   * taken so the matching purge is permitted.
   */
  async backup(user: AuthUser, siteId: string): Promise<{ filename: string; buffer: Buffer }> {
    if (user.role !== 'SUPER_ADMIN') throw Errors.forbidden('Super admin only');
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, organizationId: user.organizationId },
    });
    if (!site) throw Errors.notFound('Site');

    const workers = await this.prisma.worker.findMany({
      where: { organizationId: user.organizationId, assignments: { some: { siteId } } },
      include: { vendor: { select: { name: true } }, designation: { select: { name: true } } },
    });
    const sessions = await this.prisma.attendanceSession.findMany({
      where: { organizationId: user.organizationId, siteId },
      include: { worker: { select: { fullName: true, workerCode: true } } },
      orderBy: { loginAt: 'asc' },
      take: 50_000,
    });
    const vendors = await this.prisma.vendor.findMany({
      where: { organizationId: user.organizationId },
    });

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
    for (const w of workers) {
      ws.addRow({
        code: w.workerCode,
        name: w.fullName,
        father: w.fatherName ?? '',
        cat: w.category,
        desig: w.designation?.name ?? '',
        vendor: w.vendor?.name ?? '',
        mobile: w.mobileNumber ?? '',
        dob: w.dateOfBirth ? DateTime.fromJSDate(w.dateOfBirth).toFormat('yyyy-LL-dd') : '',
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
        join: w.joinDate ? DateTime.fromJSDate(w.joinDate).toFormat('yyyy-LL-dd') : '',
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
        date: DateTime.fromJSDate(s.workDate).toFormat('yyyy-LL-dd'),
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
    for (const v of vendors) vs.addRow({ name: v.name, code: (v as { code?: string }).code ?? '' });
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
      newValue: { workers: workers.length, sessions: sessions.length },
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
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, organizationId: user.organizationId },
    });
    if (!site) throw Errors.notFound('Site');

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
    const storageKeys = blobIds.length
      ? (
          await this.prisma.photoBlob.findMany({
            where: { organizationId: user.organizationId, id: { in: blobIds } },
            select: { storageKey: true },
          })
        )
          .map((b) => b.storageKey)
          .filter((k): k is string => Boolean(k))
      : [];
    const before = await this.usedBytes();

    const [taps, sessions, blobs] = await this.prisma.$transaction([
      this.prisma.attendanceTap.deleteMany({
        where: { organizationId: user.organizationId, siteId },
      }),
      this.prisma.attendanceSession.deleteMany({
        where: { organizationId: user.organizationId, siteId },
      }),
      blobIds.length
        ? this.prisma.photoBlob.deleteMany({
            where: { organizationId: user.organizationId, id: { in: blobIds } },
          })
        : this.prisma.photoBlob.deleteMany({
            where: { id: '00000000-0000-0000-0000-000000000000' },
          }),
    ]);

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
      await this.prisma.worker.updateMany({
        where: { organizationId: user.organizationId, photoUrl: { in: urls } },
        data: { photoUrl: null },
      });
      await this.prisma.worker.updateMany({
        where: { organizationId: user.organizationId, aadhaarFrontPhotoId: { in: blobIds } },
        data: { aadhaarFrontPhotoId: null },
      });
      await this.prisma.worker.updateMany({
        where: { organizationId: user.organizationId, aadhaarBackPhotoId: { in: blobIds } },
        data: { aadhaarBackPhotoId: null },
      });
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
