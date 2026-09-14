/**
 * A zip archive built in memory, its entries stored without compression.
 *
 * The document export used to stream archiver into the response. On the
 * Workers runtime that stream never finished: the archive waited for the
 * response to be read, and the response was not handed over until the archive
 * had finished, so every download hung until the platform cancelled it. The PDF
 * exports build their bytes first and send them with a length, and never had
 * that problem — this lets the zip do the same.
 *
 * Stored rather than deflated: the entries are JPEGs, which do not get smaller,
 * and deflating them would spend CPU for nothing. No Zip64, so fewer than 65,536
 * entries and under 4 GiB — far past anything an export is allowed to reach.
 */

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  data: Uint8Array;
  modified?: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, the only timestamp a plain zip header has room for. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const UTF8_NAMES = 0x0800;
const STORED = 0;
const VERSION = 20;
const MAX_U32 = 0xffffffff;

export function buildStoredZip(entries: ZipEntry[], now = new Date()): Buffer {
  if (entries.length > 0xffff) throw new Error('Too many entries for a zip without Zip64');

  const records: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const { data } = entry;
    if (data.length > MAX_U32 || offset > MAX_U32) {
      throw new Error('Archive too large for a zip without Zip64');
    }
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.modified ?? now);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(STORED, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    records.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION, 4); // version made by
    central.writeUInt16LE(VERSION, 6); // version needed
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(STORED, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // Extra field, comment, disk number, internal and external attributes: none.
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const directorySize = directory.reduce((n, part) => n + part.length, 0);
  if (offset > MAX_U32) throw new Error('Archive too large for a zip without Zip64');

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // entries in total
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16); // where the central directory starts

  return Buffer.concat([...records, ...directory, end]);
}
