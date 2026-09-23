/**
 * Sends the Android APK download to the API worker, which serves the bytes.
 *
 * This route used to stream the file itself, out of the R2 binding, and it did
 * not work: Next re-wrapped the response, so the reply went out chunked with
 * the Content-Length stripped, and the body was cut short at a random size four
 * times in six. Every one of those was an HTTP 200, so a phone saved a
 * truncated file and Android rejected the install with nothing to explain it.
 * The same route also answered 503 now and then, because the binding lookup
 * came back empty.
 *
 * The API worker has no framework between the R2 stream and the socket, states
 * the length R2 reports, and supports range requests — so a short read is a
 * failed download rather than a corrupt install. It holds the same MEDIA
 * binding and the same private bucket; only the path to the bytes changed.
 *
 * The URL people already have keeps working, which is why this is a redirect
 * rather than a note telling every site to use a different address.
 */
export const dynamic = 'force-dynamic';

/**
 * Where the bytes are, read from the deployment at request time.
 *
 * Deliberately not derived from NEXT_PUBLIC_API_BASE_URL: Next inlines every
 * NEXT_PUBLIC_ value at build time, so a stale .env.local on whichever machine
 * ran the build decides it. That is not hypothetical — it is how this redirect
 * first went out pointing at the retired Azure API, while the Worker's own
 * variables said the right thing all along.
 */
function apkUrl(): string {
  const configured = process.env.APK_DOWNLOAD_URL;
  if (!configured) {
    throw new Error('APK_DOWNLOAD_URL is not set on this deployment, so /download has no target.');
  }
  return configured;
}

export async function GET() {
  // A fresh address on every tap. The API used to send the APK with a day's
  // max-age, so a phone that downloaded once was handed its saved copy for the
  // next 24 hours without the browser ever asking the server — a watchman
  // installed "the new app" three times on 23 Sep and stayed on 1.1.0+20. A
  // header change cannot reach a copy already saved; a URL that has never been
  // seen before can. The API matches on the path and ignores the query.
  const target = new URL(apkUrl());
  target.searchParams.set('v', Date.now().toString(36));

  // 302 rather than 301: the target is a deployment detail, and a permanent
  // redirect would be cached by every phone that ever followed it. no-store so
  // the redirect itself is never replayed with an old address.
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), 'cache-control': 'no-store' },
  });
}
