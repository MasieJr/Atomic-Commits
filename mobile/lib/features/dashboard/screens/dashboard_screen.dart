import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/router.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/features/activity/data/payment_repository.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:atomic_commits/features/activity/payment_details.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  final _auth = getIt<AuthController>();
  int? _ownerId;
  int _generation = 0;
  String? _permission;
  List<PaymentModel>? _payments;
  bool _permissionLoading = true;
  bool _paymentsLoading = true;
  bool _paymentsError = false;
  bool _paymentsCached = false;
  DateTime? _paymentsSyncedAt;
  bool _allowActivityCache = true;

  @override
  void initState() {
    super.initState();
    _ownerId = _auth.user?.id;
    _auth.addListener(_accountChanged);
    _refresh();
  }

  @override
  void dispose() {
    _auth.removeListener(_accountChanged);
    super.dispose();
  }

  void _accountChanged() {
    if (_ownerId == _auth.user?.id) return;
    _ownerId = _auth.user?.id;
    _allowActivityCache = false;
    _refresh();
  }

  bool _current(int generation, int? owner) =>
      mounted &&
      generation == _generation &&
      owner != null &&
      _auth.user?.id == owner;

  Future<void> _refresh() async {
    final owner = _ownerId;
    final generation = ++_generation;
    setState(() {
      _permission = null;
      _payments = null;
      _paymentsCached = false;
      _paymentsError = false;
      _paymentsSyncedAt = null;
      _permissionLoading = owner != null;
      _paymentsLoading = owner != null;
      _paymentsError = owner == null;
    });
    if (owner == null) return;
    await Future.wait([
      _loadPermission(generation, owner),
      _loadPayments(generation, owner),
    ]);
  }

  Future<void> _loadPermission(int generation, int owner) async {
    String? permission;
    try {
      final api = getIt<ApiClient>().dio;
      final walletResponse = await api.get('/wallet');
      if (!_current(generation, owner)) return;
      final wallet = walletResponse.data['wallet'];
      if (wallet is Map && wallet['address'] is String) {
        final response = await api.get('/payment-grants');
        if (!_current(generation, owner)) return;
        final grants = (response.data['grants'] as List).where((grant) {
          if (grant is! Map) return false;
          final until = DateTime.tryParse(
            grant['validUntil']?.toString() ?? '',
          );
          return grant['payerWalletAddress'] == wallet['address'] &&
              grant['status'] == 'ACTIVE' &&
              grant['authoritySource'] == 'PROVIDER' &&
              until != null &&
              until.isAfter(DateTime.now().toUtc());
        }).toList();
        if (grants.length == 1) {
          final remaining = Map<String, dynamic>.from(
            grants.single['remaining'] as Map,
          );
          final value = remaining['value'];
          final scale = remaining['assetScale'];
          if (value is String &&
              RegExp(r'^\d+$').hasMatch(value) &&
              scale is int &&
              scale >= 0 &&
              scale <= 18 &&
              remaining['assetCode'] is String &&
              remaining['assetCode'] == wallet['assetCode'] &&
              scale == wallet['assetScale']) {
            permission = PaymentAmount.fromJson(remaining).formatted;
          }
        }
      }
    } catch (_) {
      // Unavailable also covers malformed or inaccessible provider data.
    }
    if (!_current(generation, owner)) return;
    setState(() {
      _permission = permission;
      _permissionLoading = false;
    });
  }

  Future<void> _loadPayments(int generation, int owner) async {
    final origin = getIt<ApiClient>().dio.options.baseUrl;
    try {
      final result = await getIt<PaymentRepository>().getActivity(
        origin: origin,
        userId: owner,
        allowCache: _allowActivityCache,
        isCurrent: () => _current(generation, owner) && getIt<ApiClient>().dio.options.baseUrl == origin,
      );
      if (!_current(generation, owner) || getIt<ApiClient>().dio.options.baseUrl != origin) return;
      setState(() {
        if (!result.cached) _allowActivityCache = true;
        _payments = result.payments;
        _paymentsCached = result.cached;
        _paymentsSyncedAt = result.syncedAt;
        _paymentsLoading = false;
      });
    } catch (_) {
      if (!_current(generation, owner)) return;
      setState(() {
        _paymentsError = true;
        _paymentsLoading = false;
      });
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
            Text.rich(
              TextSpan(
                children: [
                  const TextSpan(text: 'Welcome back,\n'),
                  TextSpan(
                    text: _auth.user?.name ?? 'there',
                    style: const TextStyle(
                      color: AppColours.orange,
                      fontStyle: FontStyle.italic,
                    ),
                  ),
                ],
              ),
              style: const TextStyle(
                fontFamily: 'Georgia',
                fontFamilyFallback: ['Noto Serif', 'Times New Roman', 'serif'],
                color: AppColours.ink,
                fontWeight: FontWeight.w700,
                fontSize: 32,
                height: 1.05,
              ),
            ),
            const SizedBox(height: 24),
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: AppColours.cobalt,
                borderRadius: BorderRadius.circular(18),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Remaining wallet spending permission',
                    style: TextStyle(color: Colors.white70),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _permissionLoading
                        ? 'Loading…'
                        : _permission ?? 'Unavailable',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 38,
                      fontFamily: 'Georgia',
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'Not your wallet balance.',
                    style: TextStyle(color: Colors.white70, fontSize: 12),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            Row(
              children: [
                Expanded(
                  child: _ActionButton(
                    label: 'Pay',
                    icon: Icons.arrow_outward_rounded,
                    onPressed: () async {
                      await context.push(AppRoutes.payer);
                      if (mounted) _refresh();
                    },
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _ActionButton(
                    label: 'Receive',
                    icon: Icons.south_west_rounded,
                    onPressed: () async {
                      await context.push(AppRoutes.merchant);
                      if (mounted) _refresh();
                    },
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Recent activity',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                TextButton(
                  onPressed: () => context.go(AppRoutes.activity),
                  child: const Text('See all'),
                ),
              ],
            ),
            if (_paymentsSyncedAt != null)
              Text(_paymentsCached
                  ? 'Offline activity (may be stale) · Last synced ${_paymentsSyncedAt!.toLocal()}'
                  : 'Last synced ${_paymentsSyncedAt!.toLocal()}'),
            if (_paymentsLoading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 16),
                child: Text('Loading activity…'),
              )
            else if (_paymentsError)
              const Text('Activity unavailable. Pull to refresh.')
            else if (_payments == null || _payments!.isEmpty)
              const Text('No payments yet.')
            else
              for (final payment in _payments!.take(3))
                _RecentPayment(payment: payment),
          ],
        ),
      ),
    );
  }
}

