$ErrorActionPreference = "Stop"

$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    # 12 cryptographically random bytes encode to exactly 16 URL-safe Base64 characters.
    $bytes = New-Object byte[] 12
    $rng.GetBytes($bytes)
}
finally {
    $rng.Dispose()
}

$CacaOwnerCode = [Convert]::ToBase64String($bytes).
    TrimEnd('=').
    Replace('+', '-').
    Replace('/', '_')

Set-Clipboard -Value $CacaOwnerCode
Write-Host "CACA Site Owner setup code: $CacaOwnerCode" -ForegroundColor Cyan
Write-Host "Copied to clipboard. Keep it private." -ForegroundColor Green
