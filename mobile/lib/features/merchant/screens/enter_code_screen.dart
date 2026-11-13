import 'dart:math';

import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/router.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/core/money.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:atomic_commits/features/merchant/screens/scan_qr_screen.dart';
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
  bool _walletMissing = false;
  bool _needsName = false;

  Dio get _api => getIt<ApiClient>().dio;
  bool get _currentOwner =>
      mounted && getIt<AuthController>().user?.id == _ownerId;

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

  bool _validName(String value) =>
      value.length >= 2 &&
      value.length <= 80 &&
      !RegExp(r'[\x00-\x1f\x7f]').hasMatch(value);

  void _useReceivingSetup(Map<String, dynamic> merchant) {
    final wallet = _wallet!;
    setState(() {
      _needsName = false;
      if (merchant['status'] != 'ACTIVE') {
        _ready = false;
        _message = 'Receiving payments is unavailable for this account.';
      } else if (merchant['walletAddress'] != wallet['address']) {
        _ready = false;
        _message =
            'The receiving wallet does not match your verified wallet. '
            'Review your wallet before receiving payments.';
      } else {
        _ready = true;
        _message = null;
      }
    });
  }

  Future<Map<String, dynamic>> _createReceivingSetup(String name) async {
    final response = await _api.post(
      '/merchant',
      data: {'displayName': name, 'createOnly': true},
    );
    return Map<String, dynamic>.from(response.data as Map);
  }

  Future<void> _loadWallet() async {
    if (!_currentOwner) return;
    setState(() {
      _loading = true;
      _ready = false;
      _walletMissing = false;
      _needsName = false;
      _message = null;
    });
    try {
      final response = await _api.get('/wallets');
      if (!_currentOwner) return;
      final wallets = (response.data['wallets'] as List)
          .map((item) => Map<String, dynamic>.from(item as Map)).toList();
      final receiving = wallets.where((wallet) => wallet['isDefaultReceiving'] == true);
      if (receiving.isEmpty) {
        setState(() {
          _wallet = null;
          _walletMissing = true;
          _message = 'Connect a verified wallet before receiving payments.';
        });
        return;
      }
      _wallet = receiving.first;

      final result = await _api.get('/merchant');
      if (!_currentOwner) return;
      final existing = result.data['merchant'];
      Map<String, dynamic> merchant;
      if (existing == null) {
        final name = _merchantName.text.trim();
        if (!_validName(name)) {
          setState(() => _needsName = true);
          return;
        }
        merchant = await _createReceivingSetup(name);
        if (!_currentOwner) return;
      } else {
        merchant = Map<String, dynamic>.from(existing as Map);
      }
      _useReceivingSetup(merchant);
    } catch (error) {
      if (_currentOwner) setState(() => _message = _error(error));
    } finally {
      if (_currentOwner) setState(() => _loading = false);
    }
  }

  Future<void> _activate() async {
    if (!_currentOwner || _busy) return;
    final name = _merchantName.text.trim();
    if (!_validName(name)) {
      setState(() => _message = 'Enter a name between 2 and 80 characters.');
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final merchant = await _createReceivingSetup(name);
      if (_currentOwner) _useReceivingSetup(merchant);
    } catch (error) {
      if (_currentOwner) setState(() => _message = _error(error));
    } finally {
      if (_currentOwner) setState(() => _busy = false);
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
          'receivingWalletAddress': wallet['address'],
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
      if (!_currentOwner) return;
      final ambiguous =
          error is! DioException ||
          error.response == null ||
          (error.response!.statusCode ?? 500) >= 500;
      final walletChanged = error is DioException &&
          error.response?.data is Map &&
          (error.response!.data as Map)['code'] == 'RECEIVING_WALLET_CHANGED';
      setState(() {
        _unknownSubmission = ambiguous;
        if (walletChanged) {
          _ready = false;
          _wallet = null;
          _amount.clear();
        }
        _message = walletChanged
            ? 'The receiving wallet changed. Refresh it and enter the amount again.'
            : ambiguous
            ? 'Payment outcome is unknown. Do not submit again; check payment history or contact the operator.'
            : _error(error);
      });
    } finally {
      if (_currentOwner) setState(() => _busy = false);
    }
  }

  Future<void> _refreshPayment() async {
    if (getIt<AuthController>().user?.id != _ownerId) return;
    final payment = _payment;
    if (payment == null) return;
    setState(() {
      _busy = true;
      _message = null;
    });
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
      if (_currentOwner) setState(() => _message = _error(error));
    } finally {
      if (_currentOwner) setState(() => _busy = false);
    }
  }

  Future<void> _scanCode() async {
    if (!_currentOwner || !_ready || _busy || _unknownSubmission || _payment != null) return;
    final code = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const ScanQrScreen()),
    );
    if (_currentOwner && _ready && !_busy && !_unknownSubmission && _payment == null && code != null) {
      setState(() {
        _code.text = code;
        _message = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final wallet = _wallet;
    final payment = _payment;
    const cream = AppColours.paperTop;
    const cobalt = AppColours.cobalt;
    return Scaffold(
      backgroundColor: cream,
      appBar: AppBar(
        title: const Text('Receive payment'),
        backgroundColor: cream,
        foregroundColor: cobalt,
        elevation: 0,
      ),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.screenPadding),
        children: [
          if (_loading)
            const Center(child: CircularProgressIndicator())
          else if (_walletMissing) ...[
            TextButton(
              onPressed: () => context.go(AppRoutes.wallet),
              child: const Text('Connect a wallet'),
            ),
            TextButton(onPressed: _loadWallet, child: const Text('Refresh')),
          ] else if (_needsName) ...[
            const Text('Choose the name shown when you receive payments.'),
            const SizedBox(height: 16),
            TextField(
              controller: _merchantName,
              decoration: const InputDecoration(labelText: 'Receiving name'),
            ),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: _busy ? null : _activate,
              child: _busy
                  ? const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        ),
                        SizedBox(width: 12),
                        Text('Saving...'),
                      ],
                    )
                  : const Text('Continue'),
            ),
          ] else if (!_ready) ...[
            TextButton(onPressed: _loadWallet, child: const Text('Retry')),
            if (wallet != null)
              TextButton(
                onPressed: () => context.go(AppRoutes.wallet),
                child: const Text('Review wallet'),
              ),
          ] else if (payment != null) ...[
            Text(
              payment.isCompleted
                  ? 'Payment confirmed'
                  : switch (payment.status) {
                      'FAILED' => 'Payment failed',
                      'REJECTED' => 'Payment rejected',
                      'UNKNOWN' => 'Payment status unknown',
                      _ => 'Payment processing',
                    },
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
                child: Text(_busy ? 'Checking status...' : 'Check status'),
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
              child: const Text('Check payment status'),
            ),
          ] else ...[
            Form(
              key: _formKey,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextFormField(
                    controller: _amount,
                    style: const TextStyle(
                      color: cobalt,
                      fontSize: 24,
                      fontWeight: FontWeight.w700,
                    ),
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    decoration: InputDecoration(
                      labelText: 'Purchase amount (${wallet!['assetCode']})',
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
                  OutlinedButton.icon(
                    onPressed: _busy ? null : _scanCode,
                    icon: const Icon(Icons.qr_code_scanner_rounded),
                    label: const Text('Scan QR code'),
                  ),
                  const SizedBox(height: 16),
                  TextFormField(
                    controller: _code,
                    textCapitalization: TextCapitalization.characters,
                    style: const TextStyle(
                      color: cobalt,
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1,
                    ),
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
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColours.fieldFill,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColours.fieldBorder),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Receiving wallet',
                    style: TextStyle(
                      color: cobalt,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 6),
                  SelectableText('${wallet['address']}'),
                  const SizedBox(height: 2),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton(
                      onPressed: () => context.go(AppRoutes.wallet),
                      style: TextButton.styleFrom(
                        foregroundColor: AppColours.cobalt,
                        padding: EdgeInsets.zero,
                        minimumSize: Size.zero,
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        visualDensity: VisualDensity.compact,
                        textStyle: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      child: const Text('Change receiving wallet'),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),
            ElevatedButton(
              onPressed: _busy ? null : _redeem,
              child: _busy
                  ? const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        ),
                        SizedBox(width: 12),
                        Text('Submitting...'),
                      ],
                    )
                  : const Text('Submit payment'),
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
