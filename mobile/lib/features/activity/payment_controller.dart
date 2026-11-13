import 'package:atomic_commits/features/activity/data/payment_repository.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:flutter/material.dart';

class PaymentController extends ChangeNotifier {
  final PaymentRepository _paymentRepository;

  PaymentController(this._paymentRepository);

  List<PaymentModel> _payments = [];

  bool _isLoading = false;
  String? _errorMessage;

  List<PaymentModel> get payments => _payments;
  bool get isLoading => _isLoading;
  String? get errorMessage => _errorMessage;

  Future<void> loadPayments() async {
    _isLoading = true;
    _errorMessage = null;
    notifyListeners();

    try {
      _payments = await _paymentRepository.getPayments();
    } catch (e) {
      _errorMessage = 'Unable to load transactions. Please try again.';
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }
}
