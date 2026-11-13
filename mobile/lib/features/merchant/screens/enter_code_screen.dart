import 'dart:math';

import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/router.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/core/money.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class EnterCodeScreen extends StatefulWidget {
  const EnterCodeScreen({super.key});

  @override
  State<EnterCodeScreen> createState() => _EnterCodeScreenState();
}

class _EnterCodeScreenState extends State<EnterCodeScreen> {
  final _formKey = GlobalKey<FormState>();
  final _amount = TextEditingController();
  final _code = TextEditingController();
  late final TextEditingController _merchantName;
  late final int _ownerId;
  Map<String, dynamic>? _wallet;
  PaymentModel? _payment;
  String? _message;
  bool _loading = true;
  bool _ready = false;
  bool _busy = false;
  bool _unknownSubmission = false;

  Dio get _api => getIt<ApiClient>().dio;

  @override
  void initState() {
    super.initState();
    _ownerId = getIt<AuthController>().user!.id;
    _merchantName = TextEditingController(
      text: getIt<AuthController>().user?.name ?? '',
    );
    _loadWallet();
  }

  @override
  void dispose() {
    _amount.dispose();
    _code.dispose();
    _merchantName.dispose();
    super.dispose();
  }

  String _error(Object error) {
    if (error is DioException && error.response?.data is Map) {
      final message = (error.response!.data as Map)['error'];
      if (message is String) return message;
    }
    return 'Could not reach the server. Check your connection.';
  }

