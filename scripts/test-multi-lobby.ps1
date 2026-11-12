$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$workerDir = Join-Path $repoRoot "cloudflare/uno-worker"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 22 or newer is required." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required." }

Push-Location $workerDir
try {
    Write-Host "[1/3] Installing Worker test tooling..." -ForegroundColor Cyan
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

    Write-Host "[2/3] Running Worker and lobby-isolation tests..." -ForegroundColor Cyan
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Automated tests failed." }

    Write-Host "[3/3] Checking browser modules and Worker deployment bundle..." -ForegroundColor Cyan
    $browserFiles = @(
        "../../games/registry.js",
        "../../games/uno/state.js",
        "../../games/uno/ui.js",
        "../../games/vampir-koylu/engine.js",
        "../../games/vampir-koylu/bots.js",
        "../../games/vampir-koylu/index.js",
        "../../games/vampir-koylu/state.js",
        "../../games/vampir-koylu/ui.js",
        "../../js/rooms-ui.js"
    )
    foreach ($file in $browserFiles) {
        Get-Content $file -Raw | node --input-type=module --check
        if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $file" }
    }
    npx wrangler deploy --dry-run
    if ($LASTEXITCODE -ne 0) { throw "Wrangler dry-run failed." }

    Write-Host "All local multi-lobby checks passed." -ForegroundColor Green
}
finally { Pop-Location }
