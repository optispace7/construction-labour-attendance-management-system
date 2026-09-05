import { Logger } from '@nestjs/common';
import { App, cert, getApp, getApps, initializeApp, ServiceAccount } from 'firebase-admin/app';
import { getMessaging, MulticastMessage } from 'firebase-admin/messaging';

/**
 * How a push actually reaches Firebase.
 *
 * `PushService` owns what a message means — that an SOS is data-plus-
 * notification on a high-importance channel so a locked phone still rings, that
 * a stale token gets pruned — and this owns only the delivery. There is a
 * second implementation in `push-sender.workers.ts`; the Workers bundle is
 * aliased onto it, because firebase-admin speaks gRPC and that runtime has no
 * way to.
 *
 * The two must stay behaviourally identical. This one is the reference: an SOS
 * that fails to ring is the failure that matters here.
 */

/** Which Android treatment a message gets. The SOS one is why phones ring. */
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
  /** Called once at startup; must not throw. */
  init(): void;
  /** Sends, and returns the tokens Firebase says are dead, for pruning. */
  send(message: PushMessage): Promise<string[]>;
}

/** A token Firebase has told us is dead, rather than a transient failure. */
export function isStaleToken(code: string): boolean {
  return code.includes('registration-token-not-registered') || code.includes('invalid-argument');
}

class FirebaseAdminSender implements PushSender {
  private readonly logger = new Logger('PushSender');
  private app?: App;

  init(): void {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
    if (!raw) {
      this.logger.warn('FIREBASE_SERVICE_ACCOUNT not set — SOS push disabled.');
      return;
    }
    try {
      const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      const sa = JSON.parse(json) as ServiceAccount;
      this.app = getApps().length ? getApp() : initializeApp({ credential: cert(sa) });
      this.logger.log('Firebase push initialized.');
    } catch (e) {
      this.logger.error(`Failed to init Firebase push: ${(e as Error).message}`);
    }
  }

  get configured(): boolean {
    return !!this.app;
  }

  async send(message: PushMessage): Promise<string[]> {
    if (!this.app || message.tokens.length === 0) return [];

    const payload: MulticastMessage = {
      tokens: message.tokens,
      notification: { title: message.title, body: message.body },
      data: message.data,
      android:
        message.kind === 'SOS'
          ? {
              priority: 'high',
              notification: {
                channelId: 'sos_siren',
                sound: 'sos_siren',
                priority: 'max',
                defaultVibrateTimings: true,
                visibility: 'public',
              },
            }
          : { priority: 'high' },
    };

    const stale: string[] = [];
    try {
      const res = await getMessaging(this.app).sendEachForMulticast(payload);
      res.responses.forEach((r, i) => {
        if (!r.success && isStaleToken(r.error?.code ?? '')) stale.push(message.tokens[i]);
      });
    } catch (e) {
      this.logger.error(`${message.kind} push failed: ${(e as Error).message}`);
    }
    return stale;
  }
}

export const pushSender: PushSender = new FirebaseAdminSender();