  Future<void> _loadWallet() async {
    try {
      final response = await _api.get('/wallet');
      final wallet = response.data['wallet'];
      if (mounted && getIt<AuthController>().user?.id == _ownerId) {
        setState(() {
          _wallet = wallet == null
              ? null
              : Map<String, dynamic>.from(wallet as Map);
          _loading = false;
          _message = wallet == null
              ? 'Connect a verified wallet before activating checkout.'
              : null;
        });
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _loading = false;
          _message = _error(error);
        });
      }
    }
  }

  Future<void> _activate() async {
    if (getIt<AuthController>().user?.id != _ownerId) return;
    final name = _merchantName.text.trim();
    if (name.length < 2 || name.length > 80) {
      setState(
        () => _message = 'Enter a merchant name between 2 and 80 characters.',
      );
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await _api.post('/merchant', data: {'displayName': name});
      if (mounted && getIt<AuthController>().user?.id == _ownerId) {
        setState(() => _ready = true);
      }
    } catch (error) {
      if (mounted) setState(() => _message = _error(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _idempotencyKey() {
    final random = Random.secure();
    return List.generate(
      16,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
  }

  Future<void> _redeem() async {
    if (getIt<AuthController>().user?.id != _ownerId) return;
    if (_busy || _unknownSubmission || _payment != null) return;
    if (!_formKey.currentState!.validate()) return;
    final wallet = _wallet!;
    final minor = parseMinorAmount(_amount.text, wallet['assetScale'] as int)!;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final response = await _api.post(
        '/offline-redemptions',
        options: Options(
          headers: {'Idempotency-Key': _idempotencyKey()},
          receiveTimeout: const Duration(seconds: 90),
        ),
        data: {
          'credentialType': 'totp-v1',
          'paymentCode': _code.text.trim().toUpperCase(),
          'merchantReceive': {
            'value': minor,
            'assetCode': wallet['assetCode'],
            'assetScale': wallet['assetScale'],
          },
        },
      );
      if (mounted && getIt<AuthController>().user?.id == _ownerId) {
        setState(
          () => _payment = PaymentModel.fromJson(
            Map<String, dynamic>.from(response.data as Map),
            direction: PaymentDirection.received,
          ),
        );
      }
    } catch (error) {
      if (!mounted) return;
      final ambiguous =
          error is! DioException ||
          error.response == null ||
          (error.response!.statusCode ?? 500) >= 500;
      setState(() {
        _unknownSubmission = ambiguous;
        _message = ambiguous
            ? 'Payment outcome is unknown. Do not submit again; check payment history or contact the operator.'
            : _error(error);
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refreshPayment() async {
    if (getIt<AuthController>().user?.id != _ownerId) return;
    final payment = _payment;
    if (payment == null) return;
    setState(() => _busy = true);
    try {
      final response = await _api.get(
        '/payments/${payment.paymentId}',
        options: Options(receiveTimeout: const Duration(seconds: 45)),
      );
      if (mounted && getIt<AuthController>().user?.id == _ownerId) {
        setState(
          () => _payment = PaymentModel.fromJson(
            Map<String, dynamic>.from(response.data as Map),
            direction: PaymentDirection.received,
          ),
        );
      }
    } catch (error) {
      if (mounted) setState(() => _message = _error(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final wallet = _wallet;
    final payment = _payment;
    return Scaffold(
      appBar: AppBar(title: const Text('Merchant checkout')),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.screenPadding),
        children: [
          if (_loading)
            const Center(child: CircularProgressIndicator())
          else if (wallet == null) ...[
            TextButton(
              onPressed: () => context.go(AppRoutes.wallet),
              child: const Text('Open wallet onboarding'),
            ),
            TextButton(onPressed: _loadWallet, child: const Text('Refresh')),
          ] else if (!_ready) ...[
            const Text('Payments will be received by your verified wallet:'),
            SelectableText(wallet['address'] as String),
            const SizedBox(height: 16),
            TextField(
              controller: _merchantName,
              decoration: const InputDecoration(labelText: 'Merchant name'),
            ),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: _busy ? null : _activate,
              child: const Text('Activate merchant checkout'),
            ),
          ] else if (payment != null) ...[
            Text(
              payment.isCompleted
                  ? 'Payment confirmed'
                  : 'Payment ${payment.displayStatus.toLowerCase()}',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 12),
            Text(payment.outcomeMessage),
            const SizedBox(height: 12),
            SelectableText('Payment reference: ${payment.paymentId}'),
            if (payment.providerIncomingRef != null)
              SelectableText(
                'Provider incoming payment: ${payment.providerIncomingRef}',
              ),
            if (!payment.isCompleted &&
                !['FAILED', 'REJECTED'].contains(payment.status))
              TextButton(
                onPressed: _busy ? null : _refreshPayment,
                child: const Text('Check status'),
              ),
            if (payment.isCompleted ||
                ['FAILED', 'REJECTED'].contains(payment.status))
              TextButton(
                onPressed: () => setState(() {
                  _payment = null;
                  _code.clear();
                  _amount.clear();
                }),
                child: const Text('New checkout'),
              ),
          ] else if (_unknownSubmission) ...[
            TextButton(
              onPressed: () => context.go(AppRoutes.activity),
              child: const Text('Open payment history'),
            ),
          ] else ...[
            Text('Receiving wallet: ${wallet['address']}'),
            const SizedBox(height: 16),
            Form(
              key: _formKey,
              child: Column(
                children: [
                  TextFormField(
                    controller: _amount,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    decoration: InputDecoration(
                      labelText: 'Purchase amount (${wallet['assetCode']})',
                    ),
                    validator: (value) =>
                        parseMinorAmount(
                              value ?? '',
                              wallet['assetScale'] as int,
                            ) ==
                            null
                        ? 'Enter a positive amount with the correct decimal places.'
                        : null,
                  ),
                  const SizedBox(height: 16),
                  TextFormField(
                    controller: _code,
                    textCapitalization: TextCapitalization.characters,
                    decoration: const InputDecoration(
                      labelText: 'Customer payment code',
                      hintText: 'ABC234-123456',
                    ),
                    validator: (value) =>
                        RegExp(r'^[A-Z0-9]{4,12}-[0-9]{6}$')
                            .hasMatch((value ?? '').trim().toUpperCase())
                        ? null
                        : 'Enter the complete code, including the prefix.',
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            ElevatedButton(
              onPressed: _busy ? null : _redeem,
              child: const Text('Submit payment'),
            ),
          ],
          if (_message != null)
            Padding(
              padding: const EdgeInsets.only(top: 16),
              child: Text(_message!),
            ),
        ],
      ),
    );
  }
}
