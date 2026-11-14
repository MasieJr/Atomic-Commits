import 'package:flutter/material.dart';

class SignupTexture extends StatelessWidget {
  const SignupTexture({super.key});

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Stack(
        children: [
          Positioned.fill(child: CustomPaint(painter: _SignupTexturePainter())),
          LayoutBuilder(
            builder: (context, constraints) {
              final w = constraints.maxWidth;
              final h = constraints.maxHeight;
              return Stack(
                children: [
                  Positioned(
                    top: h * 0.05,
                    right: -w * 0.28,
                    width: w * 0.68,
                    height: w * 0.68,
                    child: const DecoratedBox(
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: RadialGradient(
                          colors: [
                            Color(0xBBFFD7A1),
                            Color(0x55FBA75E),
                            Colors.transparent,
                          ],
                          stops: [0, 0.36, 0.7],
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    top: constraints.maxHeight * 0.45,
                    left: -constraints.maxWidth * 0.6,
                    width: constraints.maxWidth * 1.1,
                    height: constraints.maxWidth * 1.1,
                    child: const DecoratedBox(
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: RadialGradient(
                          colors: [Color(0x47FFC078), Colors.transparent],
                          stops: [0, 0.72],
                        ),
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _SignupTexturePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final first = Paint()..color = const Color(0x1B9C6422);
    final second = Paint()..color = const Color(0x15A76C2A);

    void dots(double spacingX, double spacingY, Offset offset, Paint paint) {
      var y = offset.dy;
      while (y < size.height + spacingY) {
        var x = offset.dx;
        while (x < size.width + spacingX) {
          canvas.drawCircle(Offset(x, y), 0.7, paint);
          x += spacingX;
        }
        y += spacingY;
      }
    }

    dots(19, 21, Offset.zero, first);
    dots(29, 31, const Offset(11, 17), second);
  }

  @override
  bool shouldRepaint(_SignupTexturePainter oldDelegate) => false;
}
