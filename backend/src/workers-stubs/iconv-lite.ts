/**
 * Minimal stand-in for iconv-lite.
 *
 * iconv-lite loads its stream support with `require("./streams")(iconv)`. That
 * call does not survive bundling — it throws `require_streams(...) is not a
 * function` while the module is still initialising, which takes down the whole
 * Worker before Nest has finished booting. The import is unavoidable:
 * `@nestjs/platform-express` pulls in body-parser, which pulls in raw-body,
 * which pulls in iconv-lite, whether or not any of it is used.
 *
 * Only the decoding half is real, and only for the encodings that can actually
 * reach us. Every CLAMS client is our own and sends UTF-8; the legacy codepages
 * iconv-lite exists to handle are not part of the picture, so pretending to
 * support them would be worse than saying plainly that they are unsupported.
 */

type Encoding = string;

/** Encodings Buffer can handle natively, normalised to Node's spelling. */
const NATIVE: Record<string, BufferEncoding> = {
  utf8: 'utf8',
  'utf-8': 'utf8',
  ucs2: 'ucs2',
  'ucs-2': 'ucs2',
  utf16le: 'utf16le',
  'utf-16le': 'utf16le',
  ascii: 'ascii',
  binary: 'latin1',
  latin1: 'latin1',
  'iso-8859-1': 'latin1',
  base64: 'base64',
  hex: 'hex',
};

function normalise(encoding: Encoding): BufferEncoding | null {
  return NATIVE[String(encoding ?? '').toLowerCase().replace(/[_ ]/g, '-')] ?? null;
}

export function encodingExists(encoding: Encoding): boolean {
  return normalise(encoding) !== null;
}

export function decode(buffer: Buffer, encoding: Encoding): string {
  const enc = normalise(encoding);
  if (!enc) {
    throw new Error(
      `Unsupported charset "${encoding}". This runtime decodes UTF-8 and the ` +
        'other Buffer-native encodings only.',
    );
  }
  return Buffer.from(buffer).toString(enc);
}

export function encode(str: string, encoding: Encoding): Buffer {
  const enc = normalise(encoding);
  if (!enc) {
    throw new Error(`Unsupported charset "${encoding}".`);
  }
  return Buffer.from(str, enc);
}

/** raw-body reads this to decide whether it may decode at all. */
export const encodings = NATIVE;

export default { encodingExists, decode, encode, encodings };
