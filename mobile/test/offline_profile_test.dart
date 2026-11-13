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
}
