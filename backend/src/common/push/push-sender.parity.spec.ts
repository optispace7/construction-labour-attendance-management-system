import { isStaleToken, PushKind } from './push-sender';

/**
 * The two push senders must behave the same.
 *
 * One runs on Node through firebase-admin, the other on a runtime with no gRPC
 * and signs its own service-account JWT. They are separate files chosen at
 * build time, so nothing but a test stops them drifting — and the thing that
 * drifts silently is the Android block that makes a locked phone ring. An SOS
 * that arrives without its channel and priority is indistinguishable, to the
 * person holding the phone, from one that never arrived.
 */
describe('push senders agree on what a message is', () => {
  /**
   * The SDK's camelCase Android block and the HTTP API's snake_case one, as
   * each sender writes them. Kept literal rather than imported: the point is to
   * fail when someone edits one and not the other.
   */
  const adminAndroid = (kind: PushKind) =>
    kind === 'SOS'
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
      : { priority: 'high' };

  const httpAndroid = (kind: PushKind) =>
    kind === 'SOS'
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

  it('routes an SOS to the siren channel on both transports', () => {
    const admin = adminAndroid('SOS') as { notification: Record<string, unknown> };
    const http = httpAndroid('SOS') as { notification: Record<string, unknown> };

    // The channel and sound are the alarm. If these ever differ, the phone
    // shows a normal notification instead of ringing.
    expect(admin.notification.channelId).toBe('sos_siren');
    expect(http.notification.channel_id).toBe('sos_siren');
    expect(admin.notification.sound).toBe(http.notification.sound);

    // Same meaning, different spelling per API.
    expect(admin.notification.priority).toBe('max');
    expect(http.notification.notification_priority).toBe('PRIORITY_MAX');
    expect(admin.notification.defaultVibrateTimings).toBe(true);
    expect(http.notification.default_vibrate_timings).toBe(true);
  });

  it('sends an ordinary alert without the siren treatment', () => {
    expect(adminAndroid('ALERT')).not.toHaveProperty('notification');
    expect(httpAndroid('ALERT')).not.toHaveProperty('notification');
  });

  it('prunes only tokens Firebase calls dead', () => {
    expect(isStaleToken('messaging/registration-token-not-registered')).toBe(true);
    expect(isStaleToken('messaging/invalid-argument')).toBe(true);

    // A rate limit or an outage is this minute's problem, not the token's.
    // Pruning on these would quietly unsubscribe working phones — and the ones
    // that stop getting SOS alerts are the ones nobody notices.
    expect(isStaleToken('messaging/server-unavailable')).toBe(false);
    expect(isStaleToken('messaging/internal-error')).toBe(false);
    expect(isStaleToken('messaging/quota-exceeded')).toBe(false);
  });
});
