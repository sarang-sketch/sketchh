# Publish the two README screenshots.
#
# The root README shows the agent surface first and the IDE surface second. This script
# copies your two captures into place under the exact names the README expects, checks
# they are real images, runs the egress guard, then commits and pushes.
#
# Usage, from the repository root:
#
#   ./docs/assets/add-screenshots.ps1 -Agent "C:\path\to\cowork.png" -Ide "C:\path\to\ide.png"
#
# Add -NoPush to stage and commit without pushing.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Agent,
  [Parameter(Mandatory = $true)][string] $Ide,
  [switch] $NoPush
)

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$assets = Join-Path $repo 'docs\assets'

$targets = @(
  @{ Source = $Agent; Name = 'sketch-agent-cowork.png'; Label = 'Cowork (agent surface)' }
  @{ Source = $Ide;   Name = 'sketch-ide-code.png';     Label = 'Code (IDE surface)' }
)

# PNG and JPEG magic bytes. A renamed HTML error page or a zero-byte placeholder passes a
# size check and then renders as a broken image on GitHub, so check the signature instead.
function Test-ImageSignature {
  param([string] $Path)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 8) { return $null }
  $png = @(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
  $isPng = $true
  for ($i = 0; $i -lt 8; $i++) { if ($bytes[$i] -ne $png[$i]) { $isPng = $false; break } }
  if ($isPng) { return 'PNG' }
  if ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8 -and $bytes[2] -eq 0xFF) { return 'JPEG' }
  return $null
}

foreach ($t in $targets) {
  if (-not (Test-Path -LiteralPath $t.Source)) {
    throw "$($t.Label): file not found -> $($t.Source)"
  }

  $kind = Test-ImageSignature -Path $t.Source
  if ($null -eq $kind) {
    throw "$($t.Label): '$($t.Source)' is not a PNG or JPEG. Re-export the capture."
  }
  if ($kind -ne 'PNG') {
    Write-Warning "$($t.Label): source is $kind. Saving as .png, but re-exporting as real PNG is cleaner."
  }

  $dest = Join-Path $assets $t.Name
  Copy-Item -LiteralPath $t.Source -Destination $dest -Force
  $kb = [math]::Round((Get-Item -LiteralPath $dest).Length / 1KB, 1)
  Write-Host "ok  $($t.Label) -> docs/assets/$($t.Name) ($kb KB, $kind)" -ForegroundColor Green
}

Push-Location $repo
try {
  # index.html is the only file the egress guard pins by name, and these assets are not
  # referenced from it, so this should stay green. Run it anyway: a privacy guard is worth
  # more than the four seconds it costs.
  Write-Host "`nrunning the egress guard..." -ForegroundColor Cyan
  npm test -w @sketch/desktop -- src/privacy.egress.test.ts
  if ($LASTEXITCODE -ne 0) { throw 'the egress guard failed. Nothing was committed.' }

  git add docs/assets/sketch-agent-cowork.png docs/assets/sketch-ide-code.png README.md
  git commit -m "docs: add the Cowork and IDE screenshots to the README"

  if ($NoPush) {
    Write-Host "`ncommitted. Push when ready:  git push origin main" -ForegroundColor Yellow
  } else {
    git push origin main
    Write-Host "`npushed. Check the rendered README on GitHub." -ForegroundColor Green
  }
} finally {
  Pop-Location
}
