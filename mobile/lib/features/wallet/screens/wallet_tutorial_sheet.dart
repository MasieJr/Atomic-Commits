import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:flutter/material.dart';

class WalletCreateTutorialSheet extends StatefulWidget {
  const WalletCreateTutorialSheet({super.key, required this.onOpenSite});

  final VoidCallback onOpenSite;

  @override
  State<WalletCreateTutorialSheet> createState() =>
      _WalletCreateTutorialSheetState();
}

class WalletConnectTutorialSheet extends StatefulWidget {
  const WalletConnectTutorialSheet({super.key, required this.onContinue});

  final VoidCallback onContinue;

  @override
  State<WalletConnectTutorialSheet> createState() =>
      _WalletConnectTutorialSheetState();
}

class _TutorialStep {
  const _TutorialStep({
    required this.title,
    required this.body,
    this.image,
    this.icon,
  });

  final String title;
  final String body;
  final String? image;
  final IconData? icon;
}

const _createSteps = [
  _TutorialStep(
    title: 'Navigate and fill in',
    body:
        'Go to wallet.interledger-test.dev and fill in the sign-up form. '
        'Enter an email address and a password of at least 8 characters.',
    image: 'assets/images/wallet_tutorial/signup-fields.png',
  ),
  _TutorialStep(
    title: 'Use your own email',
    body:
        'Enter an email address you can access so you can receive the '
        'verification message. Create your own password and submit the '
        'form. Do not copy an email address from a screenshot.',
    icon: Icons.alternate_email,
  ),
  _TutorialStep(
    title: 'Open your account',
    body:
        'On the dashboard, select your account card (boxed) to open it and '
        'see its wallet.',
    image: 'assets/images/wallet_tutorial/dashboard-account.png',
  ),
  _TutorialStep(
    title: 'Confirm and verify',
    body:
        'Open the confirmation email and tap the link, then follow the '
        'identity check. It takes about 10 minutes.',
    icon: Icons.mark_email_read_outlined,
  ),
  _TutorialStep(
    title: 'Copy your address',
    body:
        'Under Wallet Address list, copy the boxed \$ilp payment pointer — '
        'you will paste it in the app next.',
    image: 'assets/images/wallet_tutorial/wallet-address-list.png',
  ),
];

const _connectSteps = [
  _TutorialStep(
    title: 'Open your account',
    body:
        'On the Test Wallet dashboard, select your account card (boxed) to '
        'open it and see its wallet.',
    image: 'assets/images/wallet_tutorial/dashboard-account.png',
  ),
  _TutorialStep(
    title: 'Copy your address',
    body:
        'Under Wallet Address list, copy the boxed \$ilp payment pointer. '
        'Paste it in the app to connect.',
    image: 'assets/images/wallet_tutorial/wallet-address-list.png',
  ),
];

class _WalletCreateTutorialSheetState extends State<WalletCreateTutorialSheet> {
  final _controller = PageController();
  int _step = 0;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _advance() {
    if (_step < _createSteps.length - 1) {
      _controller.nextPage(
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut,
      );
      return;
    }
    Navigator.pop(context);
    widget.onOpenSite();
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.xl,
          AppSpacing.md,
          AppSpacing.xl,
          AppSpacing.xl,
        ),
        child: Column(
          children: [
            Row(
              children: [
                const SizedBox(width: 64),
                Expanded(
                  child: Center(
                    child: Container(
                      width: 40,
                      height: 4,
                      decoration: BoxDecoration(
                        color: AppColours.fieldBorder,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                ),
                SizedBox(
                  width: 64,
                  child: TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Skip'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Expanded(
              child: PageView(
                controller: _controller,
                onPageChanged: (index) => setState(() => _step = index),
                children: [
                  for (final item in _createSteps) _StepView(step: item),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                for (var i = 0; i < _createSteps.length; i++)
                  Container(
                    margin: const EdgeInsets.only(right: 6),
                    width: i == _step ? 22 : 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: i == _step
                          ? AppColours.cobalt
                          : AppColours.fieldBorder,
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                const Spacer(),
                FilledButton(
                  onPressed: _advance,
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColours.cobalt,
                    foregroundColor: Colors.white,
                    minimumSize: const Size(0, AppSpacing.buttonHeight),
                    padding: const EdgeInsets.symmetric(horizontal: 24),
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
                  child: Text(
                    _step == _createSteps.length - 1
                        ? 'Open sign-up page'
                        : 'Next',
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _WalletConnectTutorialSheetState
    extends State<WalletConnectTutorialSheet> {
  final _controller = PageController();
  int _step = 0;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _advance() {
    if (_step < _connectSteps.length - 1) {
      _controller.nextPage(
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut,
      );
      return;
    }
    Navigator.pop(context);
    widget.onContinue();
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.xl,
          AppSpacing.md,
          AppSpacing.xl,
          AppSpacing.xl,
        ),
        child: Column(
          children: [
            Row(
              children: [
                const SizedBox(width: 64),
                Expanded(
                  child: Center(
                    child: Container(
                      width: 40,
                      height: 4,
                      decoration: BoxDecoration(
                        color: AppColours.fieldBorder,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                ),
                SizedBox(
                  width: 64,
                  child: TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Skip'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Expanded(
              child: PageView(
                controller: _controller,
                onPageChanged: (index) => setState(() => _step = index),
                children: [
                  for (final item in _connectSteps) _StepView(step: item),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                for (var i = 0; i < _connectSteps.length; i++)
                  Container(
                    margin: const EdgeInsets.only(right: 6),
                    width: i == _step ? 22 : 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: i == _step
                          ? AppColours.cobalt
                          : AppColours.fieldBorder,
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                const Spacer(),
                FilledButton(
                  onPressed: _advance,
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColours.cobalt,
                    foregroundColor: Colors.white,
                    minimumSize: const Size(0, AppSpacing.buttonHeight),
                    padding: const EdgeInsets.symmetric(horizontal: 24),
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
                  child: Text(
                    _step == _connectSteps.length - 1
                        ? 'Continue'
                        : 'Next',
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _StepView extends StatelessWidget {
  const _StepView({required this.step});

  final _TutorialStep step;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Center(
            child: step.image != null
                ? ClipRRect(
                    borderRadius: BorderRadius.circular(16),
                    child: Image.asset(step.image!, fit: BoxFit.contain),
                  )
                : Container(
                    width: 170,
                    height: 170,
                    decoration: BoxDecoration(
                      color: AppColours.paperMid,
                      borderRadius: BorderRadius.circular(24),
                    ),
                    child: Icon(
                      step.icon,
                      size: 76,
                      color: AppColours.cobalt,
                    ),
                  ),
          ),
        ),
        const SizedBox(height: 20),
        Text(
          step.title,
          style: Theme.of(context).textTheme.titleLarge?.copyWith(
            color: AppColours.ink,
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          step.body,
          style: const TextStyle(color: AppColours.subtle, height: 1.45),
        ),
      ],
    );
  }
}
