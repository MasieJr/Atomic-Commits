param(
    [ValidateSet('all', 'backend', 'frontend')]
    [string]$Target = 'all',
    [ValidateRange(1, 65535)]
    [int]$WebPort = 8080,
    [switch]$SetupOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$tools = Join-Path $env:USERPROFILE 'Development\SDKs'

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command $($Arguments -join ' ') failed. Check the output above."
    }
}

function Initialize-ToolsDirectory {
    if (-not (Test-Path -LiteralPath $env:USERPROFILE -PathType Container)) {
        throw 'The Windows user profile directory could not be found.'
    }
    New-Item -ItemType Directory -Path $tools -Force | Out-Null
}

function Get-Node {
    $installed = Get-Command node.exe -ErrorAction SilentlyContinue
    $candidates = @((Join-Path $tools 'node\node.exe'))
    if ($installed) { $candidates = @($installed.Source) + $candidates }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $version = & $candidate --version
            if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 20) {
                return $candidate
            }
        }
    }

    Initialize-ToolsDirectory
    $destination = Join-Path $tools 'node'
    if (Test-Path -LiteralPath $destination) {
        throw "The Node installation at $destination is incomplete or too old. Move it aside and retry."
    }
    Write-Host "Installing Node.js 22 LTS in $destination..."
    $baseUrl = 'https://nodejs.org/dist/latest-v22.x'
    $checksums = (Invoke-WebRequest "$baseUrl/SHASUMS256.txt" -UseBasicParsing).Content
    $release = [regex]::Match($checksums, '(?m)^([a-f0-9]{64})\s+(node-v22\.\d+\.\d+-win-x64\.zip)\s*$')
    if (-not $release.Success) { throw 'Could not find the official Windows x64 Node.js release.' }
    $temporary = Join-Path $tools ("node-install-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    try {
        $archive = Join-Path $temporary $release.Groups[2].Value
        Invoke-WebRequest "$baseUrl/$($release.Groups[2].Value)" -OutFile $archive -UseBasicParsing
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $release.Groups[1].Value) {
            throw 'The Node.js archive checksum did not match.'
        }
        Expand-Archive -LiteralPath $archive -DestinationPath $temporary
        Move-Item -LiteralPath (Join-Path $temporary ([IO.Path]::GetFileNameWithoutExtension($archive))) -Destination $destination
    } finally {
        Remove-Item -LiteralPath $temporary -Recurse -Force
    }
    return (Join-Path $destination 'node.exe')
}

function Test-Flutter([string]$Command) {
    $output = (& $Command --version --machine) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Flutter could not start. Check its SDK installation and network connection.' }
    $start = $output.IndexOf('{')
    if ($start -lt 0) { throw 'Flutter did not return its SDK version.' }
    $version = $output.Substring($start) | ConvertFrom-Json
    return ([version]($version.frameworkVersion -replace '-.*$', '') -ge [version]'3.47.0' -and
        [version]($version.dartSdkVersion -replace '[- ].*$', '') -ge [version]'3.13.0')
}

function Get-Flutter {
    $installed = Get-Command flutter.bat -ErrorAction SilentlyContinue
    if ($installed -and (Test-Flutter $installed.Source)) { return $installed.Source }
    $destination = Join-Path $tools 'flutter'
    $command = Join-Path $destination 'bin\flutter.bat'
    if (Test-Path -LiteralPath $command -PathType Leaf) {
        if (Test-Flutter $command) { return $command }
        throw "The Flutter SDK at $destination is too old. This project needs Flutter 3.47 and Dart 3.13."
    }
    if (Test-Path -LiteralPath $destination) {
        throw "The Flutter installation at $destination is incomplete. Move it aside and retry."
    }
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { throw 'Git is required to install and run Flutter. Install Git for Windows and retry.' }
    Initialize-ToolsDirectory
    Write-Host "Installing Flutter 3.47.0 in $destination. The first run also downloads its bundled Dart SDK..."
    Invoke-Checked $git.Source @('-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', '3.47.0', 'https://github.com/flutter/flutter.git', $destination)
    if (-not (Test-Flutter $command)) { throw 'The downloaded Flutter SDK does not meet this project''s requirements.' }
    return $command
}

function Get-WebBrowser {
    $chrome = @(
        $env:CHROME_EXECUTABLE,
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($candidate in $chrome) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return $candidate
        }
    }
    foreach ($parent in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        $candidate = Join-Path $parent 'Microsoft\Edge\Application\msedge.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }
    throw 'Install Chrome or Microsoft Edge to run the Flutter frontend in a browser.'
}

function Assert-FreePort([int]$Port) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() }
    catch { throw "Port $Port is already in use. Stop the existing server or choose another port." }
    finally { $listener.Stop() }
}

