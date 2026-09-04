import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * Serves the Android APK.
 *
 * The file used to sit in `public/` and be rewritten to. It cannot any more:
 * static assets are capped at 25 MiB and the APK is about 72 MB, which fails
 * the deploy outright rather than at request time.
 *
 * It is streamed from the media bucket rather than that bucket being made
 * public, because the same bucket holds worker photos and Aadhaar images — a
 * public bucket would expose those to anyone who could guess a key. Going
 * through the Worker keeps the bucket private and /download unchanged.
 */
export const dynamic = 'force-dynamic';

const APK_KEY = 'apk/CLAMS.apk';

interface MediaEnv {
  MEDIA?: R2Bucket;
}

/**
 * The R2 binding.
 *
 * The context is resolved in async mode: the synchronous form is only valid
 * where the request context is already established, and returns an env without
 * bindings in a route handler — which shows up as "the file is missing" rather
 * than as a configuration error, so it is worth being explicit.
 */
async function mediaBucket(): Promise<R2Bucket | undefined> {
  const { env } = await getCloudflareContext({ async: true });
  return (env as unknown as MediaEnv).MEDIA;
}

export async function GET() {
  const bucket = await mediaBucket();
  if (!bucket) {
    return new Response('Downloads are not configured on this deployment.', { status: 503 });
  }

  const object = await bucket.get(APK_KEY);
  if (!object) {
    // Upload it with `wrangler r2 object put ... --remote`. Without --remote the
    // CLI writes to the local miniflare store, where it reads back perfectly and
    // the deployed Worker sees nothing.
    return new Response('The app build is not available right now.', { status: 404 });
  }

  // Passed through rather than buffered — 72 MB through a Worker's memory would
  // be a poor way to serve a file that is only ever streamed.
  return new Response(object.body, {
    headers: {
      'content-type': 'application/vnd.android.package-archive',
      'content-disposition': 'attachment; filename="CLAMS.apk"',
      'content-length': String(object.size),
      // A new build replaces the object; a phone part-way through an install
      // should not receive half of each.
      'cache-control': 'public, max-age=86400',
    },
  });
}
