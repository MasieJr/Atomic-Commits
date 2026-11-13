import 'package:atomic_commits/features/payer/offline_profile.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const profile = OfflineProfile(
    prefix: 'ABC234',
    secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    expiresAtEpochMs: 4102444800000,
  );

  test(
    'offline decimal TOTP matches RFC vectors and rotates at the boundary',
    () {
      OfflineCode at(int seconds) => profile.codeAt(
        DateTime.fromMillisecondsSinceEpoch(seconds * 1000, isUtc: true),
      );
      expect(at(59).value, 'ABC234-287082');
      expect(at(1111111109).value, 'ABC234-081804');
      expect(at(1111111111).value, 'ABC234-050471');
      expect(at(59).expiresAt.millisecondsSinceEpoch, 60000);
      expect(at(60).value, isNot(at(59).value));
    },
  );

  test('long 30-minute codes rotate on 1800s steps and expire at step end', () {
    OfflineCode longAt(int ms) => profile.codeAt(
          DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true),
          periodMs: 1800000,
        );
    // Stable across the whole first long bucket after step 0.
    expect(longAt(0).value, longAt(900000).value);
    expect(longAt(0).value, longAt(1799999).value);
    expect(longAt(0).expiresAt.millisecondsSinceEpoch, 1800000);
    // Rotates at the long boundary.
    expect(longAt(1800000).value, isNot(longAt(0).value));
    expect(longAt(1800000).expiresAt.millisecondsSinceEpoch, 3600000);
    // Same instant, default 30s period → different step/code than long step 0
    // only when counters diverge (t > 0 short step differs from long step 0).
    expect(
      profile.codeAt(DateTime.fromMillisecondsSinceEpoch(60000, isUtc: true)).value,
      isNot(longAt(0).value),
    );
    expect(
      () => profile.codeAt(DateTime.fromMillisecondsSinceEpoch(0), periodMs: 0),
      throwsArgumentError,
    );
  });

  test('secure device profiles are scoped to the signed-in user', () async {
    FlutterSecureStorage.setMockInitialValues({});
    const store = OfflineProfileStore();
    await store.save(1, profile);
    expect((await store.read(1))?.prefix, 'ABC234');
    expect(await store.read(2), isNull);
    await store.delete(1);
    expect(await store.read(1), isNull);
  });

  test('an expired or malformed profile cannot produce a code', () {
    final expired = OfflineProfile.fromJson({
      ...profile.toJson(),
      'expiresAtEpochMs': 30000,
    });
    expect(
      () => expired.codeAt(DateTime.fromMillisecondsSinceEpoch(30000)),
      throwsStateError,
    );
    expect(
      () => OfflineProfile.fromJson({...profile.toJson(), 'secret': 'bad'}),
      throwsFormatException,
    );
  });

  test('a stored device can display its original per-payment limit', () {
    final saved = OfflineProfile.fromJson({
      ...profile.toJson(),
      'permissionLimit': 'ZAR 200.00',
    });
    expect(
      OfflineProfile.fromJson(saved.toJson()).permissionLimit,
      'ZAR 200.00',
    );
    expect(OfflineProfile.fromJson(profile.toJson()).permissionLimit, isNull);
  });
}
