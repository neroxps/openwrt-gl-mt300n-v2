# Refresh the vendored frp v3 client (payload/frpc-mipsel-v3).
#
#   powershell -File tools/fetch-frpc-v3.ps1 -Tag v3.0.0
#
# Run this on the DEPLOYMENT MACHINE only. The fork's own README requires that
# its token is never written into any repository, so nothing here fetches at
# build time in CI: this script downloads the release asset with the token that
# Git Credential Manager already holds, checks it, and updates the two files
# that the payload job consumes.
#
# After running it, review the diff and commit:
#   payload/frpc-mipsel-v3          the client the device will run
#   payload/frpc-mipsel-v3.sha256   its digest, verified by CI on every build
param(
    [string]$Tag   = 'v3.0.0',
    [string]$Repo  = 'neroxps/frp-v3',
    [string]$Asset = 'frpc_v3_0.71.0-v3_linux_mipsle',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$env:GIT_TERMINAL_PROMPT = '0'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repoRoot = Split-Path -Parent $PSScriptRoot
$dest     = Join-Path $repoRoot 'payload\frpc-mipsel-v3'
$sumFile  = "$dest.sha256"

$cred  = ("protocol=https`nhost=github.com`n`n" | git credential fill) 2>$null
$token = ($cred | Where-Object { $_ -match '^password=' }) -replace '^password=', ''
if (-not $token) { Write-Error 'no github token in the credential store'; exit 1 }

$api = @{
    'User-Agent'    = 'gh-mt300n'
    'Accept'        = 'application/vnd.github+json'
    'Authorization' = "Bearer $token"
}

Write-Host "release: $Repo $Tag"
$rel  = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $api
$meta = $rel.assets | Where-Object { $_.name -eq $Asset }
if (-not $meta) {
    Write-Host 'available assets:'
    $rel.assets | ForEach-Object { Write-Host "  $($_.name)" }
    Write-Error "asset '$Asset' not found in $Repo $Tag"
    exit 1
}

$tmp = Join-Path $env:TEMP "frpc-v3-$([guid]::NewGuid().ToString('N')).bin"
$dl  = @{ 'User-Agent' = 'gh-mt300n'; 'Accept' = 'application/octet-stream'; 'Authorization' = "Bearer $token" }
Invoke-WebRequest -Uri "https://api.github.com/repos/$Repo/releases/assets/$($meta.id)" -Headers $dl -OutFile $tmp

$sha = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
if ((Get-Item $tmp).Length -ne $meta.size -or ($meta.digest -and $meta.digest -ne "sha256:$sha")) {
    Remove-Item $tmp -Force
    Write-Error "download verification failed (size or digest mismatch)"
    exit 1
}
Write-Host "downloaded $Asset  $($meta.size) bytes  sha256 $sha"

# Keep in step with the checks the payload job runs.
$bytes = [IO.File]::ReadAllBytes($tmp)
function Has-Bytes([byte[]]$hay, [byte[]]$needle) {
    for ($i = 0; $i -le $hay.Length - $needle.Length; $i++) {
        $ok = $true
        for ($j = 0; $j -lt $needle.Length; $j++) {
            if ($hay[$i + $j] -ne $needle[$j]) { $ok = $false; break }
        }
        if ($ok) { return $true }
    }
    return $false
}
$enc = [Text.Encoding]::GetEncoding('latin1')
$wsPatched    = Has-Bytes $bytes ($enc.GetBytes('/api/v1/stream'))
$magicPatched = -not (Has-Bytes $bytes ([byte[]](0x46, 0x52, 0x50, 0x00, 0x02, 0x0d, 0x0a)))
$versioned    = Has-Bytes $bytes ($enc.GetBytes('0.71.0-v3'))
if (-not $versioned) { Remove-Item $tmp -Force; Write-Error 'no 0.71.0-v3 version stamp in the binary'; exit 1 }

Write-Host ("websocket path patched : {0}" -f $wsPatched)
Write-Host ("wire magic patched     : {0}" -f $magicPatched)
if (-not $wsPatched) {
    Remove-Item $tmp -Force
    Write-Host ''
    Write-Host 'REFUSING TO VENDOR THIS ASSET: it speaks the upstream websocket path "/~!frp",'
    Write-Host 'while the frps it has to talk to answers "/api/v1/stream" (the fork''s CI compiles'
    Write-Host 'from a src/ tree that does not have patches/frp-v3.patch applied, which is why'
    Write-Host 'its release assets are upstream frp v0.71.0 with a -v3 version stamp).'
    Write-Host 'A client with the wrong path cannot log in: "connect to server error: bad status".'
    Write-Host ''
    Write-Host 'Fix the fork first: apply patches/frp-v3.patch inside src/, re-release, then'
    Write-Host 'run this script against the new tag. Use -Force to vendor it anyway.'
    if (-not $Force) { exit 1 }
}
if (-not $magicPatched) {
    Write-Host ''
    Write-Host 'NOTE: the wire-protocol magic is still the upstream "FRP\x00\x02\r\n". That is'
    Write-Host 'harmless while transport.wireProtocol stays at v1 (the default); do not enable'
    Write-Host 'v2 on the device until both the client and frps carry the zero magic.'
    Write-Host ''
}

Copy-Item $tmp $dest -Force
Remove-Item $tmp -Force
"$sha  frpc-mipsel-v3" | Set-Content -Encoding ascii -NoNewline $sumFile
Add-Content -Encoding ascii $sumFile "`n"
Write-Host "wrote $dest and $sumFile"
git -C $repoRoot status --short payload/
