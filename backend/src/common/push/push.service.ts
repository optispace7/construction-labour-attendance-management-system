import { Injectable, OnModuleInit } from '@nestjs/common';
import { pushSender } from './push-sender';

/**
 * Firebase Cloud Messaging sender. Disabled (no-op) unless
 * FIREBASE_SERVICE_ACCOUNT is set — so the API runs fine before push is
 * configured. The env var holds the service-account JSON, raw or base64.
 *
 * What a message *means* lives here; how it is delivered lives in the sender,
 * which has one implementation per runtime (firebase-admin on Node, the FCM
 * HTTP API on Workers, chosen by the build).
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly sender = pushSender;

  onModuleInit() {
    this.sender.init();
  }

  get enabled(): boolean {
    return this.sender.configured;
  }

  /**
   * Standard-priority alert (device approvals, missed logouts). Returns stale
   * tokens for pruning, like {@link sendSos}.
   */
  async sendAlert(
    tokens: string[],
    payload: { title: string; body: string; data?: Record<string, string> },
  ): Promise<string[]> {
    return this.sender.send({
      tokens,
      title: payload.title,
      body: payload.body,
      data: { type: 'ALERT', ...payload.data },
      kind: 'ALERT',
    });
  }

  /**
   * High-priority SOS. Carries a notification block as well as the data, so
   * Android's system tray shows and rings it on the high-importance siren
   * channel even when the app is killed; the data is kept for the foreground
   * handler and for tap routing.
   *
   * Returns tokens that are no longer valid, so the caller can prune them.
   */
  async sendSos(
    tokens: string[],
    payload: { title: string; body: string; sosEventId: string },
  ): Promise<string[]> {
    return this.sender.send({
      tokens,
      title: payload.title,
      body: payload.body,
      data: {
        type: 'SOS',
        title: payload.title,
        body: payload.body,
        sosEventId: payload.sosEventId,
      },
      kind: 'SOS',
    });
  }
}
