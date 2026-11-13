import 'dart:async';

import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:atomic_commits/features/payer/offline_profile.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

class PayerHomeScreen extends StatefulWidget {
  const PayerHomeScreen({super.key});

  @override
  State<PayerHomeScreen> createState() => _PayerHomeScreenState();
}

class _PayerHomeScreenState extends State<PayerHomeScreen> {
  final _store = const OfflineProfileStore();
  OfflineProfile? _profile;
  Timer? _timer;
  bool _loading = true;
  bool _busy = false;
  String? _message;
  late final int _userId;

  Dio get _api => getIt<ApiClient>().dio;

  @override
  void initState() {
    super.initState();
    _userId = getIt<AuthController>().user!.id;
    _loadLocalProfile();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _loadLocalProfile() async {
    try {
      final profile = await _store.read(_userId);
      if (mounted) {
        setState(() {
          _profile = profile;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _loading = false;
          _message = 'The saved device profile could not be read.';
        });
      }
    }
  }

  String _errorMessage(Object error) {
    if (error is DioException && error.response?.data is Map) {
      final message = (error.response!.data as Map)['error'];
      if (message is String) return message;
    }
    return 'Could not reach the server. Connect to the internet and try again.';
  }

  Future<void> _enroll() async {
    if (getIt<AuthController>().user?.id != _userId) return;
    var enrollmentRequested = false;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final response = await _api.get('/payment-grants');
      final now = DateTime.now().toUtc();
      final grants = (response.data['grants'] as List).where((grant) {
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
      if (!mounted) return;
      if (grants.isEmpty) {
        setState(
          () => _message = 'Authorize a spending permission in Wallet before enrolling this device.',
        );
        return;
      }
      final selected = await showDialog<Map<String, dynamic>>(
        context: context,
        builder: (context) => SimpleDialog(
          title: const Text('Choose a spending permission'),
          children: [
            for (final grant in grants)
              SimpleDialogOption(
                onPressed: () => Navigator.pop(
                  context,
                  Map<String, dynamic>.from(grant as Map),
                ),
                child: Text(
                  '${grant['payerWalletAddress']}\n'
                  'Maximum ${PaymentAmount.fromJson(Map<String, dynamic>.from(grant['perPaymentMaxDebit'] as Map)).formatted} per payment\n'
                  'Remaining ${PaymentAmount.fromJson(Map<String, dynamic>.from(grant['remaining'] as Map)).formatted}\n'
                  'Valid until ${grant['validUntil']}',
                ),
              ),
          ],
        ),
      );
      if (selected == null ||
          !mounted ||
          getIt<AuthController>().user?.id != _userId) {
        return;
      }
      enrollmentRequested = true;
      final packet = await _api.post(
        '/devices/totp/enroll',
        data: {
          'authorizationId': selected['authorizationId'],
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
        permissionLimit: PaymentAmount.fromJson(
          Map<String, dynamic>.from(selected['perPaymentMaxDebit'] as Map),
        ).formatted,
      );
      try {
        await _store.save(_userId, profile);
      } catch (_) {
        if (mounted) {
          setState(
            () => _message =
                'Could not save this device securely. Revoke device ${profile.prefix} before enrolling again.',
          );
        }
        return;
      }
      if (mounted) {
        setState(() {
          _profile = profile;
          _message = 'Device enrolled. Codes are generated on this device.';
        });
      }
    } catch (error) {
      if (mounted) {
        final ambiguous =
            enrollmentRequested &&
            (error is! DioException ||
                error.response == null ||
                (error.response!.statusCode ?? 500) >= 500);
        setState(
          () => _message = ambiguous
              ? 'Enrollment may already exist. Check registered devices before trying again.'
              : _errorMessage(error),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _manageDevices() async {
    if (getIt<AuthController>().user?.id != _userId) return;
    setState(() => _busy = true);
    try {
      final response = await _api.get('/devices/totp');
      final devices = (response.data['devices'] as List)
          .where((device) => device['status'] == 'ACTIVE')
          .toList();
      if (!mounted) return;
      if (devices.isEmpty) {
        setState(
          () => _message = 'There are no active devices on this account.',
        );
        return;
      }
      final prefix = await showDialog<String>(
        context: context,
        builder: (context) => SimpleDialog(
          title: const Text('Revoke a registered device'),
          children: [
            for (final device in devices)
              SimpleDialogOption(
                onPressed: () =>
                    Navigator.pop(context, device['prefix'] as String),
                child: Text(
                  '${device['deviceName']} · ${device['prefix']}\nPermission: ${device['grantStatus']}',
                ),
              ),
          ],
        ),
      );
      if (prefix == null ||
          !mounted ||
          getIt<AuthController>().user?.id != _userId) {
        return;
      }
      final confirm = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Revoke device?'),
          content: Text(
            'Device $prefix can no longer create redeemable codes.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Revoke'),
            ),
          ],
        ),
      );
      if (confirm != true ||
          !mounted ||
          getIt<AuthController>().user?.id != _userId) {
        return;
      }
      await _api.post('/devices/totp/$prefix/revoke');
      if (_profile?.prefix == prefix) await _store.delete(_userId);
      if (mounted) {
        setState(() {
          if (_profile?.prefix == prefix) _profile = null;
          _message = 'Device $prefix revoked.';
        });
      }
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _checkStatus() async {
    if (getIt<AuthController>().user?.id != _userId) return;
    final profile = _profile;
    if (profile == null) return;
    setState(() => _busy = true);
    try {
      final response = await _api.get('/devices/totp/${profile.prefix}/status');
      if (response.data['status'] != 'ACTIVE' ||
          response.data['grantStatus'] != 'ACTIVE') {
        await _store.delete(_userId);
        if (mounted) {
          setState(() {
            _profile = null;
            _message = 'This device or its spending permission was revoked or is no longer active.';
          });
        }
      } else {
        final grant = await _api.get(
          '/payment-grants/${response.data['authorizationId']}',
        );
        final limit = PaymentAmount.fromJson(
          Map<String, dynamic>.from(grant.data['perPaymentMaxDebit'] as Map),
        ).formatted;
        final updated = OfflineProfile(
          prefix: profile.prefix,
          secret: profile.secret,
          expiresAtEpochMs: profile.expiresAtEpochMs,
          permissionLimit: limit,
        );
        await _store.save(_userId, updated);
        if (mounted && getIt<AuthController>().user?.id == _userId) {
          setState(() {
            _profile = updated;
            _message =
                'The server reports this device and permission are active.';
          });
        }
      }
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _revoke() async {
    if (getIt<AuthController>().user?.id != _userId) return;
    final profile = _profile;
    if (profile == null) return;
    setState(() => _busy = true);
    try {
      await _api.post('/devices/totp/${profile.prefix}/revoke');
      await _store.delete(_userId);
      if (mounted) {
        setState(() {
          _profile = null;
          _message = 'Device revoked.';
        });
      }
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    OfflineCode? code;
    if (_profile != null) {
      try {
        code = _profile!.codeAt(DateTime.now());
      } on StateError {
        /* displayed below */
      }
    }
    final seconds = code == null
        ? 0
        : code.expiresAt.difference(DateTime.now().toUtc()).inSeconds + 1;
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
              onPressed: _busy ? null : _enroll,
              child: const Text('Enroll this device'),
            ),
            TextButton(
              style: TextButton.styleFrom(foregroundColor: AppColours.cobalt),
              onPressed: _busy ? null : _manageDevices,
              child: const Text('Check registered devices'),
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
                    'Connect and revoke it before enrolling again.',
                    style: TextStyle(color: AppColours.subtle, height: 1.4),
                  ),
                ],
              ),
            ),
            TextButton(
              style: TextButton.styleFrom(foregroundColor: AppColours.cobalt),
              onPressed: _busy ? null : _revoke,
              child: const Text('Revoke expired device'),
            ),
          ] else ...[
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
                      'Current window ends in ${seconds.clamp(0, 30)} seconds',
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
                  : 'Device limit unavailable. Check device status online.',
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
            TextButton(
              style: TextButton.styleFrom(foregroundColor: AppColours.cobalt),
              onPressed: _busy ? null : _checkStatus,
              child: const Text('Check device status online'),
            ),
            TextButton(
              style: TextButton.styleFrom(foregroundColor: AppColours.cobalt),
              onPressed: _busy ? null : _revoke,
              child: const Text('Revoke this device'),
            ),
            const Text(
              'To use a new spending permission, revoke this device and enroll again.',
              style: TextStyle(
                color: AppColours.subtle,
                fontSize: 12,
                height: 1.4,
              ),
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
        ],
      ),
    );
  }
}
