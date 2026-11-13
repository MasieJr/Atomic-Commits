import 'dart:async';

import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/router.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:atomic_commits/features/payer/offline_profile.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:qr_flutter/qr_flutter.dart';

class PayerHomeScreen extends StatefulWidget {
  const PayerHomeScreen({super.key, this.now});

  /// Injectable clock for deterministic widget tests and screenshots.
  final DateTime Function()? now;

  @override
  State<PayerHomeScreen> createState() => _PayerHomeScreenState();
}

class _PayerHomeScreenState extends State<PayerHomeScreen> {
  final _store = const OfflineProfileStore();
  OfflineProfile? _profile;
  Timer? _timer;
  bool _loading = true;
  bool _busy = false;
  bool _setupBlocked = true;
  bool _showWallet = false;
  bool _ownerChanged = false;
  bool _longCode = false;
  String? _message;
  late final int _userId;

  Dio get _api => getIt<ApiClient>().dio;
  DateTime _now() => widget.now?.call() ?? DateTime.now();
  bool get _current =>
      mounted && !_ownerChanged && getIt<AuthController>().user?.id == _userId;

  void _onAuthChanged() {
    if (!_ownerChanged && getIt<AuthController>().user?.id != _userId) {
      setState(() => _ownerChanged = true);
    }
  }