class _RecentPayment extends StatelessWidget {
  const _RecentPayment({required this.payment});
  final PaymentModel payment;

  @override
  Widget build(BuildContext context) {
    final sent = payment.direction == PaymentDirection.sent;
    final party = sent ? payment.merchantName : payment.payerName;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: CircleAvatar(
        backgroundColor: AppColours.paperMid,
        foregroundColor: sent ? AppColours.cobalt : AppColours.eyebrow,
        child: Icon(
          sent ? Icons.arrow_outward_rounded : Icons.south_west_rounded,
        ),
      ),
      title: Text('${sent ? 'To' : 'From'} ${party ?? 'Unknown'}'),
      subtitle: Text(
        '${payment.displayStatus} · ${payment.displayDate?.toLocal() ?? 'Time unavailable'}',
      ),
      trailing: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 110),
        child: Text(
          payment.displayAmount?.formatted ?? 'Amount unavailable',
          textAlign: TextAlign.end,
        ),
      ),
      onTap: () => showPaymentDetails(context, payment),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({
    required this.label,
    required this.icon,
    required this.onPressed,
  });
  final String label;
  final IconData icon;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      SizedBox(
        width: double.infinity,
        height: 76,
        child: FilledButton(
          onPressed: onPressed,
          style: FilledButton.styleFrom(
            backgroundColor: label == 'Pay'
                ? AppColours.orange
                : AppColours.paperMid,
            foregroundColor: label == 'Pay' ? Colors.white : AppColours.ink,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
            ),
          ),
          child: Icon(icon, size: 34, semanticLabel: label),
        ),
      ),
      const SizedBox(height: 8),
      Text(label, style: const TextStyle(fontWeight: FontWeight.w700)),
    ],
  );
}