function Wait-Frontend([int]$Port) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Write-Host 'Waiting for Flutter to compile and serve the app...'
    while ($timer.Elapsed.TotalSeconds -lt 180) {
        $response = $null
        try {
            $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/main.dart.js")
            $request.Method = 'HEAD'
            $request.Timeout = 2000
            $response = $request.GetResponse()
            if ([int]$response.StatusCode -eq 200) { return }
        } catch {
            # Flutter opens its socket before the initial compile is finished.
        } finally {
            if ($response) { $response.Close() }
        }
        Start-Sleep -Milliseconds 500
    }
    throw 'Flutter did not become ready within 3 minutes. Check the frontend terminal for compiler errors.'
}

try {
    $backend = Join-Path $PSScriptRoot 'backend'
    $frontend = Join-Path $PSScriptRoot 'mobile'
    if (-not (Test-Path -LiteralPath (Join-Path $backend 'package.json')) -or
        -not (Test-Path -LiteralPath (Join-Path $frontend 'pubspec.yaml'))) {
        throw 'Keep dev.bat and dev.ps1 in the repository root beside backend and mobile.'
    }

    if ($Target -eq 'backend') {
        $Host.UI.RawUI.WindowTitle = 'Atomic Commits backend'
        Push-Location -LiteralPath $backend
        try { Invoke-Checked 'npm.cmd' @('run', 'dev') } finally { Pop-Location }
        exit 0
    }
    if ($Target -eq 'frontend') {
        $Host.UI.RawUI.WindowTitle = 'Atomic Commits frontend'
        Push-Location -LiteralPath $frontend
        try {
            Invoke-Checked 'flutter.bat' @('run', '-d', 'web-server', '--web-hostname', '127.0.0.1', '--web-port', "$WebPort", '--no-pub', '--no-web-enable-expression-evaluation', '--no-devtools', '--no-web-resources-cdn')
        } finally { Pop-Location }
        exit 0
    }

    Assert-FreePort $WebPort
    $node = Get-Node
    $env:PATH = "$(Split-Path -Parent $node);$env:PATH"

    Push-Location -LiteralPath $backend
    try {
        if (Test-Path -LiteralPath 'package-lock.json') {
            $fingerprint = (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash
            $stamp = Join-Path $backend 'node_modules\.dev-dependencies.sha256'
            $dependenciesReady = (Test-Path -LiteralPath $stamp) -and
                [IO.File]::ReadAllText($stamp).Trim() -eq $fingerprint -and
                (Test-Path -LiteralPath 'node_modules\.bin\tsx.cmd')
            if ($dependenciesReady) {
                $dependenciesReady = & {
                    $ErrorActionPreference = 'Continue'
                    & npm.cmd ls --depth=0 --silent *> $null
                    $LASTEXITCODE -eq 0
                }
            }
            if (-not $dependenciesReady) {
                Invoke-Checked 'npm.cmd' @('ci')
                Set-Content -LiteralPath $stamp -Value $fingerprint -Encoding Ascii
            }
        } else { Invoke-Checked 'npm.cmd' @('install') }
        $configuration = & $node -p "require('dotenv').config(); JSON.stringify({port: Number(process.env.PORT || 3000), authReady: Boolean(process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('REPLACE_WITH_') && process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 32)})"
        if ($LASTEXITCODE -ne 0) { throw 'Could not read the backend environment configuration.' }
        $configuration = $configuration | ConvertFrom-Json
    } finally { Pop-Location }
    $backendPort = [int]$configuration.port
    if ($backendPort -lt 1 -or $backendPort -gt 65535 -or $backendPort -eq $WebPort) {
        throw 'Set a valid backend PORT in backend/.env, different from the frontend web port.'
    }
    Assert-FreePort $backendPort
    if (-not $configuration.authReady) {
        Write-Host 'Auth needs a real DATABASE_URL and SESSION_SECRET in backend/.env. The health endpoint and frontend can still run.'
    }

    $flutter = Get-Flutter
    $env:PATH = "$(Split-Path -Parent $flutter);$env:PATH"
    Push-Location -LiteralPath $frontend
    try {
        Invoke-Checked $flutter @('precache', '--web')
        Invoke-Checked $flutter @('pub', 'get')
    } finally { Pop-Location }
    $browser = Get-WebBrowser
    Write-Host "Backend:  http://localhost:$backendPort"
    Write-Host "Frontend: http://127.0.0.1:$WebPort"
    if ($SetupOnly) { exit 0 }

    foreach ($service in @('backend', 'frontend')) {
        $arguments = '-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "{0}" -Target {1} -WebPort {2}' -f $PSCommandPath, $service, $WebPort
        Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WorkingDirectory $PSScriptRoot
    }
    Wait-Frontend $WebPort
    Start-Process -FilePath $browser -ArgumentList "http://127.0.0.1:$WebPort"
    Write-Host 'Use Ctrl+C in each service window to stop it.'
} catch {
    if ($Target -eq 'all') {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
    throw
}
