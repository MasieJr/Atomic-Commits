import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:atomic_commits/features/payer/offline_profile.dart';
import 'package:flutter/material.dart';

class DeviceSettingsSheet extends StatefulWidget {
  const DeviceSettingsSheet({super.key, required this.ownerId});

  final int ownerId;

  @override
  State<DeviceSettingsSheet> createState() => _DeviceSettingsSheetState();
}

class _DeviceSettingsSheetState extends State<DeviceSettingsSheet> {
  static const _store = OfflineProfileStore();
  List<Map<String, dynamic>>? _devices;
  OfflineProfile? _profile;
  String? _message;
  bool _busy = false;

  bool get _isOwner => getIt<AuthController>().user?.id == widget.ownerId;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<List<Map<String, dynamic>>> _fetchDevices() async {
    final response = await getIt<ApiClient>().dio.get('/devices/totp');
    final data = response.data;
    if (data is! Map || data['devices'] is! List) {
      throw const FormatException('Invalid device list');
    }
    final devices = <Map<String, dynamic>>[];
    for (final item in data['devices'] as List) {
      if (item is! Map ||
          item['prefix'] is! String ||
          !RegExp(r'^[A-Z0-9]{4,12}$').hasMatch(item['prefix'] as String) ||
          (item['status'] != 'ACTIVE' && item['status'] != 'REVOKED')) {
        throw const FormatException('Invalid device list');
      }
      devices.add(Map<String, dynamic>.from(item));
    }
    return devices;
  }

