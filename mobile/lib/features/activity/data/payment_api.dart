import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/network/api_endpoints.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';

class PaymentApi {
  final ApiClient _apiClient;

  PaymentApi(this._apiClient);

  Future<List<PaymentModel>> getPayments() async {
    final response = await _apiClient.dio.get(ApiEndpoints.payments);

    final data = Map<String, dynamic>.from(response.data);

    final payerPayments = (data['asPayer'] as List<dynamic>? ?? []).map(
      (payment) => PaymentModel.fromJson(
        Map<String, dynamic>.from(payment),
        direction: PaymentDirection.sent,
      ),
    );

    final merchantPayments = (data['asMerchant'] as List<dynamic>? ?? []).map(
      (payment) => PaymentModel.fromJson(
        Map<String, dynamic>.from(payment),
        direction: PaymentDirection.received,
      ),
    );

    final payments = [...payerPayments, ...merchantPayments];

    payments.sort((a, b) {
      final dateA = a.displayDate;
      final dateB = b.displayDate;

      if (dateA == null) return 1;
      if (dateB == null) return -1;

      return dateB.compareTo(dateA);
    });

    return payments;
  }
}
