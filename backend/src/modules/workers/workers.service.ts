import { Injectable } from '@nestjs/common';
import { CredentialKind, PersonCategory, Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
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

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

@Injectable()
export class WorkersService {
  constructor(
    private readonly prisma: PrismaService,
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
    category?: PersonCategory;
    validityTill?: Date | null;
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
      validityTill: w.validityTill ? w.validityTill.toISOString().slice(0, 10) : null,
      vendorName: w.vendor?.name ?? null,
      designationName: w.designation?.name ?? null,
    };
  }

  /** Auto-generate a unique code: W-0001 (workers), S-0001 (staff), V-0001 (visitors). */
  private async generateWorkerCode(organizationId: string, category: PersonCategory) {
    const prefix = category === 'STAFF' ? 'S' : category === 'VISITOR' ? 'V' : 'W';
    const count = await this.prisma.worker.count({ where: { organizationId, category } });
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = `${prefix}-${String(count + 1 + attempt).padStart(4, '0')}`;
      const exists = await this.prisma.worker.findFirst({
        where: { organizationId, workerCode: code },
        select: { id: true },
      });
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
    const where: Prisma.WorkerWhereInput = {
      organizationId: user.organizationId,
      deletedAt: null,
      ...(opts.category ? { category: opts.category as PersonCategory } : {}),
      ...(opts.vendorId ? { vendorId: opts.vendorId } : {}),
      ...(opts.status ? { status: opts.status as Prisma.EnumWorkerStatusFilter['equals'] } : {}),
      ...(opts.siteId ? { assignments: { some: { siteId: opts.siteId, endDate: null } } } : {}),
      ...(opts.q
        ? {
            OR: [
              { fullName: { contains: opts.q, mode: 'insensitive' } },
              { workerCode: { contains: opts.q, mode: 'insensitive' } },
              { mobileNumber: { contains: opts.q } },
            ],
          }
        : {}),
    };

    // Stable sort orders (id tiebreaker keeps cursor pagination consistent).
    const orderBy: Prisma.WorkerOrderByWithRelationInput[] =
      opts.sortBy === 'designation'
        ? [{ designation: { name: 'asc' } }, { fullName: 'asc' }, { id: 'asc' }]
        : opts.sortBy === 'vendor'
          ? [{ vendor: { name: 'asc' } }, { fullName: 'asc' }, { id: 'asc' }]
          : opts.sortBy === 'name'
            ? [{ fullName: 'asc' }, { id: 'asc' }]
            : [{ createdAt: 'desc' }, { id: 'desc' }];

    const rows = await this.prisma.worker.findMany({
      where,
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      orderBy,
      select: {
        id: true,
        workerCode: true,
        fullName: true,
        fatherName: true,
        gender: true,
        dateOfBirth: true,
        photoUrl: true,
        mobileNumber: true,
        email: true,
        status: true,
        vendorId: true,
        vendor: { select: { name: true } },
        category: true,
        escortName: true,
        visitorCompany: true,
        idProofPhotoId: true,
        designationId: true,
        designation: { select: { name: true } },
        natureOfContractor: true,
        pfNumber: true,
        esiNumber: true,
        govIdType: true,
        aadhaarLast4: true,
        panLast4: true,
        bloodGroup: true,
        emergencyContactName: true,
        emergencyContactNumber: true,
        screeningDoneOn: true,
        screeningDoneBy: true,
        inductionDoneOn: true,
        inductedBy: true,
        validityTill: true,
        // Current site assignment supplies the "Project Name" line on the ID card.
        assignments: {
          where: { endDate: null },
          take: 1,
          orderBy: { startDate: 'desc' },
          select: { site: { select: { name: true } } },
        },
      },
    });
    const nextCursor = rows.length > limit ? rows[limit].id : null;
    return { data: rows.slice(0, limit), nextCursor };
  }

  /** Full profile. Aadhaar is decrypted only when reveal=true and is audited. */
  async get(user: AuthUser, id: string, reveal = false) {
    const worker = await this.prisma.worker.findFirst({
      where: { id, organizationId: user.organizationId, deletedAt: null },
      include: {
        vendor: true,
        designation: true,
        assignments: { where: { endDate: null }, include: { site: true } },
        credentials: { where: { isActive: true } },
      },
    });
    if (!worker) throw Errors.workerNotFound();

    let aadhaar: string | undefined;
    let pan: string | undefined;
    let bankAccount: string | undefined;
    if (
      reveal &&
      (worker.aadhaarCiphertext || worker.panCiphertext || worker.bankAccountCiphertext)
    ) {
      if (worker.aadhaarCiphertext) {
        aadhaar = this.crypto.decrypt(Buffer.from(worker.aadhaarCiphertext));
      }
      if (worker.panCiphertext) {
        pan = this.crypto.decrypt(Buffer.from(worker.panCiphertext));
      }
      if (worker.bankAccountCiphertext) {
        bankAccount = this.crypto.decrypt(Buffer.from(worker.bankAccountCiphertext));
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
    const people = await this.prisma.worker.findMany({
      where: { id: { in: ids }, organizationId: user.organizationId, deletedAt: null },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        fullName: true,
        workerCode: true,
        photoUrl: true,
        aadhaarFrontPhotoId: true,
        aadhaarBackPhotoId: true,
        idProofPhotoId: true,
      },
    });
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
        const blob = await this.prisma.photoBlob.findFirst({
          where: { id: blobId, organizationId: user.organizationId },
        });
        // A dangling id is not worth failing the whole export over.
        if (!blob) continue;
        const data = blob.isEncrypted
          ? this.crypto.decryptBuffer(Buffer.from(blob.data))
          : Buffer.from(blob.data);
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
        const isUnique = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
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

    return this.prisma.$transaction(async (tx) => {
      const w = await tx.worker.create({
        data: {
          organizationId: user.organizationId,
          workerCode,
          category,
          designationId: dto.designationId || undefined,
          createdById: user.userId,
          updatedById: user.userId,
          fullName: dto.fullName,
          fatherName: dto.fatherName,
          gender: dto.gender,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
          language: dto.language,
          pincode: dto.pincode,
          mobileNumber: dto.mobileNumber,
          email: dto.email,
          bloodGroup: dto.bloodGroup,
          emergencyContactName: dto.emergencyContactName,
          emergencyContactNumber: dto.emergencyContactNumber,
          screeningDoneOn: dto.screeningDoneOn ? new Date(dto.screeningDoneOn) : undefined,
          screeningDoneBy: dto.screeningDoneBy,
          inductionDoneOn: dto.inductionDoneOn ? new Date(dto.inductionDoneOn) : undefined,
          inductedBy: dto.inductedBy,
          validityTill: dto.validityTill ? new Date(dto.validityTill) : undefined,
          nomineeName: dto.nomineeName,
          nomineeRelation: dto.nomineeRelation,
          vendorId: dto.vendorId,
          natureOfContractor: dto.natureOfContractor,
          bankName: dto.bankName,
          bankAccountCiphertext,
          bankAccountLast4,
          ifscCode: dto.ifscCode,
          pfNumber: dto.pfNumber,
          esiNumber: dto.esiNumber,
          govIdType: dto.govIdType,
          aadhaarCiphertext,
          aadhaarLast4,
          aadhaarFrontPhotoId: dto.aadhaarFrontPhotoId,
          aadhaarBackPhotoId: dto.aadhaarBackPhotoId,
          panCiphertext,
          panLast4,
          joinDate,
          escortName: dto.escortName,
          visitorCompany: dto.visitorCompany,
          idProofPhotoId: dto.idProofPhotoId,
          notes: dto.notes,
          nfcUid: dto.nfcUid,
          qrIdentifier: dto.qrIdentifier,
          photoUrl: dto.photoUrl,
        },
      });

      if (dto.nfcUid) {
        await tx.workerCredential.create({
          data: { workerId: w.id, kind: 'NFC_UID', value: dto.nfcUid },
        });
      }
      if (dto.qrIdentifier) {
        await tx.workerCredential.create({
          data: { workerId: w.id, kind: 'QR', value: dto.qrIdentifier },
        });
      }
      if (dto.siteId) {
        await tx.workerSiteAssignment.create({
          data: {
            workerId: w.id,
            siteId: dto.siteId,
            vendorId: dto.vendorId,
            startDate: joinDate ?? new Date(),
          },
        });
      }
      return w;
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateWorkerDto) {
    const before = await this.prisma.worker.findFirst({
      where: { id, organizationId: user.organizationId, deletedAt: null },
    });
    if (!before) throw Errors.workerNotFound();

    const data: Prisma.WorkerUpdateInput = {
      fullName: dto.fullName,
      fatherName: dto.fatherName,
      gender: dto.gender,
      dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
      // Correcting a mis-keyed joining date changes which days the attendance
      // sheet treats as "not employed", so the before/after is audited below.
      joinDate: dto.joinDate ? new Date(dto.joinDate) : undefined,
      language: dto.language,
      pincode: dto.pincode,
      mobileNumber: dto.mobileNumber,
      email: dto.email,
      bloodGroup: dto.bloodGroup,
      emergencyContactName: dto.emergencyContactName,
      emergencyContactNumber: dto.emergencyContactNumber,
      screeningDoneOn: dto.screeningDoneOn ? new Date(dto.screeningDoneOn) : undefined,
      screeningDoneBy: dto.screeningDoneBy,
      inductionDoneOn: dto.inductionDoneOn ? new Date(dto.inductionDoneOn) : undefined,
      inductedBy: dto.inductedBy,
      validityTill: dto.validityTill ? new Date(dto.validityTill) : undefined,
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
      ...(dto.vendorId ? { vendor: { connect: { id: dto.vendorId } } } : {}),
      ...(dto.designationId !== undefined
        ? dto.designationId
          ? { designation: { connect: { id: dto.designationId } } }
          : { designation: { disconnect: true } }
        : {}),
    };
    if (dto.aadhaar) {
      data.aadhaarCiphertext = this.crypto.encrypt(dto.aadhaar);
      data.aadhaarLast4 = dto.aadhaar.replace(/\s/g, '').slice(-4);
    }
    if (dto.pan) {
      const pan = dto.pan.replace(/\s/g, '').toUpperCase();
      data.panCiphertext = this.crypto.encrypt(pan);
      data.panLast4 = pan.slice(-4);
    }
    if (dto.bankAccountNumber !== undefined) {
      const bankAcct = dto.bankAccountNumber.replace(/\s/g, '');
      data.bankAccountCiphertext = bankAcct ? this.crypto.encrypt(bankAcct) : null;
      data.bankAccountLast4 = bankAcct ? bankAcct.slice(-4) : null;
    }

    await this.prisma.worker.update({ where: { id }, data });
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
        joinDate: before.joinDate?.toISOString().slice(0, 10) ?? null,
      },
      newValue: {
        fullName: dto.fullName ?? before.fullName,
        status: dto.status ?? before.status,
        joinDate: dto.joinDate ?? before.joinDate?.toISOString().slice(0, 10) ?? null,
      },
    });
    return this.get(user, id);
  }

  async softDelete(user: AuthUser, id: string) {
    const worker = await this.prisma.worker.findFirst({
      where: { id, organizationId: user.organizationId, deletedAt: null },
    });
    if (!worker) throw Errors.workerNotFound();

    await this.prisma.$transaction([
      // Free UID/QR from active-uniqueness and clear credentials.
      this.prisma.worker.update({
        where: { id },
        data: { deletedAt: new Date(), nfcUid: null, qrIdentifier: null, status: 'INACTIVE' },
      }),
      this.prisma.workerCredential.updateMany({
        where: { workerId: id, isActive: true },
        data: { isActive: false, revokedAt: new Date(), reason: 'worker deleted' },
      }),
    ]);

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
    const stillUsed = await this.prisma.worker.count({ where: { photoUrl: url } });
    if (stillUsed === 0) {
      await this.prisma.photoBlob
        .deleteMany({ where: { id: blobId, organizationId } })
        .catch(() => undefined);
    }
  }

  /** Deletes an Aadhaar image blob (referenced 1:1 by id, not URL). */
  private async deletePhotoBlobById(organizationId: string, blobId: string | null) {
    if (!blobId) return;
    await this.prisma.photoBlob
      .deleteMany({ where: { id: blobId, organizationId } })
      .catch(() => undefined);
  }

  /** Bind a credential (UID/QR), revoking any prior active of the same kind. */
  async bindCredential(user: AuthUser, id: string, dto: BindCredentialDto) {
    const worker = await this.prisma.worker.findFirst({
      where: { id, organizationId: user.organizationId, deletedAt: null },
    });
    if (!worker) throw Errors.workerNotFound();

    await this.prisma.$transaction(async (tx) => {
      await tx.workerCredential.updateMany({
        where: { workerId: id, kind: dto.kind, isActive: true },
        data: { isActive: false, revokedAt: new Date(), reason: dto.reason ?? 'reissued' },
      });
      await tx.workerCredential.create({
        data: { workerId: id, kind: dto.kind, value: dto.value },
      });
      await tx.worker.update({
        where: { id },
        data:
          dto.kind === CredentialKind.NFC_UID ? { nfcUid: dto.value } : { qrIdentifier: dto.value },
      });
    });

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
    const worker = await this.prisma.worker.findFirst({
      where: { id, organizationId: user.organizationId, deletedAt: null },
    });
    if (!worker) throw Errors.workerNotFound();

    await this.prisma.$transaction([
      // Close current primary assignment.
      this.prisma.workerSiteAssignment.updateMany({
        where: { workerId: id, endDate: null },
        data: { endDate: new Date(dto.startDate) },
      }),
      this.prisma.workerSiteAssignment.create({
        data: {
          workerId: id,
          siteId: dto.siteId,
          vendorId: dto.vendorId,
          startDate: new Date(dto.startDate),
        },
      }),
      ...(dto.vendorId
        ? [this.prisma.worker.update({ where: { id }, data: { vendorId: dto.vendorId } })]
        : []),
    ]);

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
    const worker = await this.prisma.worker.findFirst({
      where: { id, organizationId: user.organizationId, deletedAt: null },
    });
    if (!worker) throw Errors.workerNotFound();

    await this.prisma.$transaction([
      this.prisma.worker.update({
        where: { id },
        data: { status: 'EXITED', exitDate: new Date(dto.exitDate) },
      }),
      this.prisma.workerSiteAssignment.updateMany({
        where: { workerId: id, endDate: null },
        data: { endDate: new Date(dto.exitDate) },
      }),
    ]);

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
    const worker = await this.prisma.worker.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!worker) throw Errors.workerNotFound();

    await this.prisma.$transaction([
      this.prisma.worker.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          exitDate: null,
          deletedAt: null,
          joinDate: new Date(dto.joinDate),
          vendorId: dto.vendorId ?? worker.vendorId,
        },
      }),
      this.prisma.workerSiteAssignment.create({
        data: {
          workerId: id,
          siteId: dto.siteId,
          vendorId: dto.vendorId,
          startDate: new Date(dto.joinDate),
        },
      }),
    ]);

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
    const where: Prisma.WorkerWhereInput = {
      organizationId: user.organizationId,
      deletedAt: null,
      ...(by.uid ? { nfcUid: by.uid } : {}),
      ...(by.qr ? { qrIdentifier: by.qr } : {}),
      ...(by.code ? { workerCode: by.code } : {}),
    };
    if (!by.uid && !by.qr && !by.code) {
      throw Errors.validation({ message: 'Provide one of uid, qr or code' });
    }
    const worker = await this.prisma.worker.findFirst({
      where,
      include: { vendor: { select: { name: true } }, designation: { select: { name: true } } },
    });
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
    const rows = await this.prisma.worker.findMany({
      where: {
        organizationId: user.organizationId,
        deletedAt: null,
        status: 'ACTIVE',
        assignments: { some: { siteId, endDate: null } },
      },
      select: {
        id: true,
        workerCode: true,
        fullName: true,
        photoUrl: true,
        bloodGroup: true,
        emergencyContactName: true,
        emergencyContactNumber: true,
        nfcUid: true,
        qrIdentifier: true,
        category: true,
        // The device refuses a login on an expired card while offline, so it
        // needs the expiry date in its cache.
        validityTill: true,
        vendor: { select: { name: true } },
        designation: { select: { name: true } },
      },
      take: 1000,
    });
    return {
      data: rows.map(({ vendor, designation, ...rest }) => ({
        ...rest,
        vendorName: vendor?.name ?? null,
        designationName: designation?.name ?? null,
      })),
    };
  }

  /**
   * Workers/staff created or last updated by the calling user today (org-local
   * day) — powers the safety officer's "bulk print today's badges".
   */
  async myRecent(user: AuthUser) {
    const org = await this.prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { timezone: true },
    });
    const startOfDay = DateTime.now()
      .setZone(org?.timezone ?? 'Asia/Kolkata')
      .startOf('day')
      .toJSDate();

    const rows = await this.prisma.worker.findMany({
      where: {
        organizationId: user.organizationId,
        deletedAt: null,
        updatedAt: { gte: startOfDay },
        OR: [{ createdById: user.userId }, { updatedById: user.userId }],
      },
      select: {
        id: true,
        workerCode: true,
        fullName: true,
        photoUrl: true,
        bloodGroup: true,
        emergencyContactName: true,
        emergencyContactNumber: true,
        category: true,
        createdAt: true,
        vendor: { select: { name: true } },
        designation: { select: { name: true } },
        assignments: {
          where: { endDate: null },
          select: { site: { select: { name: true } } },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return {
      data: rows.map(({ vendor, designation, assignments, ...rest }) => ({
        ...rest,
        vendorName: vendor?.name ?? null,
        designationName: designation?.name ?? null,
        siteName: assignments[0]?.site.name ?? null,
      })),
    };
  }

  async search(user: AuthUser, q: string) {
    if (!q || q.length < 2) throw Errors.validation({ message: 'q must be at least 2 chars' });
    const rows = await this.prisma.worker.findMany({
      where: {
        organizationId: user.organizationId,
        deletedAt: null,
        OR: [
          { fullName: { contains: q, mode: 'insensitive' } },
          { workerCode: { contains: q, mode: 'insensitive' } },
          { mobileNumber: { contains: q } },
        ],
      },
      include: { vendor: { select: { name: true } }, designation: { select: { name: true } } },
      take: 25,
    });
    return rows.map((w) => this.limitedCard(w));
  }

  async emergency(user: AuthUser, id: string) {
    const worker = await this.prisma.worker.findFirst({
      where: { id, organizationId: user.organizationId },
      select: {
        id: true,
        fullName: true,
        bloodGroup: true,
        emergencyContactName: true,
        emergencyContactNumber: true,
      },
    });
    if (!worker) throw Errors.workerNotFound();
    return worker;
  }
}
