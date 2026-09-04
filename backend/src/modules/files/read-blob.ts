import { blobStore } from './blob-store';

/** The parts of a photo row that say where its bytes are. */
export interface StoredBlobRef {
  storageKey: string | null;
  data: Uint8Array | null;
}

/**
 * The stored bytes for a photo row, from wherever that row keeps them.
 *
 * Photos moved from a Postgres column to object storage, and rows written
 * before the move still carry their bytes inline. Both are read for as long as
 * any of the old ones remain, so the backfill can run while the app is serving.
 *
 * Shared rather than duplicated because there are two readers — serving a photo
 * and building the documents ZIP — and a fallback that only half the callers
 * implement is how one of them starts returning empty images.
 *
 * Returns the bytes exactly as stored: still encrypted for the kinds that are
 * encrypted. Decryption belongs to the caller, which knows whether it is
 * allowed to decrypt at all.
 */
export async function readStoredBytes(blob: StoredBlobRef): Promise<Buffer | null> {
  if (blob.storageKey) {
    return blobStore.get(blob.storageKey);
  }
  return blob.data ? Buffer.from(blob.data) : null;
}
