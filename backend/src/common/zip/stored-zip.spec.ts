import { writeFileSync } from 'node:fs';
import { buildStoredZip, crc32 } from './stored-zip';

/**
 * The document export's zip, built in memory because the streamed one hung on
 * the Workers runtime. Read back here the way an unzip tool does: from the end
 * record, through the central directory, to each entry.
 */

interface Read {
  name: string;
  data: Buffer;
  crc: number;
}

function readZip(zip: Buffer): Read[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  expect(at + zip.readUInt32LE(end + 12)).toBe(end);

  const out: Read[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    expect(zip.readUInt16LE(at + 10)).toBe(0); // stored
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const local = zip.readUInt32LE(at + 42);

    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    expect(zip.readUInt32LE(local + 14)).toBe(crc);
    const localNameLength = zip.readUInt16LE(local + 26);
    const dataStart = local + 30 + localNameLength + zip.readUInt16LE(local + 28);
    out.push({ name, data: zip.subarray(dataStart, dataStart + size), crc });
    at += 46 + nameLength;
  }
  return out;
}

describe('buildStoredZip', () => {
  it('computes the standard CRC-32', () => {
    // The published check value for this algorithm.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('writes each entry so it reads back byte for byte', () => {
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0, 255]);
    const card = Buffer.alloc(70_000, 7);
    const zip = buildStoredZip([
      { name: 'Ramesh (W-0001)/photo.jpg', data: photo },
      { name: 'Ramesh (W-0001)/aadhaar-front.jpg', data: card },
    ]);

    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([
      'Ramesh (W-0001)/photo.jpg',
      'Ramesh (W-0001)/aadhaar-front.jpg',
    ]);
    expect(entries[0].data.equals(photo)).toBe(true);
    expect(entries[1].data.equals(card)).toBe(true);
    expect(entries[1].crc).toBe(crc32(card));
  });

  it('keeps names that are not ASCII', () => {
    const [entry] = readZip(buildStoredZip([{ name: 'रमेश (W-0002)/photo.jpg', data: Buffer.from('x') }]));
    expect(entry.name).toBe('रमेश (W-0002)/photo.jpg');
  });

  it('builds a valid empty archive', () => {
    const zip = buildStoredZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  // Checked against a real unzip tool by hand: set ZIP_SAMPLE_OUT to a path and
  // open the file it writes. Off in CI, which has no reason to trust a tool
  // that may not be installed.
  const out = process.env.ZIP_SAMPLE_OUT;
  (out ? it : it.skip)('writes a sample for an outside unzip tool', () => {
    writeFileSync(
      out!,
      buildStoredZip([
        { name: 'Ramesh (W-0001)/photo.jpg', data: Buffer.from('photo-bytes') },
        { name: 'Ramesh (W-0001)/aadhaar-back.jpg', data: Buffer.alloc(5000, 42) },
      ]),
    );
  });
});
