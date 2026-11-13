import 'package:atomic_commits/features/activity/data/payment_api.dart';
import 'package:atomic_commits/features/activity/data/activity_cache.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:dio/dio.dart';

class PaymentRepository {
  final PaymentApi _paymentApi;
  final Set<(String, int)> _rejectedAccounts = {};
  final Map<(String, int), int> _rejectionVersions = {};

  PaymentRepository(this._paymentApi);

  Future<List<PaymentModel>> getPayments() {
    return _paymentApi.getPayments();
  }

  Future<ActivitySnapshot> getActivity({
    required String origin,
    required int userId,
    required bool Function() isCurrent,
    bool allowCache = true,
  }) async {
    final cache = ActivityCache();
    final account = (Uri.parse(origin).origin, userId);
    final version = _rejectionVersions[account] ?? 0;
    bool current() => isCurrent() && (_rejectionVersions[account] ?? 0) == version;
    try {
      final payments = await _paymentApi.getPayments();
      if (!current()) throw StateError('Account changed or authorization rejected');
      _rejectedAccounts.remove(account);
      final result = ActivitySnapshot(payments, DateTime.now().toUtc(), cached: false);
      try {
        await cache.write(origin, userId, result, isCurrent: current);
      } catch (_) {
        // A storage failure must not hide a successful network response.
      }
      if (!current()) throw StateError('Account changed or authorization rejected');
      return result;
    } on DioException catch (error) {
      if (isCurrent() && (error.response?.statusCode == 401 || error.response?.statusCode == 403)) {
        _rejectedAccounts.add(account);
        _rejectionVersions[account] = (_rejectionVersions[account] ?? 0) + 1;
        try {
          await cache.purge(origin, userId);
        } catch (_) {
          // The cache remains blocked in this process if deletion fails.
        }
      }
      if (!allowCache || _rejectedAccounts.contains(account) || !current() || error.response != null ||
          !{DioExceptionType.connectionError, DioExceptionType.connectionTimeout,
            DioExceptionType.receiveTimeout, DioExceptionType.sendTimeout}.contains(error.type)) {
        rethrow;
      }
      final cached = await cache.read(origin, userId);
      if (!current() || _rejectedAccounts.contains(account) || cached == null) rethrow;
      return cached;
    }
  }
}
