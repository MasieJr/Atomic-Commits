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
import 'package:atomic_commits/features/wallet/wallet_cache.dart';
import 'package:atomic_commits/features/wallet/screens/wallet_tutorial_sheet.dart';
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
  List<Map<String, dynamic>> _wallets = [];
  List<dynamic> _grants = [];
  String? _approvalId;
  String? _approvalKind;
  String? _authorizationUrl;
  String? _message;
  bool _loading = true;
  bool _walletAvailable = false;
  bool _busy = false;
  bool _offline = false;
  bool _authorizationRejected = false;
  DateTime? _syncedAt;
  int _refreshVersion = 0;
  int _accountVersion = 0;
  static const _storage = FlutterSecureStorage();
  late final int _ownerId;

  Dio get _api => getIt<ApiClient>().dio;
  String get _origin => _api.options.baseUrl;
  String get _pendingKey =>
      'wallet_approval_${sha256.convert(utf8.encode(ApiEndpoints.baseUrl))}_$_ownerId';

  @override
  void initState() {
    super.initState();
    _ownerId = getIt<AuthController>().user!.id;
    getIt<AuthController>().addListener(_accountChanged);
    WidgetsBinding.instance.addObserver(this);
    _restoreApproval();
  }

  @override
  void dispose() {
    getIt<AuthController>().removeListener(_accountChanged);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _accountChanged() {
    _accountVersion++;
    if (getIt<AuthController>().user?.id != _ownerId && mounted) {
      setState(() {
        _wallet = null;
        _wallets = [];
        _grants = [];
        _walletAvailable = false;
        _offline = false;
        _authorizationUrl = null;
      });
    }
  }

  Future<bool> _rejectAuthorization(Object error) async {
    if (error is! DioException ||
        (error.response?.statusCode != 401 && error.response?.statusCode != 403) ||
        !mounted || getIt<AuthController>().user?.id != _ownerId) return false;
    _authorizationRejected = true;
    ++_refreshVersion;
    setState(() {
      _loading = false;
      _walletAvailable = false;
      _offline = false;
      _wallet = null;
      _wallets = [];
      _grants = [];
      _message = _errorMessage(error);
    });
    try {
      await WalletCache.purge(origin: _origin, userId: _ownerId);
    } catch (_) {
      // Keep this process blocked from reading the snapshot if deletion fails.
    }
    return true;
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
    final version = ++_refreshVersion;
    final accountVersion = _accountVersion;
    final origin = _origin;
    bool accountCurrent() => mounted && _accountVersion == accountVersion && _origin == origin &&
        getIt<AuthController>().user?.id == _ownerId;
    bool current() => accountCurrent() && _refreshVersion == version;
    void checkCurrent() {
      if (!current()) throw StateError('Account or refresh changed');
    }
    try {
      String? message;
      if (_approvalId != null) {
        final path = _approvalKind == 'wallet'
            ? '/wallet/approvals/$_approvalId'
            : '/payment-grants/approvals/$_approvalId';
        final approval = await _api.get(path);
        checkCurrent();
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
        checkCurrent();
      }
      final response = await _api.get('/wallet');
      checkCurrent();
      final value = response.data['wallet'];
      final wallet = value == null
          ? null
          : Map<String, dynamic>.from(value as Map);
      final list = await _api.get('/wallets');
      checkCurrent();
      final wallets = (list.data['wallets'] as List)
          .map((item) => Map<String, dynamic>.from(item as Map)).toList();
      List<dynamic> grants = [];
      if (wallet != null) {
        final result = await _api.get('/payment-grants');
        checkCurrent();
        grants = List<dynamic>.from(result.data['grants'] as List);
      }
      if (!current()) return;
      setState(() {
        _wallet = wallet;
        _wallets = wallets;
        _grants = grants;
        _loading = false;
        _walletAvailable = true;
        _offline = false;
        _authorizationRejected = false;
        _syncedAt = null;
        _message = message;
      });
      try {
        await WalletCache.write(origin: origin, userId: _ownerId,
          isCurrent: current, isAccountCurrent: accountCurrent,
          wallet: wallet, wallets: wallets, grants: grants);
      } catch (_) {
        // Secure storage failure must not hide a successful online response.
      }
    } catch (error) {
      if (accountCurrent() && await _rejectAuthorization(error)) return;
      if (!current()) return;
      Map<String, dynamic>? cached;
      final disconnected = error is DioException && error.response == null &&
          (error.type == DioExceptionType.connectionError ||
           error.type == DioExceptionType.connectionTimeout ||
           error.type == DioExceptionType.receiveTimeout ||
           error.type == DioExceptionType.sendTimeout);
      if (!_authorizationRejected && disconnected) {
        try {
          cached = await WalletCache.read(origin: origin, userId: _ownerId, isCurrent: current);
        } catch (_) {
          // Treat unreadable or corrupt snapshots as unavailable.
        }
      }
      if (!current()) return;
      setState(() {
        _loading = false;
        _walletAvailable = cached != null;
        _offline = disconnected;
        if (cached != null) {
          _wallet = cached['wallet'] as Map<String, dynamic>?;
          _wallets = cached['wallets'] as List<Map<String, dynamic>>;
          _grants = cached['grants'] as List<dynamic>;
          _syncedAt = DateTime.parse(cached['syncedAt'] as String).toLocal();
        } else {
          _wallet = null;
          _wallets = [];
          _grants = [];
          _syncedAt = null;
        }
        _message = cached == null ? _errorMessage(error) : null;
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

  Future<void> _showConnectTutorial() async {
    if (_busy || _offline || !mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) => Container(
        height: MediaQuery.sizeOf(context).height * 0.88,
        decoration: const BoxDecoration(
          color: AppColours.paperTop,
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
        child: WalletConnectTutorialSheet(onContinue: _connectWallet),
      ),
    );
  }

  Future<void> _connectWallet() async {
    var input = '';
    final address = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Connect an existing wallet'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'A page will open for approval. First grab your wallet address '
                'from the Test Wallet site:',
                style: TextStyle(
                  color: AppColours.subtle,
                  fontSize: 13,
                  height: 1.45,
                ),
              ),
              const SizedBox(height: 12),
              ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 280, maxHeight: 224),
                  child: Image.asset(
                    'assets/images/wallet_tutorial/wallet-address.png',
                    fit: BoxFit.contain,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              const Text(
                'Copy it, then paste it below.',
                style: TextStyle(
                  color: AppColours.ink,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 12),
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
    await _beginApproval('/wallets/approvals', {
      'walletAddress': address,
    }, 'wallet');
  }

  Future<void> _openSignupSite() async {
    try {
      await _openProvider(
        'https://wallet.interledger-test.dev/auth/signup',
      );
    } catch (_) {
      if (mounted && getIt<AuthController>().user?.id == _ownerId) {
        setState(
          () => _message = 'Could not open the Test Wallet registration page.',
        );
      }
    }
  }

  Future<void> _showCreateTutorial() async {
    if (_busy || _offline || !mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) => Container(
        height: MediaQuery.sizeOf(context).height * 0.88,
        decoration: const BoxDecoration(
          color: AppColours.paperTop,
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
        child: WalletCreateTutorialSheet(onOpenSite: _openSignupSite),
      ),
    );
  }

  Future<void> _setDefault(String address, String purpose) async {
    if (_busy || _offline || !mounted || getIt<AuthController>().user?.id != _ownerId) return;
    setState(() { _busy = true; _message = null; });
    try {
      await _api.post('/wallets/default', data: {
        'walletAddress': address, 'purpose': purpose,
      });
      await _refresh();
      if (mounted && getIt<AuthController>().user?.id == _ownerId && _walletAvailable) {
        setState(() => _message = purpose == 'spending'
            ? 'Spending default updated. Existing devices keep their original permissions.'
            : 'Receiving default updated.');
      }
    } catch (error) {
      if (await _rejectAuthorization(error)) return;
      if (mounted && getIt<AuthController>().user?.id == _ownerId) {
        setState(() => _message = _errorMessage(error));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _requestGrant() async {
    final wallet = _wallet;
    if (wallet == null || _offline) return;
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
        'walletAddress': wallet['address'] as String,
        'assetCode': wallet['assetCode'] as String,
        'assetScale': scale,
        'cumulativeCap': cumulative,
        'perPaymentMaxDebit': perPayment,
      }, 'grant');
    }
  }

  Future<void> _beginApproval(
    String path,
    Map<String, Object> body,
    String kind,
  ) async {
    if (_busy || _offline || !mounted || getIt<AuthController>().user?.id != _ownerId) {
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
      if (await _rejectAuthorization(error)) return;
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
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Wallets',
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      color: AppColours.ink,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(minimumSize: const Size(0, 44)),
                  onPressed: _busy || _offline ||
                          getIt<AuthController>().user?.id != _ownerId
                      ? null
                      : () => showModalBottomSheet<void>(
                          context: context,
                          isScrollControlled: true,
                          backgroundColor: Colors.transparent,
                          builder: (_) => DeviceSettingsSheet(ownerId: _ownerId),
                        ),
                  icon: const Icon(Icons.phonelink_setup_outlined),
                  label: const Text('Devices'),
                ),
              ],
            ),
            const SizedBox(height: 24),
            if (_offline)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Text(_walletAvailable
                    ? 'Offline — cached data may be stale. Last synced: $_syncedAt. Actions are disabled until refreshed online.'
                    : 'Offline — actions are disabled until refreshed online.'),
              ),
            if (_loading)
              const Center(child: CircularProgressIndicator())
            else if (!_walletAvailable)
              const Text(
                'Wallet status is unavailable. Connect to the server and refresh.',
              )
            else if (_wallet == null) ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  horizontal: 24,
                  vertical: 28,
                ),
                decoration: BoxDecoration(
                  color: AppColours.fieldFill,
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: AppColours.fieldBorder),
                ),
                child: Column(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(14),
                      decoration: const BoxDecoration(
                        gradient: LinearGradient(
                          colors: [AppColours.orange, AppColours.cobalt],
                          begin: Alignment.topLeft,
                          end: Alignment.bottomRight,
                        ),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(
                        Icons.account_balance_wallet_outlined,
                        color: Colors.white,
                        size: 34,
                      ),
                    ),
                    const SizedBox(height: 18),
                    Text(
                      'Set up your wallet',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleLarge?.copyWith(
                        color: AppColours.ink,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Create a Test Wallet account or connect one you already '
                      'have. You only need an email address, and it takes '
                      'about 10 minutes.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: AppColours.subtle, height: 1.45),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),
              FilledButton.icon(
                onPressed: _busy || _offline ? null : _showCreateTutorial,
                icon: const Icon(Icons.auto_awesome),
                label: const Text('Create a new wallet'),
                style: FilledButton.styleFrom(
                  backgroundColor: AppColours.cobalt,
                  foregroundColor: Colors.white,
                  disabledBackgroundColor: AppColours.fieldBorder,
                  disabledForegroundColor: AppColours.subtle,
                  minimumSize: const Size(
                    double.infinity,
                    AppSpacing.buttonHeight,
                  ),
                  textStyle: const TextStyle(
                    fontFamily: 'Roboto',
                    fontWeight: FontWeight.w700,
                    fontSize: 16,
                  ),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(
                      AppSpacing.buttonRadius,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed:
                    _busy || _offline || _approvalId != null
                        ? null
                        : _showConnectTutorial,
                icon: const Icon(Icons.link),
                label: const Text('Connect an existing wallet'),
              ),
            ] else ...[
              for (var i = 0; i < _wallets.length; i++) ...[
                if (i > 0) const SizedBox(height: 12),
                Builder(
                  builder: (context) {
                    final wallet = _wallets[i];
                    return Card(
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('${wallet['publicName'] ?? 'Verified wallet'} · ${wallet['assetCode']}'),
                            SelectableText('${wallet['address']}'),
                            Wrap(spacing: 8, children: [
                              TextButton(
                                onPressed: _busy || _offline || wallet['isDefaultSpending'] == true ? null :
                                    () => _setDefault(wallet['address'] as String, 'spending'),
                                child: Text(wallet['isDefaultSpending'] == true ? 'Default spending' : 'Use for spending'),
                              ),
                              TextButton(
                                onPressed: _busy || _offline || wallet['isDefaultReceiving'] == true ? null :
                                    () => _setDefault(wallet['address'] as String, 'receiving'),
                                child: Text(wallet['isDefaultReceiving'] == true ? 'Default receiving' : 'Use for receiving'),
                              ),
                            ]),
                          ],
                        ),
                      ),
                    );
                  },
                ),
              ],
              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed: _busy || _offline || _approvalId != null ? null : _connectWallet,
                icon: const Icon(Icons.add_link),
                label: const Text('Connect another wallet'),
              ),
              const SizedBox(height: 12),
              const Text('Default spending wallet'),
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
                onPressed: _busy || _offline ? null : _requestGrant,
                icon: const Icon(Icons.verified_user_outlined),
                label: const Text('Authorize spending'),
              ),
              TextButton(
                onPressed: _offline ? null : () async {
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
                onPressed: _offline ? null : () async {
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
