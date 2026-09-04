import { Logger } from '@nestjs/common';
import { env } from 'cloudflare:workers';

/**
 * Photo compression on the Workers runtime, backed by the Images binding.
 *
 * The Node build uses sharp (see `image-compressor.ts`); sharp is a native
 * addon and cannot load here, so the wrangler `alias` swaps this file in. The
 * two must stay behaviourally identical — same longest edge, same quality, same
 * "never fail the upload over compression" contract — because callers cannot
 * tell which one they got.
 *
 * `scale-down` is the binding's name for sharp's `fit: 'inside'` with
 * `withoutEnlargement`: fit inside the box, never grow a smaller image.
 * Orientation is applied from EXIF automatically, so there is no equivalent of
 * sharp's explicit `.rotate()`.
 */

export interface CompressOptions {
  edge: number;
  quality: number;
}

export interface CompressResult {
  buffer: Buffer;
  mimeType: string;
  compressed: boolean;
}

const logger = new Logger('ImageCompressor');

/** The Images binding, absent unless wrangler.jsonc declares it. */
interface ImagesBinding {
  input(stream: ReadableStream): {
    transform(opts: Record<string, unknown>): {
      output(opts: Record<string, unknown>): Promise<{ response(): Response }>;
    };
  };
}

function streamOf(raw: Buffer): ReadableStream {
  return new Blob([new Uint8Array(raw)]).stream();
}

export async function compressImage(
  raw: Buffer,
  originalMime: string,
  { edge, quality }: CompressOptions,
): Promise<CompressResult> {
  const images = (env as unknown as { IMAGES?: ImagesBinding }).IMAGES;
  if (!images) {
    // Storing the original is worse than compressing it, but far better than
    // refusing the upload — and it is visible, because the row records that it
    // was never compressed.
    logger.warn('IMAGES binding is not configured; storing the original bytes');
    return { buffer: raw, mimeType: originalMime, compressed: false };
  }

  try {
    const result = await images
      .input(streamOf(raw))
      .transform({ width: edge, height: edge, fit: 'scale-down' })
      .output({ format: 'image/jpeg', quality });

    const buffer = Buffer.from(await result.response().arrayBuffer());
    return { buffer, mimeType: 'image/jpeg', compressed: true };
  } catch (e) {
    logger.warn(`Image compression failed, storing original: ${String(e)}`);
    return { buffer: raw, mimeType: originalMime, compressed: false };
  }
}
