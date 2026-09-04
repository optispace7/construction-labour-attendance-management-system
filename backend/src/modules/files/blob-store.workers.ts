import { Logger } from '@nestjs/common';
import { env } from 'cloudflare:workers';

/**
 * Photo storage on the Workers runtime, backed by the R2 binding.
 *
 * The Node build reaches the same bucket over the S3 API (see `blob-store.ts`);
 * the wrangler `alias` swaps this file in. The binding is the better path here:
 * no credentials to hold, no SDK in the bundle, and the request never leaves
 * Cloudflare's network.
 *
 * As on the Node side, bytes arrive already encrypted when they should be. This
 * layer holds no key, so a compromised bucket yields ciphertext for every
 * Aadhaar and ID image.
 */
export interface BlobStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const logger = new Logger('BlobStore');

interface R2Bucket {
  put(key: string, value: ArrayBuffer, options?: unknown): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
}

function bucket(): R2Bucket {
  const b = (env as unknown as { MEDIA?: R2Bucket }).MEDIA;
  if (!b) {
    throw new Error('The MEDIA bucket binding is not configured for this Worker');
  }
  return b;
}

export function blobStoreConfigured(): boolean {
  return Boolean((env as unknown as { MEDIA?: R2Bucket }).MEDIA);
}

export const blobStore: BlobStore = {
  async put(key, bytes, contentType) {
    // Copied into a standalone ArrayBuffer: a Buffer is a view onto a pooled
    // allocation, so handing its underlying buffer straight over can carry
    // unrelated bytes — someone else's image, in this application.
    const body = new Uint8Array(bytes).buffer;
    await bucket().put(key, body, { httpMetadata: { contentType } });
  },

  async get(key) {
    const object = await bucket().get(key);
    if (!object) {
      logger.warn(`Object ${key} is missing from the media bucket`);
      return null;
    }
    return Buffer.from(await object.arrayBuffer());
  },

  async delete(key) {
    await bucket().delete(key);
  },
};
