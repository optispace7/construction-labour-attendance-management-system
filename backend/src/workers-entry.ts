/**
 * Cloudflare Workers entrypoint.
 *
 * `main.ts` stays the entrypoint for a normal Node process. This file is the
 * equivalent for the Workers runtime: it builds the same Nest application and
 * hands the underlying Node HTTP server to `httpServerHandler`, which is what
 * lets the runtime drive an ordinary `http.Server` instead of a `fetch` export.
 *
 * The two differ in what they can assume, so the differences live here rather
 * than as branches inside `main.ts`:
 *   - the app is built lazily on the first request, because this runtime
 *     forbids asynchronous I/O while the module is still being evaluated;
 *   - Swagger is left out — it is several hundred KB of bundle for a page
 *     nobody opens in production, and bundle size is capped here.
 */
import { NestFactory } from '@nestjs/core';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import { httpServerHandler } from 'cloudflare:node';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { RequestIdMiddleware } from './common/errors/request-id.middleware';
import { jsonBody } from './workers-stubs/json-body';
import { StorageMonitor } from './modules/storage/storage.monitor';
import { ForgotLogoutMonitor } from './modules/notifications/forgot-logout.monitor';
import { DocumentExpiryMonitor } from './modules/company-documents/document-expiry.monitor';

/**
 * Loopback port. Nothing binds a real socket here — `httpServerHandler` matches
 * on this number to find the server the app listened on.
 */
const PORT = 8080;

async function bootstrap() {
  // The adapter is passed in rather than discovered. NestFactory otherwise
  // resolves @nestjs/platform-express through a runtime require that a bundler
  // cannot follow, and the resulting undefined surfaces only at boot.
  const app = await NestFactory.create(AppModule, new ExpressAdapter(express()), {
    bufferLogs: false,
    bodyParser: false,
  });

  // Same 16 MB ceiling as the Node entrypoint — base64 Aadhaar captures arrive
  // as JSON — but parsed without body-parser, which cannot load here.
  app.use(jsonBody(16 * 1024 * 1024));

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.use(RequestIdMiddleware);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? '*').split(','),
    credentials: true,
  });

  await app.listen(PORT);
  return app;
}

/**
 * The application, built on first use rather than at module scope.
 *
 * Bootstrapping opens a database connection, and this runtime forbids
 * asynchronous I/O while the module is still being evaluated — there is no
 * request to attribute it to. So the work is deferred into the first handler
 * call and memoised: later requests on the same isolate await a promise that
 * has already settled.
 */
let appPromise: Promise<INestApplication> | null = null;

function getApp(): Promise<INestApplication> {
  appPromise ??= bootstrap();
  return appPromise;
}

const httpHandler = httpServerHandler({ port: PORT }) as ExportedHandler;

/**
 * Cron schedules, mapped to the monitor each one drives.
 *
 * These replace the `setInterval` timers the monitors use on a Node process —
 * see interval-monitors.ts. The intervals are kept the same so behaviour does
 * not quietly change with the hosting: ten minutes for the housekeeping pass,
 * thirty for the storage check, and document expiry once a day.
 */
const CRON_JOBS: Record<
  string,
  { name: string; run: (app: INestApplication) => Promise<void> }
> = {
  '*/10 * * * *': {
    name: 'forgot-logout + retention',
    run: (app) => app.get(ForgotLogoutMonitor).check(),
  },
  '*/30 * * * *': {
    name: 'storage usage',
    run: (app) => app.get(StorageMonitor).check(),
  },
  '0 */6 * * *': {
    name: 'document expiry',
    run: (app) => app.get(DocumentExpiryMonitor).check(),
  },
};

/**
 * The APK, streamed straight out of R2.
 *
 * Answered here, in the raw fetch handler, before Nest or Express sees the
 * request — and that placement is the whole point. The panel used to serve
 * this from a Next.js route, and Next re-wrapped the stream: the reply came
 * back chunked with the Content-Length stripped, and the body was cut off at a
 * random size four times in six. Every one of those was an HTTP 200, so the
 * phone saved a truncated file and Android refused to install it, with nothing
 * anywhere to say why.
 *
 * A framework that buffers or re-encodes a 90 MB body is the wrong thing in
 * the path. This hands R2's own stream to the runtime untouched, with the
 * length R2 reports, so a short read is a broken download the client can
 * actually detect rather than a silently corrupt install.
 */
async function serveApk(env: unknown): Promise<Response> {
  const bucket = (env as { MEDIA?: R2Bucket }).MEDIA;
  if (!bucket) {
    return new Response('Downloads are not configured on this deployment.', { status: 503 });
  }
  const object = await bucket.get('apk/CLAMS.apk');
  if (!object) return new Response('The app build is not available right now.', { status: 404 });

  return new Response(object.body, {
    headers: {
      'content-type': 'application/vnd.android.package-archive',
      'content-disposition': 'attachment; filename="CLAMS.apk"',
      // Stated, so a truncated body fails loudly instead of installing as a
      // corrupt APK.
      'content-length': String(object.size),
      // Lets a phone resume rather than restart 90 MB on a site connection.
      'accept-ranges': 'bytes',
      // Never reused from a cache. The file behind this URL is replaced by every
      // release, and with a day's max-age a phone that had downloaded once got
      // its old copy back all day — a watchman "installed 1.1.0+22" and was
      // still on +20.
      'cache-control': 'no-store',
      etag: object.httpEtag,
    },
  });
}

export default {
  ...httpHandler,

  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    // Before the app is even built: this is a file read, it needs none of the
    // framework, and booting Nest to serve it would only add the failure mode
    // this route exists to avoid.
    if (new URL(request.url).pathname === '/download') return serveApk(env);

    // Build the app before the first request is served, not while the module
    // is being evaluated — see getApp().
    await getApp();
    return (httpHandler.fetch as NonNullable<ExportedHandler['fetch']>)(
      request as never,
      env as never,
      ctx,
    );
  },

  async scheduled(controller: ScheduledController, _env: unknown, ctx: ExecutionContext) {
    const job = CRON_JOBS[controller.cron];
    if (!job) {
      console.warn(`No monitor is mapped to cron "${controller.cron}"`);
      return;
    }
    // waitUntil so a slow pass is not cut short when the handler returns; the
    // monitors are claim-guarded, so an overlapping run is harmless.
    ctx.waitUntil(
      getApp()
        .then((app) => job.run(app))
        .catch((e: unknown) => {
          console.error(`Scheduled "${job.name}" failed: ${String(e)}`);
        }),
    );
  },
} satisfies ExportedHandler;
