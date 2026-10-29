@echo off
setlocal DisableDelayedExpansion
set "ATOMIC_CLI=%~dp0backend\dist\src\commands\atomic.js"

where node >nul 2>&1
if errorlevel 1 goto missing_node
if not exist "%ATOMIC_CLI%" goto missing_build
if not "%~1"=="" goto command_line
node "%ATOMIC_CLI%" setup >nul
if errorlevel 1 goto setup_failed

:menu
cls
echo ========================================
echo          Atomic Offline Payments
echo ========================================
echo.
echo  1. Show payment code
echo  2. Check device status and JSON location
echo  3. Exit
echo.
echo A merchant backend must register this device to redeem its codes.
echo.
choice /c 123 /n /m "Choose [1-3]: "
if errorlevel 3 goto quit
if errorlevel 2 goto status
if errorlevel 1 goto pay
goto quit

:pay
cls
echo ========== Payment code ==========
echo.
node "%ATOMIC_CLI%" pay
if errorlevel 1 goto return_to_menu
echo.
echo Codes change at 30-second clock boundaries.
echo The expiration time above uses your device clock.
echo.
choice /c RM /n /m "[R] Refresh code  [M] Main menu: "
if errorlevel 2 goto menu
goto pay

:status
cls
echo ========== Device status ==========
echo.
node "%ATOMIC_CLI%" status
goto return_to_menu

:return_to_menu
echo.
pause
goto menu

:command_line
if /i "%~1"=="pay" goto setup_command_line
if /i "%~1"=="status" goto setup_command_line
node "%ATOMIC_CLI%" %*
exit /b %errorlevel%

:setup_command_line
node "%ATOMIC_CLI%" setup >nul
if errorlevel 1 exit /b 1
node "%ATOMIC_CLI%" %*
exit /b %errorlevel%

:setup_failed
echo Local device setup failed. Check the error above before continuing.
pause
exit /b 1

:missing_node
echo Node.js 20 or newer was not found. Install it while online and try again.
if "%~1"=="" pause
exit /b 1

:missing_build
echo The CLI has not been built yet. While online, open PowerShell and run:
echo   Set-Location "%~dp0backend"
echo   npm ci
echo   npm run build
if "%~1"=="" pause
exit /b 1

:quit
exit /b 0
