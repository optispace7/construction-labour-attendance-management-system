import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
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

    // HttpException, not a plain Error with a status field — the exception
    // filter maps HttpException to problem+json and turns anything else into a
    // 500, so a hand-rolled error shape is reported as a server fault when it
    // is really the client's.
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      next(error);
    };

    req.on('data', (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > limitBytes) {
        // Stop reading rather than buffering a body we have already rejected —
        // memory here is capped for the whole request, not just the body.
        req.pause();
        fail(new PayloadTooLargeException(`Request body larger than ${limitBytes} bytes`));
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
        next(new BadRequestException('Invalid JSON body'));
      }
    });

    req.on('error', (e) => {
      if (finished) return;
      finished = true;
      next(e);
    });
  };
}
