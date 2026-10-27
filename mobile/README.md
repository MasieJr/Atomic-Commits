# Atomic Commits mobile

Flutter frontend for Atomic Commits. The app starts on the illustrated welcome
screen.

## Run the browser preview

From this `mobile` directory:

```sh
flutter pub get
flutter run -d edge
```

This runs the Flutter app in Edge using the web entry point in `web/index.html`.
Android Studio, an Android SDK, and an emulator are not required for this preview.

If Flutter is installed under `Development/SDKs` but is not on your Windows PATH,
use PowerShell:

```powershell
$flutter = Join-Path $env:USERPROFILE 'Development\SDKs\flutter\bin\flutter.bat'
& $flutter run -d edge
```

In Edge, open DevTools with **F12**, then press **Ctrl+Shift+M** to enable device
emulation and choose a phone size. Keep the Flutter terminal open; press **r** to
hot reload, **R** to restart, or **q** to stop.

## Checks

```sh
flutter test
flutter analyze
flutter build web
```
