import 'package:atomic_commits/core/money.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'money formatting preserves exact minor units for any supported scale',
    () {
      expect(
        const PaymentAmount(
          value: '123456789012345678',
          assetCode: 'USD',
          assetScale: 2,
        ).formatted,
        'USD 1234567890123456.78',
      );
      expect(
        const PaymentAmount(
          value: '1',
          assetCode: 'X',
          assetScale: 5,
        ).formatted,
        'X 0.00001',
      );
      expect(parseMinorAmount('1.234', 3), '1234');
      expect(parseMinorAmount('1.234', 2), isNull);
      expect(parseMinorAmount('0', 2), isNull);
    },
  );

  test(
    'success requires confirmed amounts and the provider receipt reference',
    () {
      const pending = PaymentModel(
        paymentId: '1',
        status: 'UNKNOWN',
        direction: PaymentDirection.received,
      );
      const incomplete = PaymentModel(
        paymentId: '2',
        status: 'SUCCEEDED',
        direction: PaymentDirection.received,
      );
      const amount = PaymentAmount(
        value: '10',
        assetCode: 'USD',
        assetScale: 2,
      );
      const confirmed = PaymentModel(
        paymentId: '3',
        status: 'SUCCEEDED',
        direction: PaymentDirection.received,
        payerDebitPaid: amount,
        merchantReceivePaid: amount,
        providerIncomingRef: 'https://provider.test/incoming/3',
      );
      expect(pending.isCompleted, isFalse);
      expect(incomplete.isCompleted, isFalse);
      expect(incomplete.displayStatus, 'Confirmation incomplete');
      expect(confirmed.isCompleted, isTrue);
    },
  );

  test('failed and rejected payments explain their actual outcome', () {
    const rejected = PaymentModel(
      paymentId: '4',
      status: 'REJECTED',
      errorCode: 'QUOTE_EXCEEDS_LIMIT',
      direction: PaymentDirection.received,
    );
    const failed = PaymentModel(
      paymentId: '5',
      status: 'FAILED',
      errorCode: 'PROVIDER_FAILED',
      direction: PaymentDirection.received,
    );
    const unknown = PaymentModel(
      paymentId: '6',
      status: 'UNKNOWN',
      direction: PaymentDirection.received,
    );
    expect(rejected.outcomeMessage, contains('exceeds'));
    expect(failed.outcomeMessage, contains('provider reported'));
    expect(unknown.outcomeMessage, contains('Do not submit'));
  });
}
