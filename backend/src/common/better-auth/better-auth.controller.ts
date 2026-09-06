import { All, Controller, Req, Res, Version, VERSION_NEUTRAL } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DeviceExempt, Public } from '../rbac/rbac.decorators';
import { getAuth } from './auth';

/**
 * Mounts Better Auth's own handler under /api/better-auth/*.
 *
 * Deliberately beside the existing /api/v1/auth/* rather than over it. Both
 * are live while this is being evaluated, so the panel and the phones keep
 * working on the auth that exists and nothing has to be switched over to find
 * out whether this one works.
 *
 * Version-neutral because Better Auth builds its own paths from baseURL and
 * has no concept of our URI versioning; putting a /v1 in front would make
 * every callback and redirect it generates point somewhere that is not there.
 */
@Controller('better-auth')
export class BetterAuthController {
  @All('*')
  @Version(VERSION_NEUTRAL)
  // Better Auth does its own authentication, and these are the routes people
  // reach before they have any credentials to present. Left behind the global
  // guard every one of them answers 401 in our error format, which is our
  // guard refusing the request, not Better Auth.
  @Public()
  // No approved device either: registering a device is something that happens
  // after a login, and this is the login.
  @DeviceExempt()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const response = await getAuth().handler(toWebRequest(req));

    res.status(response.status);
    // Multiple Set-Cookie headers have to survive, and Headers.forEach
    // flattens them into one comma-joined value that browsers then reject.
    // getSetCookie keeps them separate.
    const setCookies = response.headers.getSetCookie?.() ?? [];
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'set-cookie') res.setHeader(key, value);
    });
    if (setCookies.length) res.setHeader('set-cookie', setCookies);

    const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
    if (body) res.send(body);
    else res.end();
  }
}

/**
 * An Express request as a WHATWG Request, which is all Better Auth accepts.
 *
 * The body is re-serialised rather than streamed: by the time this runs the
 * app's JSON parser has already consumed the stream, so `req.body` is the only
 * copy left and reading `req` again yields nothing.
 */
function toWebRequest(req: Request): Request2 {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol ?? 'https';
  const url = new URL(req.originalUrl, `${proto}://${req.headers.host ?? 'localhost'}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value != null) headers.set(key, value);
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body =
    hasBody && req.body != null && Object.keys(req.body as object).length > 0
      ? JSON.stringify(req.body)
      : undefined;
  if (body) headers.set('content-type', 'application/json');
  // The re-serialised body is a different length from the one that arrived.
  headers.delete('content-length');

  return new Request(url.toString(), { method: req.method, headers, body });
}

/** Alias so the DOM Request type is not shadowed by Express's. */
type Request2 = globalThis.Request;
