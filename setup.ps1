# First-time setup for Altrium CRM. Safe to re-run — every step checks
# whether it's already done before doing it.
#
# Usage:  .\setup.ps1
# If Windows blocks the script ("running scripts is disabled on this
# system"), run it instead with:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot

function Write-Step($message) {
    Write-Host ""
    Write-Host "==> $message" -ForegroundColor Cyan
}

function Write-Warn($message) {
    Write-Host "  $message" -ForegroundColor Yellow
}

function Get-EnvValue($path, $key, $default) {
    if (Test-Path $path) {
        $line = Get-Content $path | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
        if ($line) {
            return ($line -replace "^$key=", '').Trim()
        }
    }
    return $default
}

function Set-EnvValue($path, $key, $value) {
    $lines = Get-Content -Path $path
    if ($lines | Where-Object { $_ -match "^$key=" }) {
        $newLines = $lines | ForEach-Object { if ($_ -match "^$key=") { "$key=$value" } else { $_ } }
    } else {
        $newLines = $lines + "$key=$value"
    }
    Set-Content -Path $path -Value $newLines
}

function Set-UrlPort($path, $key, $newPort) {
    # Replaces just the :<port> segment of a URL value (e.g. BACKEND_URL or
    # DATABASE_URL), leaving scheme/user/pass/host/db name untouched.
    $lines = Get-Content -Path $path
    $newLines = $lines | ForEach-Object {
        if ($_ -match "^$key=") { $_ -replace ':\d+(?=/|$)', ":$newPort" } else { $_ }
    }
    Set-Content -Path $path -Value $newLines
}

function Get-PortFromUrl($url, $default) {
    if ($url -match ':(\d+)(?:/|$)') {
        return [int]$Matches[1]
    }
    return $default
}

# -- port availability ------------------------------------------------------

function Get-HyperVExcludedRanges {
    # Windows reserves TCP port ranges for Hyper-V/WSL, and they shift on
    # every reboot -- binding one fails with an access-permissions error even
    # though nothing is "using" it. netsh is the only way to see them.
    try {
        $output = netsh interface ipv4 show excludedportrange protocol=tcp 2>$null
    } catch {
        return @()
    }
    $ranges = @()
    foreach ($line in $output) {
        if ($line -match '^\s*(\d+)\s+(\d+)') {
            $ranges += [PSCustomObject]@{ Start = [int]$Matches[1]; End = [int]$Matches[2] }
        }
    }
    return $ranges
}

function Test-PortExcluded([int]$port, $ranges) {
    foreach ($range in $ranges) {
        if ($port -ge $range.Start -and $port -le $range.End) {
            return $true
        }
    }
    return $false
}

function Test-PortBindable([int]$port) {
    # The real test: can something actually listen here? Covers "another
    # process already has it" (bind throws address-in-use) the same way it
    # covers a Hyper-V-excluded port (bind throws access-denied) -- the
    # excluded-range check above exists only so the printed reason is
    # specific instead of a generic "in use".
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $port)
        $listener.Start()
        $listener.Stop()
        return $true
    } catch {
        return $false
    }
}

function Resolve-Port {
    param(
        [int]$DesiredPort,
        [int]$ScanStart,
        [string]$Label,
        $ExcludedRanges
    )
    $reason = $null
    if (Test-PortExcluded $DesiredPort $ExcludedRanges) {
        $reason = "falls inside a Windows-reserved (Hyper-V) port range"
    } elseif (-not (Test-PortBindable $DesiredPort)) {
        $reason = "is already in use by another process"
    } else {
        Write-Host "  $Label`: $DesiredPort" -ForegroundColor Green
        return $DesiredPort
    }

    $candidate = $ScanStart
    $attempts = 0
    while ($attempts -lt 200) {
        if ((-not (Test-PortExcluded $candidate $ExcludedRanges)) -and (Test-PortBindable $candidate)) {
            Write-Warn "Port $DesiredPort ($Label) $reason. Using $candidate instead."
            return $candidate
        }
        $candidate++
        $attempts++
    }
    Write-Host "Could not find a free port for $Label after scanning from $ScanStart." -ForegroundColor Red
    exit 1
}

