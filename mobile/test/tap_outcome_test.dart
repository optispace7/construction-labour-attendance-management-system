import 'package:flutter_test/flutter_test.dart';
import 'package:clams_mobile/features/attendance/data/attendance_repository.dart';
import 'package:clams_mobile/features/attendance/domain/models.dart';

/// The gate shows what the server says and nothing else. These are the
/// server's replies, read the way the screens rely on.
void main() {
  const worker = {
    'id': 'w1',
    'workerCode': 'W-0001',
    'fullName': 'Ramesh',
    'category': 'WORKER',
  };

  group('outcomeFromPreview', () {
    test('LOGIN and LOGOUT carry the worker for the confirm screen', () {
      final login = outcomeFromPreview({'action': 'LOGIN', 'worker': worker});
      expect(login.action, TapAction.login);
      expect(login.worker?.workerCode, 'W-0001');

      final logout = outcomeFromPreview({'action': 'LOGOUT', 'worker': worker});
      expect(logout.action, TapAction.logout);
    });

    test('a LOGIN with no worker is not shown as a LOGIN', () {
      // The confirm screen needs a face and a name; without them it must not
      // open at all.
      expect(outcomeFromPreview({'action': 'LOGIN'}).action, TapAction.failed);
    });

    test('too soon keeps what was blocked and the timings', () {
      final o = outcomeFromPreview({
        'action': 'TOO_SOON',
        'worker': worker,
        'blocked': 'LOGOUT',
        'remainingSeconds': 420,
        'elapsedMinutes': 3,
      });
      expect(o.action, TapAction.tooSoon);
      expect(o.blocked, TapAction.logout);
      expect(o.remainingSeconds, 420);
      expect(o.elapsedMinutes, 3);
    });

    test('duplicate, expired card and unknown badge', () {
      expect(
        outcomeFromPreview({'action': 'DUPLICATE', 'worker': worker, 'cooldownRemainingSeconds': 12})
            .cooldownRemainingSeconds,
        12,
      );
      final expired = outcomeFromPreview(
          {'action': 'CARD_EXPIRED', 'worker': worker, 'detail': 'Expired on 2026-01-01'});
      expect(expired.action, TapAction.expired);
      expect(expired.message, 'Expired on 2026-01-01');
      expect(outcomeFromPreview({'action': 'UNKNOWN_WORKER', 'worker': null}).action,
          TapAction.notFound);
    });

    test('anything unexpected is a failure, never a guess', () {
      expect(outcomeFromPreview('<html>').action, TapAction.failed);
      expect(outcomeFromPreview({'action': 'SOMETHING_NEW'}).action, TapAction.failed);
    });
  });

  group('outcomeFromTap', () {
    const picked = WorkerCard(id: 'w1', workerCode: 'W-0001', fullName: 'Ramesh');

    test('the recorded direction is what is shown', () {
      expect(outcomeFromTap({'result': 'LOGIN_RECORDED'}, worker: picked).action, TapAction.login);
      final logout = outcomeFromTap({'result': 'LOGOUT_RECORDED'}, worker: picked);
      expect(logout.action, TapAction.logout);
      // The logout reply names no worker; the one from the preview is kept.
      expect(logout.worker?.fullName, 'Ramesh');
    });

    test('a replayed scan reads as the direction it was recorded as', () {
      expect(
        outcomeFromTap({'result': 'IDEMPOTENT_REPLAY', 'tapType': 'LOGOUT'}).action,
        TapAction.logout,
      );
    });

    test('a typed entry is pending approval, including when replayed', () {
      final filed = outcomeFromTap(
        {'result': 'MANUAL_PENDING_APPROVAL', 'tapType': 'LOGOUT'},
        manualBackup: true,
      );
      expect(filed.action, TapAction.pendingApproval);
      expect(filed.blocked, TapAction.logout);

      expect(
        outcomeFromTap({'result': 'IDEMPOTENT_REPLAY', 'tapType': 'LOGIN'}, manualBackup: true)
            .action,
        TapAction.pendingApproval,
      );
    });
  });

  group('outcomeFromError', () {
    test('no answer at all is offline', () {
      expect(outcomeFromError(null, null).action, TapAction.offline);
      expect(outcomeFromError(null, null).message, isNull);
      // Already sent once without a reply: it may have landed, and the
      // watchman is told how to find out.
      expect(outcomeFromError(null, null, unsure: true).message, isNotNull);
    });

    test("the server's refusals map to the gate's dialogs", () {
      expect(
        outcomeFromError(409, {
          'code': 'DUPLICATE_TAP',
          'meta': {'cooldownRemainingSeconds': 20},
        }).cooldownRemainingSeconds,
        20,
      );

      final tooSoon = outcomeFromError(409, {
        'code': 'TAP_TOO_SOON',
        'detail': 'Ramesh logged in 2 minute(s) ago.',
        'meta': {'blocked': 'LOGIN', 'remainingSeconds': 480, 'elapsedMinutes': 2},
      });
      expect(tooSoon.action, TapAction.tooSoon);
      expect(tooSoon.blocked, TapAction.login);
      expect(tooSoon.remainingSeconds, 480);

      expect(outcomeFromError(409, {'code': 'MANUAL_REVIEW_PENDING'}).action,
          TapAction.awaitingReview);
      expect(outcomeFromError(422, {'code': 'CARD_EXPIRED'}).action, TapAction.expired);
      expect(outcomeFromError(404, {'code': 'WORKER_NOT_FOUND'}).action, TapAction.notFound);
    });

    test('any other refusal is a failure with the server\'s words', () {
      final geo = outcomeFromError(422, {
        'code': 'GEO_OUT_OF_RANGE',
        'title': 'Outside permitted geofence',
      });
      expect(geo.action, TapAction.failed);
      expect(geo.message, 'Outside permitted geofence');

      expect(outcomeFromError(500, 'oops').message, contains('HTTP 500'));
    });
  });
}
