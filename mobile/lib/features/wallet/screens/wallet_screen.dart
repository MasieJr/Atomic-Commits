import 'dart:async';
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
  bool _restoring = true;
  bool _refreshing = false;
  bool _foreground = true;
  Timer? _approvalTimer;
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
    _approvalTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground) {
      _refresh();
    } else {
      _approvalTimer?.cancel();
    }
  }

  Future<void> _restoreApproval() async {
    var failed = false;
    try {
      final saved = await _storage.read(key: _pendingKey);
      if (saved != null &&
          mounted &&
          getIt<AuthController>().user?.id == _ownerId) {
        final approval = jsonDecode(saved) as Map<String, dynamic>;
        final id = approval['id'];
        final kind = approval['kind'];
        final url = approval['url'];
        if (id is! String ||
            id.isEmpty ||
            kind is! String ||
            (kind != 'wallet' && kind != 'grant') ||
            url is! String ||
            url.isEmpty) {
          throw const FormatException('Invalid saved approval');
        }
        _approvalId = id;
        _approvalKind = kind;
        _authorizationUrl = url;
      }
    } catch (_) {
      failed = true;
    } finally {
      _restoring = false;
    }
    await _refresh();
    if (failed && mounted && getIt<AuthController>().user?.id == _ownerId) {
      setState(
        () => _message = 'Could not restore a pending approval. Check your wallet before starting again.',
      );
    }
  }

  Future<void> _refresh() async {
    if (_restoring ||
        !mounted ||
        getIt<AuthController>().user?.id != _ownerId) {
      return;
    }
    if (_busy) {
      _scheduleApprovalCheck();
      return;
    }
    if (_refreshing) return;
    _approvalTimer?.cancel();
    setState(() => _refreshing = true);
    try {
      String? message;
      final checkingId = _approvalId;
      if (checkingId != null) {
        final path = _approvalKind == 'wallet'
            ? '/wallet/approvals/$checkingId'
            : '/payment-grants/approvals/$checkingId';
        final approval = await _api.get(path);
        if (!mounted ||
            getIt<AuthController>().user?.id != _ownerId ||
            _approvalId != checkingId) {
          return;
        }
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
    } finally {
      if (mounted) {
        setState(() => _refreshing = false);
      } else {
        _refreshing = false;
      }
      _scheduleApprovalCheck();
    }
  }

  void _scheduleApprovalCheck() {
    _approvalTimer?.cancel();
    if (mounted &&
        _foreground &&
        _approvalId != null &&
        getIt<AuthController>().user?.id == _ownerId) {
      _approvalTimer = Timer(const Duration(seconds: 20), _refresh);
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
            'Set a total limit in ${wallet['assetCode']}. Your wallet provider will ask for consent.',
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
          const SizedBox(height: 12),
          const Text(
            'App access lasts up to 30 days. The total limit does not reset, and your provider may end access sooner.',
            style: TextStyle(color: AppColours.subtle),
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
    if (_busy ||
        _restoring ||
        _refreshing ||
        _approvalId != null ||
        !mounted ||
        getIt<AuthController>().user?.id != _ownerId) {
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
      setState(() {});
      _scheduleApprovalCheck();
      await _openProvider(url);
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
      _scheduleApprovalCheck();
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
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Expanded(
                  child: Text(
                    'Wallet',
                    style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                      color: AppColours.ink,
                      fontWeight: FontWeight.w900,
                      letterSpacing: -1,
                    ),
                  ),
                ),
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
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(0, 44),
                    foregroundColor: AppColours.cobalt,
                    side: const BorderSide(color: AppColours.cobalt),
                    shape: const StadiumBorder(),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
            if (_approvalId != null) ...[
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: AppColours.paperMid,
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(color: AppColours.orange),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (_refreshing)
                      const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: AppColours.orange,
                        ),
                      )
                    else
                      const Icon(
                        Icons.schedule,
                        size: 18,
                        color: AppColours.orange,
                      ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            _approvalKind == 'wallet'
                                ? 'Wallet verification pending'
                                : 'Permission awaiting approval',
                            style: const TextStyle(
                              color: AppColours.ink,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(height: 4),
                          const Text(
                            'Complete approval with your provider. Status updates automatically.',
                            style: TextStyle(
                              color: AppColours.subtle,
                              fontSize: 12,
                            ),
                          ),
                          if (_authorizationUrl != null)
                            TextButton(
                              onPressed: () async {
                                try {
                                  await _openProvider(_authorizationUrl!);
                                } catch (_) {
                                  if (mounted) {
                                    setState(
                                      () => _message =
                                          'Could not open the approval link.',
                                    );
                                  }
                                }
                              },
                              style: TextButton.styleFrom(
                                padding: EdgeInsets.zero,
                                foregroundColor: AppColours.cobalt,
                                alignment: Alignment.centerLeft,
                              ),
                              child: const Text('Open approval again'),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
            ],
            if (_loading)
              const Center(child: CircularProgressIndicator())
            else if (!_walletAvailable)
              const Text(
                'Wallet status is unavailable. Check your connection and pull down to try again.',
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
                onPressed: _busy || _refreshing || _approvalId != null
                    ? null
                    : _connectWallet,
                icon: const Icon(Icons.link),
                label: const Text('Connect an existing wallet'),
              ),
            ] else ...[
              Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: AppColours.cobalt,
                  borderRadius: BorderRadius.circular(22),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      Icons.account_balance_wallet_outlined,
                      color: Colors.white,
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
                              color: Colors.white,
                              fontSize: 19,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(height: 4),
                          SelectableText(
                            _wallet!['address'] as String,
                            style: const TextStyle(
                              color: Colors.white70,
                              fontSize: 12,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'Verified · ${_wallet!['assetCode']}',
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
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
              const SizedBox(height: 6),
              const Text(
                'Permission limits are separate from your wallet balance.',
                style: TextStyle(color: AppColours.subtle, fontSize: 13),
              ),
              if (_grants.isEmpty)
                Container(
                  margin: const EdgeInsets.only(top: 14),
                  padding: const EdgeInsets.all(18),
                  decoration: BoxDecoration(
                    color: AppColours.fieldFill,
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: AppColours.fieldBorder),
                  ),
                  child: const Text(
                    'No spending permissions yet. Authorize one to set your limits.',
                    style: TextStyle(color: AppColours.subtle),
                  ),
                ),
              for (final grant in _grants)
                Container(
                  margin: const EdgeInsets.only(top: 12),
                  decoration: BoxDecoration(
                    color: AppColours.fieldFill,
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: AppColours.fieldBorder),
                  ),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(18),
                    onTap: () => _showPermissionDetails(grant),
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Wrap(
                            spacing: 8,
                            runSpacing: 4,
                            crossAxisAlignment: WrapCrossAlignment.center,
                            children: [
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 10,
                                  vertical: 5,
                                ),
                                decoration: BoxDecoration(
                                  color: AppColours.paperMid,
                                  borderRadius: BorderRadius.circular(30),
                                ),
                                child: Text(
                                  _grantStatus(grant),
                                  style: const TextStyle(
                                    color: AppColours.cobalt,
                                    fontSize: 11,
                                    fontWeight: FontWeight.w800,
                                  ),
                                ),
                              ),
                              Text(
                                grant['authoritySource'] == 'PROVIDER'
                                    ? 'Provider authorized'
                                    : 'Not provider-authorized',
                                style: const TextStyle(
                                  color: AppColours.subtle,
                                  fontSize: 12,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 10),
                          const Text(
                            'REMAINING APPROVAL',
                            style: TextStyle(
                              color: AppColours.subtle,
                              fontSize: 10,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 1.1,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            _grantAmount(grant['remaining']),
                            style: const TextStyle(
                              color: AppColours.ink,
                              fontSize: 24,
                              fontWeight: FontWeight.w900,
                              letterSpacing: -0.5,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'Approved ${_grantAmount(grant['cumulativeCap'])} · Spent ${_grantAmount(grant['spent'])}',
                            style: const TextStyle(
                              color: AppColours.subtle,
                              fontSize: 12,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  'App expiry ${_grantDate(grant['validUntil'])}',
                                  style: const TextStyle(
                                    color: AppColours.subtle,
                                    fontSize: 12,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              const Text(
                                'Details',
                                style: TextStyle(
                                  color: AppColours.cobalt,
                                  fontSize: 12,
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                              const Icon(
                                Icons.chevron_right,
                                color: AppColours.cobalt,
                                size: 18,
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              const SizedBox(height: 12),
              ElevatedButton.icon(
                onPressed: _busy || _refreshing || _approvalId != null
                    ? null
                    : _requestGrant,
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
          ],
        ),
      ),
    );
  }

  void _showPermissionDetails(dynamic grant) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) => Container(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * .85,
        ),
        decoration: const BoxDecoration(
          color: AppColours.paperTop,
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
        child: SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
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
                const Text(
                  'Permission details',
                  style: TextStyle(
                    color: AppColours.ink,
                    fontSize: 23,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 6),
                const Text(
                  'Approval remaining is not your wallet balance.',
                  style: TextStyle(color: AppColours.subtle, fontSize: 13),
                ),
                const SizedBox(height: 16),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: AppColours.cobalt,
                    borderRadius: BorderRadius.circular(18),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'REMAINING APPROVAL',
                        style: TextStyle(
                          color: Colors.white70,
                          fontSize: 10,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _grantAmount(grant['remaining']),
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 24,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                _permissionRow('Status', _grantStatus(grant)),
                _permissionRow(
                  'Authority',
                  grant['authoritySource'] == 'PROVIDER'
                      ? 'Provider authorized'
                      : 'Not provider-authorized',
                ),
                _permissionRow(
                  'Approved',
                  _grantAmount(grant['cumulativeCap']),
                ),
                _permissionRow('Spent', _grantAmount(grant['spent'])),
                _permissionRow('Reserved', _grantAmount(grant['reserved'])),
                _permissionRow(
                  'Remaining approval',
                  _grantAmount(grant['remaining']),
                ),
                _permissionRow(
                  'Maximum per payment',
                  _grantAmount(grant['perPaymentMaxDebit']),
                ),
                _permissionRow('App expiry', _grantDate(grant['validUntil'])),
                if (grant['providerRevocation'] != null)
                  _permissionRow(
                    'Provider revocation',
                    grant['providerRevocation'].toString(),
                  ),
                if (grant['revokedAt'] != null)
                  _permissionRow('Revoked at', _grantDate(grant['revokedAt'])),
                if (grant['payerWalletAddress'] != null)
                  _permissionRow(
                    'Wallet',
                    grant['payerWalletAddress'].toString(),
                  ),
                if (grant['authorizationId'] != null)
                  _permissionRow(
                    'Permission ID',
                    grant['authorizationId'].toString(),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _grantStatus(dynamic grant) {
    final status = grant['status'];
    if (status == 'ACTIVE') {
      final until = DateTime.tryParse(grant['validUntil']?.toString() ?? '');
      if (until == null) return 'Unavailable';
      return until.isAfter(DateTime.now().toUtc()) ? 'Active' : 'Expired';
    }
    return switch (status) {
      'ROTATING' => 'Updating',
      'REAUTHORIZATION_REQUIRED' => 'Needs approval',
      'BLOCKED' => 'Unavailable',
      'REVOKED' => 'Revoked',
      'EXPIRED' => 'Expired',
      _ => 'Unknown',
    };
  }

  String _grantDate(dynamic value) {
    if (value is! String) return 'Unavailable';
    final date = DateTime.tryParse(value);
    if (date == null) return value;
    return '${date.toLocal().toString().split('.').first} (local)';
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