try {
    # -- 1. Environment files ------------------------------------------------
    Write-Step "Environment files"
    $envPairs = @(
        @{ Example = Join-Path $repoRoot '.env.example'; Target = Join-Path $repoRoot '.env' },
        @{ Example = Join-Path $repoRoot 'backend\.env.example'; Target = Join-Path $repoRoot 'backend\.env' },
        @{ Example = Join-Path $repoRoot 'frontend\.env.example'; Target = Join-Path $repoRoot 'frontend\.env' }
    )
    foreach ($pair in $envPairs) {
        if (Test-Path $pair.Target) {
            Write-Host "  $($pair.Target) already exists, skipping."
        } else {
            Copy-Item -Path $pair.Example -Destination $pair.Target
            Write-Host "  Created $($pair.Target)."
        }
    }

    # -- 2. Docker check (needed before we can check for an existing container) -
    Write-Step "Docker"
    $dockerOk = $false
    try {
        docker info *> $null
        $dockerOk = ($LASTEXITCODE -eq 0)
    } catch {
        $dockerOk = $false
    }
    if (-not $dockerOk) {
        Write-Host "Docker doesn't appear to be running (or isn't installed)." -ForegroundColor Red
        Write-Host "Start Docker Desktop, then re-run this script." -ForegroundColor Red
        exit 1
    }
    Write-Host "  Docker is running."

    # -- 3. Ports --------------------------------------------------------------
    Write-Step "Ports"
    $excludedRanges = Get-HyperVExcludedRanges

    $rootEnvPath = Join-Path $repoRoot '.env'
    $backendEnvPath = Join-Path $repoRoot 'backend\.env'
    $frontendEnvPath = Join-Path $repoRoot 'frontend\.env'

    $existingContainer = (docker ps -a --filter "name=^altrium-crm-db-1$" --format "{{.Names}}" 2>$null | Select-Object -First 1)
    $dbPort = [int](Get-EnvValue $rootEnvPath 'DB_PORT' '5432')
    if ($existingContainer -eq 'altrium-crm-db-1') {
        Write-Host "  Postgres: $dbPort (reusing existing altrium-crm-db-1 container)" -ForegroundColor Green
    } else {
        $newDbPort = Resolve-Port -DesiredPort $dbPort -ScanStart 15432 -Label 'Postgres' -ExcludedRanges $excludedRanges
        if ($newDbPort -ne $dbPort) {
            Set-EnvValue $rootEnvPath 'DB_PORT' $newDbPort
            Set-UrlPort $backendEnvPath 'DATABASE_URL' $newDbPort
            Set-EnvValue $backendEnvPath 'DB_PORT' $newDbPort
        }
        $dbPort = $newDbPort
    }

    $backendUrl = Get-EnvValue $frontendEnvPath 'BACKEND_URL' 'http://localhost:9000'
    $djangoPort = Get-PortFromUrl $backendUrl 9000
    $newDjangoPort = Resolve-Port -DesiredPort $djangoPort -ScanStart ($djangoPort + 1) -Label 'Django' -ExcludedRanges $excludedRanges
    if ($newDjangoPort -ne $djangoPort) {
        Set-UrlPort $frontendEnvPath 'BACKEND_URL' $newDjangoPort
    }
    $djangoPort = $newDjangoPort

    $frontendPort = [int](Get-EnvValue $frontendEnvPath 'FRONTEND_PORT' '3000')
    $newFrontendPort = Resolve-Port -DesiredPort $frontendPort -ScanStart ($frontendPort + 1) -Label 'Vite' -ExcludedRanges $excludedRanges
    if ($newFrontendPort -ne $frontendPort) {
        Set-EnvValue $frontendEnvPath 'FRONTEND_PORT' $newFrontendPort
    }
    $frontendPort = $newFrontendPort

    # -- 4. SECRET_KEY -----------------------------------------------------------
    Write-Step "Django SECRET_KEY"
    $lines = Get-Content -Path $backendEnvPath
    $currentLine = $lines | Where-Object { $_ -match '^SECRET_KEY=' } | Select-Object -First 1
    $currentValue = if ($currentLine) { ($currentLine -replace '^SECRET_KEY=', '').Trim() } else { '' }

    if ([string]::IsNullOrWhiteSpace($currentValue) -or $currentValue -eq 'replace-with-a-50-character-random-string') {
        $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        $secretKey = -join (1..50 | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
        if ($currentLine) {
            $newLines = $lines | ForEach-Object { if ($_ -match '^SECRET_KEY=') { "SECRET_KEY=$secretKey" } else { $_ } }
        } else {
            $newLines = $lines + "SECRET_KEY=$secretKey"
        }
        Set-Content -Path $backendEnvPath -Value $newLines
        Write-Host "  Generated a random SECRET_KEY."
    } else {
        Write-Host "  SECRET_KEY already set, leaving it alone."
    }

    # -- 5. Docker Compose / Postgres ---------------------------------------------
    Write-Step "Database"
    Push-Location $repoRoot
    Write-Host "  Starting the database container..."
    docker compose up -d
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Write-Host "docker compose up failed." -ForegroundColor Red
        exit 1
    }

    Write-Host "  Waiting for Postgres to accept connections..."
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        docker compose exec -T db pg_isready -U altrium -d altrium *> $null
        if ($LASTEXITCODE -eq 0) {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    Pop-Location
    if (-not $ready) {
        Write-Host "Postgres never became ready after 60 seconds. Check 'docker compose logs db'." -ForegroundColor Red
        exit 1
    }
    Write-Host "  Postgres is ready."

    # -- 6. Backend virtual environment + requirements ------------------------
    Write-Step "Backend"
    $venvDir = Join-Path $repoRoot 'backend\.venv'
    $venvPython = Join-Path $venvDir 'Scripts\python.exe'
    if (Test-Path $venvPython) {
        Write-Host "  Virtual environment already exists."
    } else {
        Write-Host "  Creating virtual environment..."
        python -m venv $venvDir
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Failed to create the virtual environment. Is Python 3.12 installed and on PATH?" -ForegroundColor Red
            exit 1
        }
    }

    Write-Host "  Installing requirements..."
    & $venvPython -m pip install --quiet --upgrade pip
    & $venvPython -m pip install --quiet -r (Join-Path $repoRoot 'backend\requirements.txt')
    if ($LASTEXITCODE -ne 0) {
        Write-Host "pip install failed." -ForegroundColor Red
        exit 1
    }

    # -- 7. Migrate + seed demo data -------------------------------------------
    Write-Host "  Running migrations..."
    & $venvPython (Join-Path $repoRoot 'backend\manage.py') migrate
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Migration failed." -ForegroundColor Red
        exit 1
    }

    Write-Host "  Seeding demo data..."
    & $venvPython (Join-Path $repoRoot 'backend\manage.py') seed_demo
    if ($LASTEXITCODE -ne 0) {
        Write-Host "seed_demo failed." -ForegroundColor Red
        exit 1
    }

    # -- 8. Frontend dependencies ----------------------------------------------
    Write-Step "Frontend"
    Write-Host "  Running npm install..."
    Push-Location (Join-Path $repoRoot 'frontend')
    npm install
    $npmExitCode = $LASTEXITCODE
    Pop-Location
    if ($npmExitCode -ne 0) {
        Write-Host "npm install failed." -ForegroundColor Red
        exit 1
    }

    # -- 9. Done ----------------------------------------------------------------
    $backendUrl = Get-EnvValue $frontendEnvPath 'BACKEND_URL' "http://localhost:$djangoPort"
    $backendUrl = $backendUrl.TrimEnd('/')

    Write-Host ""
    Write-Host "==> Setup complete." -ForegroundColor Green
    Write-Host ""
    Write-Host "Start the app with three terminals (or the 'Start Altrium CRM' VS Code task):"
    Write-Host "  docker compose up -d"
    Write-Host "  cd backend; .\.venv\Scripts\Activate.ps1; python manage.py runserver $djangoPort"
    Write-Host "  cd frontend; npm run dev"
    Write-Host ""
    Write-Host "Ports:"
    Write-Host "  Postgres  $dbPort"
    Write-Host "  Django    $djangoPort"
    Write-Host "  Vite      $frontendPort"
    Write-Host ""
    Write-Host "URLs:"
    Write-Host "  App             http://localhost:$frontendPort"
    Write-Host "  Django admin    $backendUrl/admin"
    Write-Host "  API docs        $backendUrl/api/docs"
    Write-Host ""
    Write-Host "Test logins (password: testpass123):"
    Write-Host "  rep1, rep2   Sales Rep"
    Write-Host "  mgr1         Sales Manager"
    Write-Host "  admin        System Admin (superuser)"
    Write-Host ""
} catch {
    Write-Host ""
    Write-Host "Setup failed: $_" -ForegroundColor Red
    exit 1
}
