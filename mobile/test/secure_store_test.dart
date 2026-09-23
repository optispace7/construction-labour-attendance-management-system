import 'package:clams_mobile/core/storage/secure_store.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

/// Stands in for the plugin with a keystore that is broken until it is wiped —
/// the state that made sign-in fail on 23 Sep 2026.
class _BrokenUntilReset extends FlutterSecureStorage {
  _BrokenUntilReset({this.alwaysBroken = false});

  final bool alwaysBroken;
  bool broken = true;
  final values = <String, String>{};

  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (broken) {
      throw PlatformException(
        code: 'Exception encountered',
        message: "Attempt to invoke interface method 'byte[] StorageCipher.encrypt(byte[])' "
            'on a null object reference',
      );
    }
    values[key] = value!;
  }

  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      values[key];

  @override
  Future<void> deleteAll({
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    values.clear();
    if (!alwaysBroken) broken = false;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a broken keystore is wiped and the sign-in token saved after all', () async {
    final storage = _BrokenUntilReset();
    final store = SecureStore(storage);

    await store.saveSession('session-token');

    expect(await store.accessToken, 'session-token');
  });

  test('a store that stays broken after the wipe still reports the failure', () async {
    // Login must say it failed rather than pretend the phone is signed in.
    final store = SecureStore(_BrokenUntilReset(alwaysBroken: true));
    expect(store.saveSession('session-token'), throwsA(isA<PlatformException>()));
  });
}
