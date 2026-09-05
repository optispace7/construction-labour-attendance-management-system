import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PhotoKind } from '@prisma/client';
import { compressImage } from './image-compressor';
import { blobStore, blobStoreConfigured } from './blob-store';
import { readStoredBytes, StoredBlobRef } from './read-blob';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { UploadFileDto } from './dto/file.dto';

// Accept fairly large raw captures; we re-compress before storing.
const MAX_INPUT_BYTES = 10 * 1024 * 1024; // 10 MB decoded
// Lossy re-encode targets (chosen so Aadhaar text stays readable).
const MAX_EDGE = 1600; // longest side, px
const JPEG_QUALITY = 80;
// Aadhaar cards are the only images we ever machine-read, so they get a little
// headroom over a portrait: JPEG ringing around the Secure QR's modules is what
// defeats a decoder. Kept modest — a 1600px/q80 card still decodes, and every
// extra pixel is paid for on every read.
const AADHAAR_MAX_EDGE = 1800;
const AADHAAR_JPEG_QUALITY = 85;

const AADHAAR_KINDS: PhotoKind[] = ['AADHAAR_FRONT', 'AADHAAR_BACK'];

/**
 * The only image kinds stored in the clear.
 *
 * Deliberately an exception list rather than a list of what to encrypt. A
 * profile photo is shown to many people and cached on devices, so encrypting it
 * buys nothing; everything else is identity material.
 *
 * Stated this way round because the failure modes are not symmetric. Add a kind
 * to the enum and forget to list it here and it is encrypted — safe, and the
 * worst case is someone wondering why. Under the old rule, which named the
 * kinds to encrypt, the same oversight wrote PAN cards to storage in the clear
 * and nothing would have said so.
 */
const UNENCRYPTED_KINDS: PhotoKind[] = ['PROFILE'];

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async upload(user: AuthUser, dto: UploadFileDto) {
    let raw: Buffer;
    try {
      raw = Buffer.from(dto.dataBase64, 'base64');
    } catch {
      throw Errors.validation({ message: 'dataBase64 is not valid base64' });
    }
    if (raw.length === 0) throw Errors.validation({ message: 'Empty file' });
    if (raw.length > MAX_INPUT_BYTES) {
      throw Errors.validation({
        message: `File too large (max ${MAX_INPUT_BYTES / 1024 / 1024} MB)`,
      });
    }

    const kind: PhotoKind = dto.kind ?? 'PROFILE';
    const originalSizeBytes = raw.length;

    // 1) Lossy re-encode: downscale + JPEG. Real storage savings vs. the raw
    //    camera bytes; the result is visually identical and fully readable.
    const {
      buffer: compressed,
      mimeType,
      compressed: didCompress,
    } = await this.compress(raw, dto.mimeType, kind);

    // 2) Everything is encrypted at rest except the kinds listed as public —
    //    see UNENCRYPTED_KINDS for why it is written that way round.
    const encrypt = !UNENCRYPTED_KINDS.includes(kind);
    const stored = encrypt ? this.crypto.encryptBuffer(compressed) : compressed;

    // 3) The bytes go to object storage and the row keeps only metadata — the
    //    organizationId that scopes every read, and the sizes the storage
    //    report counts. Where no bucket is configured they stay in the column,
    //    so an existing deployment is unaffected until it is given one.
    const id = randomUUID();
    const useStore = blobStoreConfigured();
    if (useStore) {
      // Written before the row, so a failure here leaves nothing behind. The
      // reverse order can leave a row pointing at an object that never landed,
      // which reads as a corrupt photo rather than a failed upload.
      await blobStore.put(this.storageKey(user.organizationId, id, kind), stored, mimeType);
    }

    const blob = await this.prisma.photoBlob.create({
      data: {
        id,
        organizationId: user.organizationId,
        mimeType,
        storageKey: useStore ? this.storageKey(user.organizationId, id, kind) : null,
        data: useStore ? null : stored,
        sizeBytes: stored.length,
        originalSizeBytes,
        kind,
        isCompressed: didCompress,
        isEncrypted: encrypt,
        createdBy: user.userId,
      },
      select: { id: true, mimeType: true, sizeBytes: true, originalSizeBytes: true, kind: true },
    });
    return { ...blob, url: `/files/${blob.id}` };
  }

  /**
   * Object key for a blob.
   *
   * Scoped by organization so a bucket listing stays legible and a whole
   * tenant's images can be found without consulting the database, and by kind
   * so the sensitive ones are obvious at a glance.
   */
  private storageKey(organizationId: string, id: string, kind: PhotoKind): string {
    return `org/${organizationId}/${kind.toLowerCase()}/${id}`;
  }

  /**
   * Returns a blob with `data` already decrypted back to its viewable image
   * bytes so the caller can stream it directly.
   *
   * The organizationId in the lookup is what stops one tenant reading
   * another's images; it is why the row is still consulted rather than the
   * bucket being addressed by id directly.
   */
  async get(user: AuthUser, id: string) {
    const blob = await this.prisma.photoBlob.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!blob) throw Errors.notFound('File');
    const stored = await this.readBytes(blob);
    const data = blob.isEncrypted ? this.crypto.decryptBuffer(stored) : stored;
    return { ...blob, data };
  }

  /**
   * The stored bytes, from wherever this particular row keeps them.
   *
   * Rows written before the move still carry their bytes in the column, so both
   * are read for as long as any remain. A row with neither is a dangling
   * reference — worth failing loudly rather than serving an empty image.
   */
  private async readBytes(blob: StoredBlobRef): Promise<Buffer> {
    const bytes = await readStoredBytes(blob);
    if (!bytes) throw Errors.notFound('File');
    return bytes;
  }

  private async compress(
    raw: Buffer,
    originalMime: string,
    kind: PhotoKind = 'PROFILE',
  ): Promise<{ buffer: Buffer; mimeType: string; compressed: boolean }> {
    const isAadhaar = AADHAAR_KINDS.includes(kind);
    // Which implementation runs is decided at build time — see
    // image-compressor.ts. A corrupt image falls back to the raw bytes there
    // rather than failing the upload.
    return compressImage(raw, originalMime, {
      edge: isAadhaar ? AADHAAR_MAX_EDGE : MAX_EDGE,
      quality: isAadhaar ? AADHAAR_JPEG_QUALITY : JPEG_QUALITY,
    });
  }
}
