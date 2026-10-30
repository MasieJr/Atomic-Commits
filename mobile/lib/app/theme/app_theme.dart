import 'package:flutter/material.dart';

import 'app_colours.dart';
import 'app_spacing.dart';
import 'app_typography.dart';

abstract final class AppTheme {
  static ThemeData get light {
    final colorScheme =
        ColorScheme.fromSeed(
          seedColor: AppColours.primary,
          brightness: Brightness.light,
        ).copyWith(
          primary: AppColours.primary,
          onPrimary: AppColours.onPrimary,
          surface: AppColours.surface,
          onSurface: AppColours.textPrimary,
          error: AppColours.error,
          outline: AppColours.border,
          surfaceContainerLow: AppColours.background,
          surfaceContainerHighest: AppColours.surfaceMuted,
        );

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: AppColours.background,

      appBarTheme: const AppBarTheme(
        backgroundColor: AppColours.background,
        foregroundColor: AppColours.textPrimary,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: AppTypography.title,
      ),

      textTheme: const TextTheme(
        displayLarge: AppTypography.display,
        headlineMedium: AppTypography.heading,
        titleLarge: AppTypography.title,
        bodyLarge: AppTypography.body,
        bodyMedium: AppTypography.bodyMedium,
        bodySmall: AppTypography.caption,
        labelLarge: AppTypography.button,
      ),

      dividerTheme: const DividerThemeData(
        color: AppColours.border,
        thickness: 1,
        space: 1,
      ),

      cardTheme: CardThemeData(
        color: AppColours.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppSpacing.cardRadius),
          side: const BorderSide(color: AppColours.border),
        ),
      ),

      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColours.primary,
          foregroundColor: AppColours.onPrimary,
          elevation: 0,
          minimumSize: const Size(double.infinity, AppSpacing.buttonHeight),
          textStyle: AppTypography.button,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppSpacing.buttonRadius),
          ),
        ),
      ),

      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColours.primary,
          minimumSize: const Size(double.infinity, AppSpacing.buttonHeight),
          textStyle: AppTypography.button,
          side: const BorderSide(color: AppColours.border),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppSpacing.buttonRadius),
          ),
        ),
      ),

      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: AppColours.primary,
          textStyle: AppTypography.button,
        ),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColours.surface,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg,
          vertical: AppSpacing.lg,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppSpacing.inputRadius),
          borderSide: const BorderSide(color: AppColours.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppSpacing.inputRadius),
          borderSide: const BorderSide(color: AppColours.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppSpacing.inputRadius),
          borderSide: const BorderSide(color: AppColours.primary, width: 1.5),
        ),
      ),

      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: AppColours.primary,
        linearTrackColor: AppColours.surfaceMuted,
      ),

      iconTheme: const IconThemeData(color: AppColours.primary, size: 22),
    );
  }
}
