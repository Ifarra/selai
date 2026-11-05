# Copies the Windows installers produced by `pnpm tauri build` into a staging
# directory and writes SHA256SUMS (sha256sum format, LF line endings).
#
# Usage: pwsh scripts/release/collect-bundles.ps1 -BundleDir target/release/bundle -StageDir stage
param(
  [Parameter(Mandatory)][string]$BundleDir,
  [Parameter(Mandatory)][string]$StageDir
)
$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

$installers = @(Get-ChildItem -Path (Join-Path $BundleDir 'msi\*.msi'), (Join-Path $BundleDir 'nsis\*.exe') -File)
if ($installers.Count -eq 0) { throw "no installers found under $BundleDir" }
# Updater signatures (sign-updater.sh) are published next to their installers.
$signatures = @(Get-ChildItem -Path (Join-Path $BundleDir 'msi\*.msi.sig'), (Join-Path $BundleDir 'nsis\*.exe.sig') -File -ErrorAction SilentlyContinue)
foreach ($f in $installers + $signatures) {
  Copy-Item -LiteralPath $f.FullName -Destination $StageDir -Force
}

$lines = foreach ($f in (Get-ChildItem -Path $StageDir -File | Where-Object { $_.Name -ne 'SHA256SUMS' } | Sort-Object Name)) {
  '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath $f.FullName).Hash.ToLowerInvariant(), $f.Name
}
[IO.File]::WriteAllText((Join-Path (Resolve-Path $StageDir) 'SHA256SUMS'), (($lines -join "`n") + "`n"))

Get-Content -Path (Join-Path $StageDir 'SHA256SUMS')
