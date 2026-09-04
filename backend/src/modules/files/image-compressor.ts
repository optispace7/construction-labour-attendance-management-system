import { Logger } from '@nestjs/common';
import sharp from 'sharp';

/**
 * Photo compression, backed by sharp.
 *
 * There is a second implementation of this exact signature in
 * `image-compressor.workers.ts`, which the Workers bundle is aliased onto.
 * sharp is a native addon and cannot load there; the transformation it performs
 * is identical either way, so the choice belongs in the build rather than in
 * `FilesService`.
 *
 * Keep the two in step: the parameters here are tuned so an Aadhaar card still
 * machine-reads after re-encoding, and that is not a detail to rediscover.
 */

export interface CompressOptions {
  /** Longest side, in pixels. */
  edge: number;
  /** JPEG quality, 1-100. */
  quality: number;
}

export interface CompressResult {
  buffer: Buffer;
  mimeType: string;
  compressed: boolean;
}

const logger = new Logger('ImageCompressor');

export async function compressImage(
  raw: Buffer,
  originalMime: string,
  { edge, quality }: CompressOptions,
): Promise<CompressResult> {
  try {
    const buffer = await sharp(raw)
      .rotate() // honour EXIF orientation before stripping metadata
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    return { buffer, mimeType: 'image/jpeg', compressed: true };
  } catch (e) {
    // A corrupt or unsupported image should cost the upload its compression,
    // not the upload itself.
    logger.warn(`Image compression failed, storing original: ${String(e)}`);
    return { buffer: raw, mimeType: originalMime, compressed: false };
  }
}
