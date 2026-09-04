import type { NextFunction, Request, Response } from 'express';

/**
 * Minimal JSON body parser for the Workers runtime.
 *
 * `express.json()` is body-parser, which pulls in raw-body and then iconv-lite
 * for charset transcoding. iconv-lite loads its stream support through a lazy
 * `require` that does not survive bundling — it throws
 * `require_streams(...) is not a function` before the app finishes booting.
 *
 * Transcoding is not something CLAMS needs: every client is our own, every
 * request body is UTF-8 JSON, and uploads arrive as base64 inside that JSON
 * rather than as multipart. So the whole chain is replaced with the part that
 * is actually used.
 *
 * Deliberately narrow: anything that is not JSON is left untouched for the next
 * handler, exactly as body-parser would.
 */
export function jsonBody(limitBytes: number) {
  return function jsonBodyMiddleware(req: Request, res: Response, next: NextFunction): void {
    const type = String(req.headers['content-type'] ?? '');
    if (!type.toLowerCase().includes('application/json')) {
      next();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;

    const fail = (status: number, message: string) => {
      if (finished) return;
      finished = true;
      // Match the shape the exception filter already understands.
      const err = Object.assign(new Error(message), { status, statusCode: status });
      next(err);
    };

    req.on('data', (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > limitBytes) {
        // Stop reading rather than buffering a body we have already rejected —
        // memory here is capped for the whole request, not just the body.
        req.pause();
        fail(413, `Request body larger than ${limitBytes} bytes`);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (finished) return;
      finished = true;
      if (chunks.length === 0) {
        req.body = {};
        next();
        return;
      }
      try {
        req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        next();
      } catch {
        const err = Object.assign(new Error('Invalid JSON body'), {
          status: 400,
          statusCode: 400,
        });
        next(err);
      }
    });

    req.on('error', (e) => {
      if (finished) return;
      finished = true;
      next(e);
    });
  };
}
