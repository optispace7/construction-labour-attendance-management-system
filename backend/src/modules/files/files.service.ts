import { Injectable, Logger } from '@nestjs/common';
import { PhotoKind } from '@prisma/client';
import { compressImage } from './image-compressor';
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
// defeats a decoder. Kept modest — a 1600px/q80 card still decodes, and these
// blobs live in the database against the storage budget.
const AADHAAR_MAX_EDGE = 1800;
const AADHAAR_JPEG_QUALITY = 85;

const AADHAAR_KINDS: PhotoKind[] = ['AADHAAR_FRONT', 'AADHAAR_BACK'];

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

    // 2) Aadhaar and ID-proof images are encrypted at rest; profile photos are
    //    not (they are streamed to many viewers / cached on devices, so we
    //    keep them cheap).
    const encrypt = kind === 'AADHAAR_FRONT' || kind === 'AADHAAR_BACK' || kind === 'ID_PROOF';
    const stored = encrypt ? this.crypto.encryptBuffer(compressed) : compressed;

    const blob = await this.prisma.photoBlob.create({
      data: {
        organizationId: user.organizationId,
        mimeType,
        data: stored,
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
   * Returns a blob with `data` already decrypted back to its viewable image
   * bytes so the caller can stream it directly.
   */
  async get(user: AuthUser, id: string) {
    const blob = await this.prisma.photoBlob.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!blob) throw Errors.notFound('File');
    const data = blob.isEncrypted
      ? this.crypto.decryptBuffer(Buffer.from(blob.data))
      : Buffer.from(blob.data);
    return { ...blob, data };
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
