import { Logger } from '@nestjs/common';

/**
 * Push delivery on the Workers runtime, over the FCM HTTP v1 API.
 *
 * The Node build uses firebase-admin (see `push-sender.ts`), which speaks gRPC
 * and cannot run here; the wrangler `alias` swaps this in. What the SDK does for
 * us has to be done by hand: sign a JWT with the service-account key, exchange
 * it for an access token, and post one message per device.
 *
 * The message body is kept byte-for-byte equivalent to the SDK's, especially
 * the SOS Android block — the channel, the sound and the max priority are what
 * make a locked phone ring, and an SOS that arrives silently is the same as one
 * that never arrived.
 */

export type PushKind = 'ALERT' | 'SOS';

export interface PushMessage {
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, string>;
  kind: PushKind;
}

export interface PushSender {
  readonly configured: boolean;
  init(): void;
  send(message: PushMessage): Promise<string[]>;
}

export function isStaleToken(code: string): boolean {
  return code.includes('registration-token-not-registered') || code.includes('invalid-argument');
}

interface ServiceAccountJson {
  project_id: string;
  client_email: string;
  private_key: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** PEM → the DER bytes WebCrypto wants for a PKCS#8 import. */
function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

class FcmHttpSender implements PushSender {
  private readonly logger = new Logger('PushSender');
  private account?: ServiceAccountJson;
  /** Cached access token; Google issues them for an hour. */
  private token?: { value: string; expiresAt: number };

  init(): void {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
    if (!raw) {
      this.logger.warn('FIREBASE_SERVICE_ACCOUNT not set — SOS push disabled.');
      return;
    }
    try {
      const json = raw.startsWith('{') ? raw : atob(raw);
      const sa = JSON.parse(json) as ServiceAccountJson;
      if (!sa.project_id || !sa.client_email || !sa.private_key) {
        throw new Error('service account is missing project_id, client_email or private_key');
      }
      this.account = sa;
      this.logger.log('Firebase push initialized (HTTP v1).');
    } catch (e) {
      this.logger.error(`Failed to init Firebase push: ${(e as Error).message}`);
    }
  }

  get configured(): boolean {
    return !!this.account;
  }

  /**
   * A Google access token, minted from the service account and reused until it
   * is nearly expired. Re-minting per message would add two round trips to
   * every SOS, which is the one message that cannot afford them.
   */
  private async accessToken(): Promise<string> {
    const sa = this.account!;
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt > now + 60) return this.token.value;

    const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claim = b64url(
      new TextEncoder().encode(
        JSON.stringify({
          iss: sa.client_email,
          scope: SCOPE,
          aud: TOKEN_URL,
          iat: now,
          exp: now + 3600,
        }),
      ),
    );

    const key = await crypto.subtle.importKey(
      'pkcs8',
      // The JSON escapes the newlines; the PEM parser needs them back.
      pemToDer(sa.private_key.replace(/\\n/g, '\n')),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(`${header}.${claim}`),
    );
    const assertion = `${header}.${claim}.${b64url(signature)}`;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!res.ok) {
      throw new Error(`Google refused the service-account assertion: ${res.status}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: now + body.expires_in };
    return body.access_token;
  }

  async send(message: PushMessage): Promise<string[]> {
    if (!this.account || message.tokens.length === 0) return [];

    let token: string;
    try {
      token = await this.accessToken();
    } catch (e) {
      this.logger.error(`${message.kind} push failed: ${(e as Error).message}`);
      return [];
    }

    const url = `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`;
    const android =
      message.kind === 'SOS'
        ? {
            priority: 'HIGH',
            notification: {
              channel_id: 'sos_siren',
              sound: 'sos_siren',
              notification_priority: 'PRIORITY_MAX',
              default_vibrate_timings: true,
              visibility: 'PUBLIC',
            },
          }
        : { priority: 'HIGH' };

    // HTTP v1 has no multicast — the SDK's sendEachForMulticast is a fan-out,
    // so this is one request per device, sent together.
    const results = await Promise.allSettled(
      message.tokens.map((deviceToken) =>
        fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: deviceToken,
              notification: { title: message.title, body: message.body },
              data: message.data,
              android,
            },
          }),
        }),
      ),
    );

    const stale: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        this.logger.error(`${message.kind} push failed: ${String(result.reason)}`);
        continue;
      }
      if (result.value.ok) continue;

      // Google reports a dead token as 404 UNREGISTERED or 400 INVALID_ARGUMENT.
      // Only those are pruned; a 429 or 503 is this minute's problem, not the
      // token's, and dropping it would silently unsubscribe a working phone.
      const detail = await result.value.text().catch(() => '');
      const code = `${result.value.status} ${detail}`.toLowerCase();
      if (
        result.value.status === 404 ||
        code.includes('unregistered') ||
        code.includes('invalid-argument') ||
        code.includes('invalid_argument')
      ) {
        stale.push(message.tokens[i]);
      } else {
        this.logger.error(`${message.kind} push failed (${result.value.status}): ${detail}`);
      }
    }
    return stale;
  }
}

export const pushSender: PushSender = new FcmHttpSender();
