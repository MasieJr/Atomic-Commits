import 'dart:convert';

import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/network/api_endpoints.dart';
import 'package:atomic_commits/core/money.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:atomic_commits/features/payer/device_settings_sheet.dart';
import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:url_launcher/url_launcher.dart';

class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key});

  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen>
    with WidgetsBindingObserver {
  Map<String, dynamic>? _wallet;
  List<dynamic> _grants = [];
  String? _approvalId;
  String? _approvalKind;
  String? _authorizationUrl;
  String? _message;
  bool _loading = true;
  bool _walletAvailable = false;
  bool _busy = false;
  static const _storage = FlutterSecureStorage();
  late final int _ownerId;

  Dio get _api => getIt<ApiClient>().dio;
  String get _pendingKey =>
      'wallet_approval_${sha256.convert(utf8.encode(ApiEndpoints.baseUrl))}_$_ownerId';

  @override
  void initState() {
    super.initState();
    _ownerId = getIt<AuthController>().user!.id;
    WidgetsBinding.instance.addObserver(this);
    _restoreApproval();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _restoreApproval() async {
    var failed = false;
    try {
      final saved = await _storage.read(key: _pendingKey);
      if (saved != null) {
        final approval = jsonDecode(saved) as Map<String, dynamic>;
        _approvalId = approval['id'] as String;
        _approvalKind = approval['kind'] as String;
        _authorizationUrl = approval['url'] as String;
      }
    } catch (_) {
      failed = true;
    }
    await _refresh();
    if (failed && mounted && getIt<AuthController>().user?.id == _ownerId) {
      setState(
        () => _message = 'Could not restore a pending approval. Check your wallet before starting again.',
      );
    }
  }

  Future<void> _refresh() async {
    if (!mounted || getIt<AuthController>().user?.id != _ownerId) return;
    try {
      String? message;
      if (_approvalId != null) {
        final path = _approvalKind == 'wallet'
            ? '/wallet/approvals/$_approvalId'
            : '/payment-grants/approvals/$_approvalId';
        final approval = await _api.get(path);
        final status = approval.data['status'] as String;
        if (status == 'VERIFIED' || status == 'APPROVED') {
          message = status == 'VERIFIED' ? 'Wallet verified.' : 'Spending permission approved. Enroll your device against it from Send.';
          _approvalId = null;
          _authorizationUrl = null;
          await _storage.delete(key: _pendingKey);
        } else if (['FAILED', 'DENIED', 'EXPIRED'].contains(status)) {
          message = 'Provider approval $status. Please start again.';
          _approvalId = null;
          _authorizationUrl = null;
          await _storage.delete(key: _pendingKey);
        } else {
          message = 'Waiting for provider approval. Return here and refresh after consenting.';
        }
      }
      final response = await _api.get('/wallet');
      final value = response.data['wallet'];
      final wallet = value == null
          ? null
          : Map<String, dynamic>.from(value as Map);
      List<dynamic> grants = [];
      if (wallet != null) {
        final result = await _api.get('/payment-grants');
        grants = List<dynamic>.from(result.data['grants'] as List);
      }
      if (!mounted || getIt<AuthController>().user?.id != _ownerId) return;
      setState(() {
        _wallet = wallet;
        _grants = grants;
        _loading = false;
        _walletAvailable = true;
        _message = message;
      });
    } catch (error) {
      if (!mounted || getIt<AuthController>().user?.id != _ownerId) return;
      setState(() {
        _loading = false;
        _walletAvailable = false;
        _message = _errorMessage(error);
      });
    }
  }

  String _errorMessage(Object error) {
    if (error is DioException && error.response?.data is Map) {
      final message = (error.response!.data as Map)['error'];
      if (message is String) return message;
    }
    return 'Could not reach the server. Check your connection and try again.';
  }

  Future<void> _openProvider(String value) async {
    final uri = Uri.tryParse(value);
    if (uri == null ||
        uri.scheme != 'https' ||
        !uri.host.endsWith('.interledger-test.dev')) {
      throw StateError('The provider returned an invalid approval URL.');
    }
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      throw StateError('Could not open the wallet provider.');
    }
  }

  Future<void> _connectWallet() async {
    var input = '';
    final address = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) => _walletSheet(
        context,
        title: 'Connect a wallet',
        action: 'Verify ownership',
        onContinue: () => Navigator.pop(context, input.trim()),
        children: [
          const Text('Enter your Test Wallet address to verify ownership.'),
          const SizedBox(height: 16),
          TextField(
            onChanged: (value) => input = value,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(
              labelText: 'Test Wallet address',
              hintText: r'$ilp.interledger-test.dev/name',
            ),
          ),
        ],
      ),
    );
    if (address == null ||
        address.isEmpty ||
        !mounted ||
        getIt<AuthController>().user?.id != _ownerId) {
      return;
    }
    await _beginApproval('/wallet/approvals', {
      'walletAddress': address,
    }, 'wallet');
  }

  Future<void> _requestGrant() async {
    final wallet = _wallet;
    if (wallet == null) return;
    var cap = '';
    var limit = '';
    final result = await showModalBottomSheet<(String, String)>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) => _walletSheet(
        context,
        title: 'Spending permission',
        action: 'Review',
        onContinue: () => Navigator.pop(context, (cap, limit)),
        children: [
          Text(
            'Set limits in ${wallet['assetCode']}. Your wallet provider will ask for consent.',
          ),
          const SizedBox(height: 16),
          TextField(
            onChanged: (value) => cap = value,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Total allowance'),
          ),
          const SizedBox(height: 12),
          TextField(
            onChanged: (value) => limit = value,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Maximum per payment'),
          ),
        ],
      ),
    );
    if (result == null || !mounted) return;
    final scale = wallet['assetScale'] as int;
    final cumulative = parseMinorAmount(result.$1, scale);
    final perPayment = parseMinorAmount(result.$2, scale);
    if (cumulative == null ||
        perPayment == null ||
        BigInt.parse(perPayment) > BigInt.parse(cumulative)) {
      setState(
        () => _message = 'Enter positive amounts; the per-payment limit cannot exceed the allowance.',
      );
      return;
    }
    final approved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) => _walletSheet(
        context,
        title: 'Review permission',
        action: 'Continue',
        onContinue: () => Navigator.pop(context, true),
        children: [
          Text(
            'Allow up to ${result.$1} ${wallet['assetCode']} in total, with a maximum of ${result.$2} ${wallet['assetCode']} per payment. Continue to your wallet provider to approve.',
          ),
        ],
      ),
    );
    if (approved == true &&
        mounted &&
        getIt<AuthController>().user?.id == _ownerId) {
      await _beginApproval('/payment-grants', {
        'cumulativeCap': cumulative,
        'perPaymentMaxDebit': perPayment,
      }, 'grant');
    }
  }

  Widget _walletSheet(
    BuildContext context, {
    required String title,
    required String action,
    required VoidCallback onContinue,
    required List<Widget> children,
  }) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Container(
        decoration: const BoxDecoration(
          color: AppColours.paperTop,
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
        child: SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: Container(
                    width: 40,
                    height: 4,
                    decoration: BoxDecoration(
                      color: AppColours.orange,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                const SizedBox(height: 20),
                Text(
                  title,
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    color: AppColours.ink,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 12),
                ...children,
                const SizedBox(height: 24),
                FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColours.cobalt,
                    foregroundColor: Colors.white,
                  ),
                  onPressed: onContinue,
                  child: Text(action),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Cancel'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _beginApproval(
    String path,
    Map<String, String> body,
    String kind,
  ) async {
    if (_busy || !mounted || getIt<AuthController>().user?.id != _ownerId) {
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final response = await _api.post(
        path,
        data: body,
        options: Options(receiveTimeout: const Duration(seconds: 45)),
      );
      final url = response.data['authorizationUrl'] as String;
      _approvalId = response.data['approvalId'] as String;
      _approvalKind = kind;
      _authorizationUrl = url;
      await _storage.write(
        key: _pendingKey,
        value: jsonEncode({
          'id': _approvalId,
          'kind': _approvalKind,
          'url': _authorizationUrl,
        }),
      );
      if (!mounted || getIt<AuthController>().user?.id != _ownerId) return;
      await _openProvider(url);
      if (mounted) {
        setState(
          () => _message =
              'Complete approval with the provider, then return and refresh.',
        );
      }
    } catch (error) {
      if (mounted) {
        setState(
          () => _message = error is StateError
              ? error.message
              : _errorMessage(error),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColours.paperTop,
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(AppSpacing.screenPadding),
          children: [
            const SizedBox(height: 12),
            Text(
              'Wallets',
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                color: AppColours.ink,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 24),
            OutlinedButton.icon(
              onPressed: () {
                if (getIt<AuthController>().user?.id != _ownerId) return;
                showModalBottomSheet<void>(
                  context: context,
                  isScrollControlled: true,
                  backgroundColor: Colors.transparent,
                  builder: (_) => DeviceSettingsSheet(ownerId: _ownerId),
                );
              },
              icon: const Icon(Icons.phonelink_setup_outlined),
              label: const Text('Devices'),
            ),
            const SizedBox(height: 24),
            if (_loading)
              const Center(child: CircularProgressIndicator())
            else if (!_walletAvailable)
              const Text(
                'Wallet status is unavailable. Connect to the server and refresh.',
              )
            else if (_wallet == null) ...[
              const Text(
                'No verified wallet connected.',
                style: TextStyle(color: AppColours.subtle),
              ),
              const SizedBox(height: 12),
              ElevatedButton.icon(
                onPressed: _busy
                    ? null
                    : () async {
                        try {
                          await _openProvider(
                            'https://wallet.interledger-test.dev/auth/signup',
                          );
                        } catch (_) {
                          if (mounted) {
                            setState(
                              () => _message = 'Could not open the Test Wallet registration page.',
                            );
                          }
                        }
                      },
                icon: const Icon(Icons.open_in_new),
                label: const Text('Create a new wallet'),
              ),
              OutlinedButton.icon(
                onPressed: _busy ? null : _connectWallet,
                icon: const Icon(Icons.link),
                label: const Text('Connect an existing wallet'),
              ),
            ] else ...[
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: AppColours.fieldFill,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: AppColours.fieldBorder),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      Icons.account_balance_wallet_outlined,
                      color: AppColours.cobalt,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            _wallet!['publicName'] as String? ??
                                'Verified wallet',
                            style: const TextStyle(
                              color: AppColours.ink,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 4),
                          SelectableText(
                            _wallet!['address'] as String,
                            style: const TextStyle(
                              color: AppColours.subtle,
                              fontSize: 12,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'Verified · ${_wallet!['assetCode']}',
                            style: const TextStyle(
                              color: AppColours.subtle,
                              fontSize: 12,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 24),
              Text(
                'Spending permissions',
                style: Theme.of(context).textTheme.titleLarge?.copyWith(
                  color: AppColours.ink,
                  fontWeight: FontWeight.w800,
                ),
              ),
              if (_grants.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 12),
                  child: Text('No spending permissions yet.'),
                ),
              for (final grant in _grants)
                Container(
                  margin: const EdgeInsets.only(top: 12),
                  decoration: BoxDecoration(
                    color: AppColours.fieldFill,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: AppColours.fieldBorder),
                  ),
                  child: ExpansionTile(
                    title: Text(
                      '${_grantAmount(grant['remaining'])} remaining',
                      style: const TextStyle(
                        color: AppColours.ink,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    subtitle: Text(
                      '${grant['status']} · ${grant['authoritySource'] == 'PROVIDER' ? 'Provider' : 'Not provider-authorized'}',
                      style: const TextStyle(
                        color: AppColours.subtle,
                        fontSize: 12,
                      ),
                    ),
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                        child: Column(
                          children: [
                            _permissionRow(
                              'Approved',
                              _grantAmount(grant['cumulativeCap']),
                            ),
                            _permissionRow(
                              'Spent',
                              _grantAmount(grant['spent']),
                            ),
                            _permissionRow(
                              'Reserved',
                              _grantAmount(grant['reserved']),
                            ),
                            _permissionRow(
                              'Remaining',
                              _grantAmount(grant['remaining']),
                            ),
                            _permissionRow(
                              'Maximum per payment',
                              _grantAmount(grant['perPaymentMaxDebit']),
                            ),
                            _permissionRow(
                              'Valid until',
                              '${grant['validUntil']}',
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              const SizedBox(height: 12),
              ElevatedButton.icon(
                onPressed: _busy ? null : _requestGrant,
                icon: const Icon(Icons.verified_user_outlined),
                label: const Text('Authorize spending'),
              ),
              TextButton(
                onPressed: () async {
                  try {
                    await _openProvider('https://wallet.interledger-test.dev/');
                  } catch (_) {
                    if (mounted) {
                      setState(
                        () =>
                            _message = 'Could not open the provider dashboard.',
                      );
                    }
                  }
                },
                child: const Text('Open provider dashboard'),
              ),
              const Text(
                'Wallet balance is available from your provider.',
                style: TextStyle(color: AppColours.subtle),
              ),
            ],
            if (_message != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: AppColours.paperMid,
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Text(
                    _message!,
                    style: const TextStyle(color: AppColours.ink),
                  ),
                ),
              ),
            if (_authorizationUrl != null) ...[
              TextButton(
                onPressed: () async {
                  try {
                    await _openProvider(_authorizationUrl!);
                  } catch (_) {
                    if (mounted) {
                      setState(
                        () => _message = 'Could not open the approval link.',
                      );
                    }
                  }
                },
                child: const Text('Open approval again'),
              ),
            ],
            TextButton.icon(
              onPressed: _busy ? null : _refresh,
              icon: const Icon(Icons.refresh),
              label: const Text('Refresh status'),
            ),
          ],
        ),
      ),
    );
  }

  String _grantAmount(dynamic amount) {
    try {
      return PaymentAmount.fromJson(Map<String, dynamic>.from(amount as Map))
          .formatted;
    } catch (_) {
      return 'Unavailable';
    }
  }

  Widget _permissionRow(String label, String value) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Text(
            label,
            style: const TextStyle(color: AppColours.subtle, fontSize: 13),
          ),
        ),
        const SizedBox(width: 12),
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.right,
            style: const TextStyle(
              color: AppColours.ink,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    ),
  );
}
