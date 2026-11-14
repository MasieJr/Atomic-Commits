import 'package:atomic_commits/features/activity/data/payment_api.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';

class PaymentRepository {
  final PaymentApi _paymentApi;

  PaymentRepository(this._paymentApi);

  Future<List<PaymentModel>> getPayments() {
    return _paymentApi.getPayments();
  }
}