  Future<void> _load({String? guidance}) async {
    if (!_isOwner || _busy) return;
    setState(() {
      _busy = true;
      _message = guidance;
      _devices = null;
    });
    try {
      final devices = await _fetchDevices();
      if (!mounted || !_isOwner) return;
      OfflineProfile? profile;
      var storageError = false;
      try {
        profile = await _store.read(widget.ownerId);
        if (!mounted || !_isOwner) return;
      } catch (_) {
        storageError = true;
      }
      if (!mounted || !_isOwner) return;
      setState(() {
        _devices = devices;
        _profile = profile;
        if (storageError) {
          _message = [
            ?guidance,
            'Could not read this device’s secure profile. Local cleanup may need attention.',
          ].join(' ');
        }
      });
    } catch (_) {
      if (!mounted || !_isOwner) return;
      setState(
        () => _message = [
          ?guidance,
          'Could not load devices. Check your connection and pull down to try again.',
        ].join(' '),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirmRevoke(Map<String, dynamic> device) async {
    if (_busy || !_isOwner) return;
    final prefix = device['prefix'] as String;
    final name = _name(device);
    final confirmed = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (context) => Container(
        padding: const EdgeInsets.fromLTRB(24, 24, 24, 32),
        decoration: const BoxDecoration(
          color: AppColours.paperTop,
          borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
        ),
        child: SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Icon(
                Icons.phonelink_erase,
                color: AppColours.orange,
                size: 36,
              ),
              const SizedBox(height: 16),
              const Text(
                'Revoke this device?',
                style: TextStyle(
                  color: AppColours.ink,
                  fontSize: 23,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 10),
              Text(
                '$name · $prefix will no longer be able to create redeemable codes. This does not revoke your spending permission.',
                style: const TextStyle(color: AppColours.subtle),
              ),
              const SizedBox(height: 24),
              FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: AppColours.orange,
                  foregroundColor: AppColours.ink,
                ),
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Revoke device'),
              ),
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Keep device'),
              ),
            ],
          ),
        ),
      ),
    );
    if (confirmed != true || !mounted || !_isOwner || _busy) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    String? guidance;
    try {
      final response = await getIt<ApiClient>().dio.post(
        '/devices/totp/$prefix/revoke',
      );
      final result = response.data;
      if (result is! Map ||
          result['prefix'] != prefix ||
          result['status'] != 'REVOKED') {
        throw const FormatException('Unconfirmed revocation');
      }
      if (!_isOwner) return;
      var cleanupFailed = false;
      try {
        final profile = await _store.read(widget.ownerId);
        if (profile?.prefix == prefix && _isOwner) {
          await _store.delete(widget.ownerId);
        }
      } catch (_) {
        cleanupFailed = true;
      }
      if (!mounted || !_isOwner) return;
      guidance = cleanupFailed
          ? 'Device $prefix was revoked, but secure local cleanup failed. Use the device list to retry local removal.'
          : 'Device $prefix revoked.';
    } catch (_) {
      if (!mounted || !_isOwner) return;
      guidance = 'Revocation could not be confirmed. It may have succeeded; check the device list before taking further action. No local data was cleared.';
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (mounted && _isOwner) {
      await _load(guidance: guidance);
    }
  }

  Future<void> _removeRevokedLocalProfile(String prefix) async {
    if (_busy || !_isOwner) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final devices = await _fetchDevices();
      if (!mounted || !_isOwner) return;
      final matches = devices
          .where((device) => device['prefix'] == prefix)
          .toList();
      final profile = await _store.read(widget.ownerId);
      if (!mounted || !_isOwner) return;
      if (matches.length != 1 ||
          matches.single['status'] != 'REVOKED' ||
          profile?.prefix != prefix) {
        setState(
          () => _message = 'Local cleanup was not performed: the device state changed or revocation could not be confirmed.',
        );
        return;
      }
      await _store.delete(widget.ownerId);
      if (!mounted || !_isOwner) return;
      setState(() {
        _profile = null;
        _devices = devices;
        _message = 'The revoked device profile was removed from this device.';
      });
    } catch (_) {
      if (mounted && _isOwner) {
        setState(
          () => _message = 'Could not confirm revocation or remove the local profile. Refresh and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _name(Map<String, dynamic> device) {
    final name = device['deviceName'];
    return name is String && name.trim().isNotEmpty ? name : 'Unnamed device';
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * .85,
      ),
      decoration: const BoxDecoration(
        color: AppColours.paperTop,
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      child: SafeArea(
        top: false,
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            shrinkWrap: true,
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
            children: [
              Center(
                child: Container(
                  width: 42,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppColours.fieldBorder,
                    borderRadius: BorderRadius.circular(4),
                  ),
                ),
              ),
              const SizedBox(height: 24),
              const Text(
                'YOUR SECURITY',
                style: TextStyle(
                  color: AppColours.eyebrow,
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.2,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'Devices',
                style: TextStyle(
                  color: AppColours.ink,
                  fontSize: 28,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'Manage devices registered to create offline payment codes.',
                style: TextStyle(color: AppColours.subtle),
              ),
              const SizedBox(height: 20),
              if (_busy) const Center(child: CircularProgressIndicator()),
              if (_message != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Text(
                    _message!,
                    style: const TextStyle(color: AppColours.ink),
                  ),
                ),
              if (_devices != null && _devices!.isEmpty)
                const Text('No registered devices.'),
              for (final device in _devices ?? <Map<String, dynamic>>[])
                Container(
                  margin: const EdgeInsets.only(bottom: 12),
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: AppColours.fieldFill,
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: AppColours.fieldBorder),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(
                            Icons.phone_android,
                            color: AppColours.cobalt,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              _name(device),
                              style: const TextStyle(
                                color: AppColours.ink,
                                fontWeight: FontWeight.w800,
                                fontSize: 16,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(
                        '${device['prefix']}${_profile?.prefix == device['prefix'] ? ' · This device' : ''}',
                        style: const TextStyle(color: AppColours.subtle),
                      ),
                      Text(
                        'Device: ${device['status']}${device['grantStatus'] is String ? ' · Permission: ${device['grantStatus']}' : ''}',
                        style: const TextStyle(color: AppColours.subtle),
                      ),
                      if (device['expiresAtEpochMs'] is int &&
                          (device['expiresAtEpochMs'] as int) > 0)
                        Text(
                          'Expires: ${DateTime.fromMillisecondsSinceEpoch(device['expiresAtEpochMs'] as int).toLocal().toString().split('.').first}',
                          style: const TextStyle(color: AppColours.subtle),
                        ),
                      if (_profile?.prefix == device['prefix'] &&
                          _profile?.permissionLimit != null)
                        Text(
                          'Maximum per payment: ${_profile!.permissionLimit}',
                          style: const TextStyle(color: AppColours.subtle),
                        ),
                      if (device['status'] == 'ACTIVE')
                        TextButton(
                          onPressed: _busy
                              ? null
                              : () => _confirmRevoke(device),
                          child: const Text(
                            'Revoke device',
                            style: TextStyle(color: AppColours.cobalt),
                          ),
                        ),
                      if (device['status'] == 'REVOKED' &&
                          _profile?.prefix == device['prefix'])
                        TextButton(
                          onPressed: _busy
                              ? null
                              : () => _removeRevokedLocalProfile(
                                  device['prefix'] as String,
                                ),
                          child: const Text('Remove revoked local profile'),
                        ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
