#Requires -Version 5.1
<#
.SYNOPSIS
    Agendo setup script for Windows — from git clone to running instance.

.DESCRIPTION
    Mirrors the logic of scripts/setup.sh for Windows PowerShell.

.PARAMETER Dev
    Skip production builds (use pnpm dev instead).

.EXAMPLE
    .\scripts\install.ps1
    .\scripts\install.ps1 -Dev
#>

[CmdletBinding()]
param(
    [switch]$Dev
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Info($msg)  { Write-Host "[+] $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }

function Test-CommandExists($cmd) {
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Get-CommandPath($cmd) {
    $c = Get-Command $cmd -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

function Test-PgReady {
    # Try via Docker
    if ($script:HaveDocker -and (Test-Path (Join-Path $ProjectRoot "docker-compose.yml"))) {
        try {
            $null = & docker compose exec -T postgres pg_isready -q 2>$null
            if ($LASTEXITCODE -eq 0) { return $true }
        } catch {}
    }
    # Try via Node.js pg client
    if (Test-Path (Join-Path $ProjectRoot "node_modules")) {
        $dbUrl = if ($env:DATABASE_URL) { $env:DATABASE_URL } else { "postgresql://agendo:agendo@localhost:5432/agendo" }
        try {
            $null = & node -e "const pg=require('pg');const c=new pg.Client('$dbUrl');c.connect().then(()=>{c.end();process.exit(0)}).catch(()=>process.exit(1))" 2>$null
            if ($LASTEXITCODE -eq 0) { return $true }
        } catch {}
    }
    return $false
}

# ---------------------------------------------------------------------------
# Resolve project root (parent of scripts/)
# ---------------------------------------------------------------------------

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $ProjectRoot
try {

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "=== Agendo Setup ==="
Write-Host ""

# -- Node.js 22+ --
if (-not (Test-CommandExists "node")) {
    Fail "node not found. Install Node.js 22+: https://nodejs.org"
}
$nodeVersion = & node --version 2>$null
$nodeMajor = [int]($nodeVersion -replace '^v','').Split('.')[0]
if ($nodeMajor -lt 22) {
    Fail "node version $nodeVersion found, but 22+ required."
}
Info "node found: $(Get-CommandPath 'node')"

# -- pnpm --
if (-not (Test-CommandExists "pnpm")) {
    Fail "pnpm not found. Install pnpm: npm install -g pnpm"
}
Info "pnpm found: $(Get-CommandPath 'pnpm')"

# -- Docker (optional) --
$script:HaveDocker = $true
if (-not (Test-CommandExists "docker")) {
    $script:HaveDocker = $false
    Warn "Docker not found. You'll need PostgreSQL running separately."
    Warn "Install Docker: https://docs.docker.com/get-docker/"
}

# -- RAM check --
try {
    $totalBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    $totalGB = [math]::Round($totalBytes / 1GB, 1)
    if ($totalGB -lt 4) {
        Warn "Low memory detected (${totalGB}GB). Builds may fail."
        Warn "Consider closing other applications before continuing."
    }
} catch {
    # Non-fatal — CIM may not be available in all environments
}

# -- Build tools check (needed by node-pty native addon) --
$hasBuildTools = $false
# Check for cl.exe (Visual Studio / Build Tools)
if (Test-CommandExists "cl") {
    $hasBuildTools = $true
}
# Check common VS Build Tools install paths
if (-not $hasBuildTools) {
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vsWhere) {
        $vsInstall = & $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($vsInstall) { $hasBuildTools = $true }
    }
}
# Check for windows-build-tools global npm package
if (-not $hasBuildTools) {
    try {
        $npmList = & npm list -g windows-build-tools 2>$null
        if ($LASTEXITCODE -eq 0 -and $npmList -match "windows-build-tools") {
            $hasBuildTools = $true
        }
    } catch {}
}

if (-not $hasBuildTools) {
    Warn "No C++ build tools found. node-pty requires native compilation."
    Warn "Install Visual Studio Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/"
    Warn "Or run: npm install -g windows-build-tools  (from an elevated prompt)"
}

# ---------------------------------------------------------------------------
# 2. Environment file
# ---------------------------------------------------------------------------

$envLocalPath = Join-Path $ProjectRoot ".env.local"
$envExamplePath = Join-Path $ProjectRoot ".env.example"

if (-not (Test-Path $envLocalPath)) {
    Info "Creating .env.local from .env.example..."
    Copy-Item $envExamplePath $envLocalPath

    # Auto-generate JWT_SECRET (32 bytes → 64-char hex)
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $jwtSecret = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""

    # Replace JWT_SECRET= with generated value
    $content = Get-Content $envLocalPath -Raw
    $content = $content -replace '(?m)^JWT_SECRET=$', "JWT_SECRET=$jwtSecret"

    # Expand $HOME to actual user home path
    $homePath = $env:USERPROFILE
    if (-not $homePath) { $homePath = $env:HOME }
    if ($homePath) {
        $content = $content -replace '\$HOME', ($homePath -replace '\\', '/')
    }

    Set-Content $envLocalPath $content -NoNewline
    Info "Generated JWT_SECRET automatically."
} else {
    Info ".env.local already exists, keeping it."
}

# ---------------------------------------------------------------------------
# 3. Copy ecosystem.config.example.js (if missing)
# ---------------------------------------------------------------------------

$ecoConfigPath = Join-Path $ProjectRoot "ecosystem.config.js"
$ecoExamplePath = Join-Path $ProjectRoot "ecosystem.config.example.js"

if (-not (Test-Path $ecoConfigPath)) {
    if (Test-Path $ecoExamplePath) {
        Copy-Item $ecoExamplePath $ecoConfigPath
        Info "Created ecosystem.config.js from example."
    }
} else {
    Info "ecosystem.config.js already exists, keeping it."
}

# ---------------------------------------------------------------------------
# 4. Create log directory
# ---------------------------------------------------------------------------

$logsDir = Join-Path $ProjectRoot "logs"
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}
Info "Log directory ready: .\logs"

# ---------------------------------------------------------------------------
# 5. Install dependencies
# ---------------------------------------------------------------------------

$nodeModulesPath = Join-Path $ProjectRoot "node_modules"
if (-not (Test-Path $nodeModulesPath)) {
    Info "Installing dependencies..."
    & pnpm install
    if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed." }
} else {
    Info "node_modules exists, skipping install. Run 'pnpm install' to update."
}

# ---------------------------------------------------------------------------
# 6. Start PostgreSQL (Docker)
# ---------------------------------------------------------------------------

if ($env:SKIP_DB -eq "1") {
    Warn "SKIP_DB=1 — skipping PostgreSQL check."
} elseif ($script:HaveDocker -and (Test-Path (Join-Path $ProjectRoot "docker-compose.yml"))) {
    if (Test-PgReady) {
        Info "PostgreSQL is already running."
    } else {
        Info "Starting PostgreSQL via Docker Compose..."
        & docker compose up -d
        if ($LASTEXITCODE -ne 0) { Fail "docker compose up failed." }

        Write-Host "  Waiting for PostgreSQL" -NoNewline
        $ready = $false
        for ($i = 1; $i -le 30; $i++) {
            if (Test-PgReady) {
                Write-Host ""
                Info "PostgreSQL is ready."
                $ready = $true
                break
            }
            Write-Host "." -NoNewline
            Start-Sleep -Seconds 1
        }
        if (-not $ready) {
            Write-Host ""
            Fail "PostgreSQL did not become ready in 30 seconds."
        }
    }
} else {
    if (-not (Test-PgReady)) {
        Warn "PostgreSQL does not appear to be running."
        Warn "Start it manually and ensure DATABASE_URL in .env.local is correct."
    } else {
        Info "PostgreSQL is running."
    }
}

# ---------------------------------------------------------------------------
# 7. Build (production only)
# ---------------------------------------------------------------------------

if (-not $Dev) {
    Info "Building Next.js app..."
    & pnpm build
    if ($LASTEXITCODE -ne 0) { Fail "pnpm build failed." }

    Info "Building worker..."
    & pnpm worker:build
    if ($LASTEXITCODE -ne 0) { Fail "pnpm worker:build failed." }

    Info "Building MCP server..."
    & pnpm build:mcp
    if ($LASTEXITCODE -ne 0) { Fail "pnpm build:mcp failed." }
} else {
    Info "Dev mode — skipping build step."
}

# ---------------------------------------------------------------------------
# 8. Database setup
# ---------------------------------------------------------------------------

if ($env:SKIP_DB -eq "1") {
    Warn "SKIP_DB=1 — skipping database setup and seed."
} else {
    Info "Setting up database schema (drizzle-kit push)..."
    & pnpm db:setup
    if ($LASTEXITCODE -ne 0) { Fail "pnpm db:setup failed." }

    Info "Seeding database (agent discovery)..."
    & pnpm db:seed
    if ($LASTEXITCODE -ne 0) { Fail "pnpm db:seed failed." }
}

# ---------------------------------------------------------------------------
# 9. Done
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "=== Setup complete! ==="
Write-Host ""

$port = if ($env:PORT) { $env:PORT } else { "4100" }

if ($Dev) {
    Write-Host "Start in development mode:"
    Write-Host ""
    Write-Host "  # Single command (recommended) — runs app, worker, and terminal server"
    Write-Host "  pnpm dev:all"
    Write-Host ""
    Write-Host "  # Or run each service separately:"
    Write-Host ""
    Write-Host "  # Terminal 1 — Next.js app"
    Write-Host "  pnpm dev"
    Write-Host ""
    Write-Host "  # Terminal 2 — Worker (hot-reload)"
    Write-Host "  pnpm worker:dev"
    Write-Host ""
    Write-Host "  # Terminal 3 — Terminal server (optional)"
    Write-Host "  pnpm terminal:dev"
    Write-Host ""
} else {
    Write-Host "Start the app:"
    Write-Host ""
    Write-Host "  # Simple (foreground)"
    Write-Host "  pnpm start & node dist/worker/index.js &"
    Write-Host ""
    Write-Host "  # Or with PM2 (recommended for always-on):"
    Write-Host "  npm install -g pm2"
    Write-Host "  cp ecosystem.config.example.js ecosystem.config.js"
    Write-Host "  pm2 start ecosystem.config.js"
    Write-Host "  pm2 save"
    Write-Host ""
}

Write-Host "Verify: .\scripts\smoke-test.ps1  (or .\scripts\smoke-test.sh in WSL)"
Write-Host "Open:   http://localhost:$port"
Write-Host ""

} finally {
    Pop-Location
}
