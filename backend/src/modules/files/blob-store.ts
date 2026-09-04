import { Logger } from '@nestjs/common';

/**
 * Where photo bytes live.
 *
 * Photos used to sit in a Postgres column, which is what made a 500 MB database
 * a real ceiling: a worker with a profile photo and both Aadhaar sides is about
 * 1 MB, against attendance rows measured in bytes. Moving them to object
 * storage takes the database back to records, where it belongs.
 *
 * There is a second implementation of this interface in `blob-store.workers.ts`
 * backed by the R2 binding; the Workers build is aliased onto it. This one
 * speaks the S3 API so a plain Node deployment reaches the same bucket.
 *
 * Encryption is NOT this layer's business. Bytes arrive already encrypted when
 * they should be — see FilesService — so the store never holds a key and a
 * compromised bucket yields ciphertext for anything sensitive.
 */
export interface BlobStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const logger = new Logger('BlobStore');

/** Set when the bucket is reachable over the S3 API. */
function s3Config() {
  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET = 'clams-media',
  } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  return {
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
  };
}

/**
 * True when object storage is configured.
 *
 * When it is not, FilesService keeps writing to the database column. That is
 * what lets an existing deployment carry on untouched while a new one stores
 * photos in the bucket — the alternative is a flag day, and a flag day for the
 * only copy of somebody's Aadhaar photo is not a good trade.
 */
export function blobStoreConfigured(): boolean {
  return s3Config() !== null;
}

let client: unknown;

async function s3(): Promise<{ send: (cmd: unknown) => Promise<unknown> }> {
  if (!client) {
    // Imported lazily so a deployment without object storage does not pay for
    // the SDK at boot.
    const { S3Client } = await import('@aws-sdk/client-s3');
    const cfg = s3Config();
    if (!cfg) throw new Error('Object storage is not configured');
    client = new S3Client({
      region: 'auto',
      endpoint: cfg.endpoint,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  return client as { send: (cmd: unknown) => Promise<unknown> };
}

export const blobStore: BlobStore = {
  async put(key, bytes, contentType) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const cfg = s3Config();
    if (!cfg) throw new Error('Object storage is not configured');
    const c = await s3();
    await c.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  },

  async get(key) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const cfg = s3Config();
    if (!cfg) throw new Error('Object storage is not configured');
    const c = await s3();
    try {
      const res = (await c.send(
        new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
      )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (e) {
      // A missing object is a dangling reference, not a server fault — the
      // caller decides whether that is fatal.
      logger.warn(`Object ${key} could not be read: ${String(e)}`);
      return null;
    }
  },

  async delete(key) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const cfg = s3Config();
    if (!cfg) throw new Error('Object storage is not configured');
    const c = await s3();
    await c.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  },
};
