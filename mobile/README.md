# Atomic Commits mobile

Flutter frontend for Atomic Commits. The app starts on the illustrated welcome
screen. The app connects to the backend for registration, wallet verification,
spending permission and merchant checkout. See the [sprint tracker](../docs/SPRINT_TRACKER.md)
for the latest verification status.

## Run the browser preview

From this `mobile` directory:

```sh
flutter pub get
flutter run -d edge --web-port 53211 --dart-define=ATOMIC_API_BASE_URL=https://YOUR_API_ORIGIN/api
```

This runs the Flutter app in Edge using the web entry point in `web/index.html`.
Android Studio, an Android SDK, and an emulator are not required for this preview.

If Flutter is installed under `Development/SDKs` but is not on your Windows PATH,
use PowerShell:

```powershell
$flutter = Join-Path $env:USERPROFILE 'Development\SDKs\flutter\bin\flutter.bat'
& $flutter run -d edge --web-port 53211 --dart-define=ATOMIC_API_BASE_URL=https://YOUR_API_ORIGIN/api
```

In Edge, open DevTools with **F12**, then press **Ctrl+Shift+M** to enable device
emulation and choose a phone size. Keep the Flutter terminal open; press **r** to
hot reload, **R** to restart, or **q** to stop.

Set `WEB_ALLOWED_ORIGINS=http://localhost:53211` in the backend environment for
this browser origin. Use the exact origin shown by the browser. For Android,
set the same API URL with `--dart-define` when running or building the app. The
default API origin is `http://localhost:3000/api`; a remote API requires HTTPS.
The [demo runbook](../docs/DEMO_RUNBOOK.md) lists the provider and Supabase setup.

## Checks

```sh
flutter test
flutter analyze
flutter build web
```

For a JavaScript-only web build on a memory-constrained machine, use
`flutter build web --debug --no-pub --no-wasm-dry-run`. To run the optional
browser smoke test against simulated API responses:

```powershell
npm install --no-save --no-package-lock --prefix tool playwright-core jsqr pngjs
node tool/web_smoke.mjs build/web
```

The smoke test defaults to Microsoft Edge's standard Windows path. Set
`ATOMIC_BROWSER_EXE` to another Chromium-based browser executable if needed.
It creates no provider payments. For the JavaScript TOTP interoperability
check, compile `tool/verify_totp_web.dart` and run the result with Node.js:

```powershell
dart compile js --packages=.dart_tool/package_config.json tool/verify_totp_web.dart -o build/totp-check.js
node build/totp-check.js
```
