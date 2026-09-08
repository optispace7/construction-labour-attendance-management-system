import { WorkersService } from './workers.service';
import { photoBlobs } from '../../infra/d1/schema.generated';
import { AppException } from '../../common/errors/app.exception';

const user = {
  userId: 'u1',
  organizationId: 'org-1',
  role: 'SITE_ADMIN',
} as any;

function makePerson(over: Partial<any> = {}) {
  return {
    id: 'w1',
    fullName: 'Ramesh Kumar',
    workerCode: 'W-001',
    photoUrl: '/files/photo-1',
    aadhaarFrontPhotoId: 'front-1',
    aadhaarBackPhotoId: null,
    idProofPhotoId: null,
    ...over,
  };
}

function makeBlob(over: Partial<any> = {}) {
  return {
    id: 'b',
    mimeType: 'image/jpeg',
    data: Buffer.from('cipher'),
    isEncrypted: true,
    ...over,
  };
}

/** Every string anywhere in a Drizzle condition, however it is nested. */
function stringsIn(value: unknown, found: string[] = [], seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') found.push(value);
  else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const v of Object.values(value as Record<string, unknown>)) stringsIn(v, found, seen);
  }
  return found;
}

/**
 * A stand-in for the Drizzle query builder.
 *
 * Every call returns the double again so the chain can be as long as the code
 * wants, and awaiting it at the end resolves to rows. Which rows depends on the
 * table asked for, which is unambiguous — the worker list and the blob lookup
 * read different tables — and the blob is picked out by finding its id among
 * the values bound into the condition.
 */
function fakeDb(people: any[], blobs: Record<string, any | null>) {
  let table: unknown = null;
  let wantedBlobId: string | null = null;
  const chain: any = {
    select: jest.fn(() => chain),
    from: jest.fn((t: unknown) => {
      table = t;
      wantedBlobId = null;
      return chain;
    }),
    leftJoin: jest.fn(() => chain),
    innerJoin: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    where: jest.fn((cond: unknown) => {
      const values = stringsIn(cond);
      wantedBlobId = Object.keys(blobs).find((id) => values.includes(id)) ?? null;
      return chain;
    }),
    then: (resolve: (rows: any[]) => unknown) => {
      const isBlobTable = table === photoBlobs;
      const rows = isBlobTable ? [blobs[wantedBlobId ?? '']].filter(Boolean) : people;
      return Promise.resolve(rows).then(resolve);
    },
  };
  return chain;
}

function setup(people: any[], blobs: Record<string, any | null>) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const db = fakeDb(people, blobs);
  const d1 = { db, d1: {} };
  const crypto = { decryptBuffer: jest.fn(() => Buffer.from('plain-jpeg')) };
  const service = new WorkersService(d1 as any, crypto as any, audit as any);
  return { service, audit, db, crypto };
}

async function collect(gen: AsyncGenerator<{ path: string; data: Buffer }>) {
  const out: { path: string; data: Buffer }[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

describe('WorkersService.documentFiles', () => {
  it('yields one folder per person, decrypting the stored images', async () => {
    const { service, crypto } = setup([makePerson()], {
      'photo-1': makeBlob({ id: 'photo-1' }),
      'front-1': makeBlob({ id: 'front-1' }),
    });

    const files = await collect(service.documentFiles(user, ['w1']));

    expect(files.map((f) => f.path)).toEqual([
      'Ramesh Kumar (W-001)/photo.jpg',
      'Ramesh Kumar (W-001)/aadhaar-front.jpg',
    ]);
    expect(files[0].data.toString()).toBe('plain-jpeg');
    expect(crypto.decryptBuffer).toHaveBeenCalledTimes(2);
  });

  it('passes through blobs that are not encrypted', async () => {
    const { service, crypto } = setup([makePerson({ aadhaarFrontPhotoId: null })], {
      'photo-1': makeBlob({ id: 'photo-1', isEncrypted: false, data: Buffer.from('raw-jpeg') }),
    });

    const files = await collect(service.documentFiles(user, ['w1']));

    expect(files[0].data.toString()).toBe('raw-jpeg');
    expect(crypto.decryptBuffer).not.toHaveBeenCalled();
  });

  it('keeps a name with path separators inside its own folder', async () => {
    const { service } = setup([makePerson({ fullName: '../../etc/passwd', workerCode: 'W/2' })], {
      'photo-1': makeBlob({ id: 'photo-1' }),
    });

    const files = await collect(service.documentFiles(user, ['w1']));

    expect(files[0].path).toBe('.. .. etc passwd (W 2)/photo.jpg');
    expect(files[0].path).not.toContain('/../');
  });

  it('uses the extension the blob was actually stored as', async () => {
    const { service } = setup([makePerson({ aadhaarFrontPhotoId: null })], {
      'photo-1': makeBlob({ id: 'photo-1', mimeType: 'image/png' }),
    });

    const files = await collect(service.documentFiles(user, ['w1']));

    expect(files[0].path).toBe('Ramesh Kumar (W-001)/photo.png');
  });

  it('skips a dangling blob id rather than failing the whole export', async () => {
    const { service } = setup([makePerson()], { 'photo-1': null, 'front-1': makeBlob() });

    const files = await collect(service.documentFiles(user, ['w1']));

    expect(files.map((f) => f.path)).toEqual(['Ramesh Kumar (W-001)/aadhaar-front.jpg']);
  });

  it('ignores a photoUrl that is not a stored blob', async () => {
    const { service } = setup(
      [makePerson({ photoUrl: 'https://example.com/x.jpg', aadhaarFrontPhotoId: null })],
      {},
    );

    expect(await collect(service.documentFiles(user, ['w1']))).toEqual([]);
  });

  it('audits the export with everyone it covered', async () => {
    const { service, audit } = setup(
      [makePerson(), makePerson({ id: 'w2', workerCode: 'W-002' })],
      {
        'photo-1': makeBlob(),
        'front-1': makeBlob(),
      },
    );

    await collect(service.documentFiles(user, ['w1', 'w2']));

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WORKER_DOCUMENTS_EXPORT',
        organizationId: 'org-1',
        actorUserId: 'u1',
        entityId: null,
        newValue: { count: 2, workerIds: ['w1', 'w2'] },
      }),
    );
  });

  it('scopes the export to the caller organization', async () => {
    const { service, db } = setup([makePerson()], {
      'photo-1': makeBlob(),
      'front-1': makeBlob(),
    });

    await collect(service.documentFiles(user, ['w1']));

    // The organization is part of the WHERE rather than an argument object
    // now, so the assertion reads the values bound into it. Stringifying is
    // not an option — a Drizzle condition holds column objects that refer back
    // to their table.
    const bound = db.where.mock.calls.flatMap((c: any[]) => stringsIn(c[0]));
    expect(bound).toContain('org-1');
  });

  it('rejects when no requested person exists in the org', async () => {
    const { service, audit } = setup([], {});

    await expect(collect(service.documentFiles(user, ['nope']))).rejects.toBeInstanceOf(
      AppException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
