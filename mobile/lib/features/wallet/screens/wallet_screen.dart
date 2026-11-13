import 'dart:convert';

import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/network/api_endpoints.dart';
import 'package:atomic_commits/core/money.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
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
          message = status == 'VERIFIED'
              ? 'Wallet verified.'
              : 'Spending permission approved.';
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
    final address = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Connect a wallet'),
        content: TextField(
          onChanged: (value) => input = value,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(
            labelText: 'Test Wallet address',
            hintText: r'$ilp.interledger-test.dev/name',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, input.trim()),
            child: const Text('Verify ownership'),
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
    final result = await showDialog<(String, String)>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Spending permission'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Set limits in ${wallet['assetCode']}. Your wallet provider will ask for consent.',
            ),
            TextField(
              onChanged: (value) => cap = value,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: const InputDecoration(labelText: 'Total allowance'),
            ),
            TextField(
              onChanged: (value) => limit = value,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: const InputDecoration(
                labelText: 'Maximum per payment',
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, (cap, limit)),
            child: const Text('Review'),
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
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Review permission'),
        content: Text(
          'Allow up to ${result.$1} ${wallet['assetCode']} in total, with a maximum of ${result.$2} ${wallet['assetCode']} per payment. Continue to your wallet provider to approve.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Continue'),
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
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.screenPadding),
          children: [
            const SizedBox(height: 12),
            Text(
              'Your wallet',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 6),
            const Text(
              'Manage your wallet and payment permissions.',
              style: TextStyle(color: AppColours.textSecondary),
            ),
            const SizedBox(height: 24),
            if (_loading)
              const Center(child: CircularProgressIndicator())
            else if (!_walletAvailable)
              const Text(
                'Wallet status is unavailable. Connect to the server and refresh.',
              )
            else if (_wallet == null) ...[
              const Card(
                child: Padding(
                  padding: EdgeInsets.all(20),
                  child: Text(
                    'No verified wallet is connected. Create a Test Wallet account or connect an existing wallet.',
                  ),
                ),
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
              Card(
                color: AppColours.surfaceMuted,
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Icon(
                        Icons.verified_user_outlined,
                        color: AppColours.primary,
                      ),
                      const SizedBox(height: 12),
                      const Text(
                        'Verified wallet',
                        style: TextStyle(fontWeight: FontWeight.bold),
                      ),
                      if (_wallet!['publicName'] != null)
                        Text(_wallet!['publicName'] as String),
                      SelectableText(_wallet!['address'] as String),
                      Text('Asset: ${_wallet!['assetCode']}'),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 20),
              Text(
                'Spending permissions',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              if (_grants.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 12),
                  child: Text('No spending permissions yet.'),
                ),
              for (final grant in _grants)
                Card(
                  child: ListTile(
                    title: Text(
                      '${grant['status']} · ${grant['authoritySource']}',
                    ),
                    subtitle: Text(
                      'Allowance: ${grant['cumulativeCap']['value']} minor units\n'
                      'Per payment: ${grant['perPaymentMaxDebit']['value']} minor units\n'
                      'Valid until: ${grant['validUntil']}',
                    ),
                  ),
                ),
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
                style: TextStyle(color: AppColours.textSecondary),
              ),
            ],
            if (_message != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(_message!),
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
}