  @override
  void initState() {
    super.initState();
    _userId = getIt<AuthController>().user!.id;
    getIt<AuthController>().addListener(_onAuthChanged);
    _loadLocalProfile();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_current) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    getIt<AuthController>().removeListener(_onAuthChanged);
    super.dispose();
  }

  Future<void> _loadLocalProfile() async {
    try {
      final profile = await _store.read(_userId);
      if (_current) {
        setState(() {
          _profile = profile;
          _setupBlocked = profile != null;
          _loading = false;
        });
      }
    } catch (_) {
      if (_current) {
        setState(() {
          _loading = false;
          _message = 'Secure device storage could not be read. Setup is blocked; restore access to secure storage before continuing.';
        });
      }
    }
  }

  String _errorMessage(Object error) {
    if (error is DioException && error.response?.data is Map) {
      final message = (error.response!.data as Map)['error'];
      if (message is String) return message;
    }
    if (error is DioException && error.response?.statusCode != null) {
      return 'The server rejected the request (HTTP ${error.response!.statusCode}). Check your spending permission and try again.';
    }
    return 'Could not reach the server. Connect to the internet and try again.';
  }

  Future<void> _enroll() async {
    if (_busy || _setupBlocked || _profile != null || !_current) return;
    var enrollmentRequested = false;
    setState(() {
      _busy = true;
      _message = null;
      _showWallet = false;
    });
    try {
      final response = await _api.get('/payment-grants');
      final now = DateTime.now().toUtc();
      final allGrants = response.data['grants'] as List;
      final grants = allGrants.where((grant) {
        final until = DateTime.tryParse(grant['validUntil'] as String? ?? '');
        final remaining =
            BigInt.tryParse(grant['remaining']['value'] as String? ?? '') ??
            BigInt.zero;
        return grant['status'] == 'ACTIVE' &&
            grant['authoritySource'] == 'PROVIDER' &&
            until != null &&
            until.isAfter(now) &&
            remaining > BigInt.zero;
      }).toList();
      if (!_current) return;
      if (grants.isEmpty) {
        setState(
          () => _message = 'No eligible spending permission is available. Check Wallet and try again.',
        );
        return;
      }
      final selected = await showModalBottomSheet<Map<String, dynamic>>(
        context: context,
        backgroundColor: AppColours.paperTop,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
        isScrollControlled: true,
        builder: (context) => ListenableBuilder(
          listenable: getIt<AuthController>(),
          builder: (context, _) => !_current
              ? const SizedBox.shrink()
              : SafeArea(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(
                          Icons.account_balance_wallet_outlined,
                          color: AppColours.orange,
                        ),
                        const SizedBox(height: 8),
                        const Text(
                          'Choose a spending permission',
                          style: TextStyle(
                            color: AppColours.ink,
                            fontSize: 20,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        const SizedBox(height: 12),
                        Flexible(
                          child: ListView(
                            shrinkWrap: true,
                            children: [
                              for (final grant in grants)
                                Card(
                                  color: AppColours.fieldFill,
                                  child: ListTile(
                                    onTap: () => Navigator.pop(
                                      context,
                                      Map<String, dynamic>.from(grant as Map),
                                    ),
                                    title: Text(
                                      '${grant['payerWalletAddress']}',
                                      style: const TextStyle(
                                        color: AppColours.ink,
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                                    subtitle: Text(
                                      'Maximum ${PaymentAmount.fromJson(Map<String, dynamic>.from(grant['perPaymentMaxDebit'] as Map)).formatted} per payment\n'
                                      'Remaining ${PaymentAmount.fromJson(Map<String, dynamic>.from(grant['remaining'] as Map)).formatted}\n'
                                      'Valid until ${grant['validUntil']}',
                                    ),
                                    trailing: const Icon(
                                      Icons.chevron_right,
                                      color: AppColours.cobalt,
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
        ),
      );
      if (selected == null || !_current) return;
      final authorizationId = selected['authorizationId'];
      if (authorizationId is! String || authorizationId.isEmpty) {
        throw const FormatException('Invalid permission.');
      }
      final limit = PaymentAmount.fromJson(
        Map<String, dynamic>.from(selected['perPaymentMaxDebit'] as Map),
      ).formatted;
      if (!_current) return;
      enrollmentRequested = true;
      final packet = await _api.post(
        '/devices/totp/enroll',
        data: {
          'authorizationId': authorizationId,
          'deviceName': 'Atomic Commit mobile',
        },
      );
      final packetProfile = OfflineProfile.fromJson(
        Map<String, dynamic>.from(packet.data as Map),
      );
      final profile = OfflineProfile(
        prefix: packetProfile.prefix,
        secret: packetProfile.secret,
        expiresAtEpochMs: packetProfile.expiresAtEpochMs,
        permissionLimit: limit,
      );
      try {
        await _store.save(_userId, profile);
        final saved = await _store.read(_userId);
        if (saved == null ||
            saved.prefix != profile.prefix ||
            saved.secret != profile.secret) {
          throw const FormatException('Saved device profile does not match.');
        }
        if (_current) {
          setState(() => _profile = saved);
        }
      } catch (_) {
        if (_current) {
          setState(() {
            _showWallet = true;
            _message =
                'Could not verify or finish saving device ${profile.prefix}. Check Wallet or contact support for recovery.';
          });
        }
        return;
      }
      if (_current) {
        setState(() {
          _profile = profile;
          _message = 'Device enrolled. Codes are generated on this device.';
        });
      }
    } catch (error) {
      if (_current) {
        final ambiguous =
            enrollmentRequested &&
            (error is! DioException ||
                error.response == null ||
                error.response!.statusCode == 408 ||
                (error.response!.statusCode ?? 500) >= 500);
        setState(() {
          _showWallet = ambiguous;
          _message = ambiguous
              ? 'Setup could not be completed safely. Check Wallet or contact support for recovery before trying again.'
              : _errorMessage(error);
        });
      }
    } finally {
      if (_current) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_current) return const Scaffold(backgroundColor: AppColours.paperTop);
    OfflineCode? code;
    if (_profile != null) {
      try {
        code = _profile!.codeAt(
          _now(),
          periodMs: _longCode ? 1800000 : 30000,
        );
      } on StateError {
        /* displayed below */
      }
    }
    final seconds = code == null
        ? 0
        : code.expiresAt.difference(_now().toUtc()).inSeconds + 1;
    final minutes = seconds ~/ 60;
    final remainder = seconds % 60;
    final countdown = '$minutes:${remainder.toString().padLeft(2, '0')}';
    final windowLabel = _longCode
        ? 'Valid until ${code?.expiresAt.toLocal().toIso8601String().substring(11, 16) ?? '--:--'} · $countdown left'
        : 'Current window ends in ${seconds.clamp(0, 30)} seconds';
    final cardDecoration = BoxDecoration(
      color: AppColours.fieldFill,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: AppColours.fieldBorder),
    );
    return Scaffold(
      backgroundColor: AppColours.paperTop,
      appBar: AppBar(
        backgroundColor: AppColours.paperTop,
        foregroundColor: AppColours.ink,
        elevation: 0,
        title: const Text('Pay', style: TextStyle(fontWeight: FontWeight.w700)),
      ),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.screenPadding),
        children: [
          const Text(
            'Payment code',
            style: TextStyle(
              color: AppColours.ink,
              fontSize: 27,
              fontWeight: FontWeight.w800,
              letterSpacing: -0.7,
            ),
          ),
          const SizedBox(height: 20),
          if (_loading)
            const Center(
              child: CircularProgressIndicator(color: AppColours.cobalt),
            )
          else if (_profile == null) ...[
            Container(
              padding: const EdgeInsets.all(20),
              decoration: cardDecoration,
              child: const Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.phonelink_setup_rounded,
                    color: AppColours.cobalt,
                    size: 28,
                  ),
                  SizedBox(height: 12),
                  Text(
                    'Set up this device',
                    style: TextStyle(
                      color: AppColours.ink,
                      fontSize: 18,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  SizedBox(height: 6),
                  Text(
                    'Enroll this device while connected to use payment codes offline.',
                    style: TextStyle(color: AppColours.subtle, height: 1.4),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: AppColours.cobalt,
                padding: const EdgeInsets.symmetric(vertical: 15),
              ),
              onPressed: _busy || _setupBlocked ? null : () => _enroll(),
              child: const Text('Try device setup'),
            ),
          ] else if (code == null) ...[
            Container(
              padding: const EdgeInsets.all(20),
              decoration: cardDecoration,
              child: const Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.info_outline_rounded, color: AppColours.orange),
                  SizedBox(height: 10),
                  Text(
                    'Device profile expired',
                    style: TextStyle(
                      color: AppColours.ink,
                      fontSize: 18,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  SizedBox(height: 6),
                  Text(
                    'Manage this device in Wallet to continue.',
                    style: TextStyle(color: AppColours.subtle, height: 1.4),
                  ),
                ],
              ),
            ),
            TextButton(
              style: TextButton.styleFrom(foregroundColor: AppColours.cobalt),
              onPressed: _busy ? null : () => context.go(AppRoutes.wallet),
              child: const Text('Manage devices in Wallet'),
            ),
          ] else ...[
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: false, label: Text('30 seconds')),
                ButtonSegment(value: true, label: Text('30 minutes')),
              ],
              selected: {_longCode},
              onSelectionChanged: (selection) {
                setState(() => _longCode = selection.first);
              },
            ),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(20),
              decoration: cardDecoration,
              child: Column(
                children: [
                  Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 220),
                      child: AspectRatio(
                        aspectRatio: 1,
                        child: QrImageView(
                          data: code.value,
                          backgroundColor: Colors.white,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),
                  SelectableText(
                    code.value,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: AppColours.ink,
                      fontSize: 22,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 7,
                    ),
                    decoration: BoxDecoration(
                      color: AppColours.paperMid,
                      borderRadius: BorderRadius.circular(30),
                    ),
                    child: Text(
                      windowLabel,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        color: AppColours.eyebrow,
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'Each code can be used once.',
                    style: TextStyle(color: AppColours.subtle, fontSize: 12),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Text(
              _profile!.permissionLimit != null
                  ? 'Device limit at enrollment: ${_profile!.permissionLimit} per payment'
                  : 'Device limit at enrollment is unavailable.',
              style: const TextStyle(
                color: AppColours.ink,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            const Text(
              'Revocation cannot be checked while offline.',
              style: TextStyle(color: AppColours.subtle, fontSize: 12),
            ),
          ],
          if (_message != null)
            Container(
              margin: const EdgeInsets.only(top: 12),
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AppColours.paperMid,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColours.fieldBorder),
              ),
              child: Text(
                _message!,
                style: const TextStyle(color: AppColours.ink, height: 1.4),
              ),
            ),
          if (_showWallet && !(_profile != null && code == null))
            TextButton(
              style: TextButton.styleFrom(foregroundColor: AppColours.cobalt),
              onPressed: _busy ? null : () => context.go(AppRoutes.wallet),
              child: const Text('Manage devices in Wallet'),
            ),
        ],
      ),
    );
  }
}
