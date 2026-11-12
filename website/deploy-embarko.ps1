<#
  Deploy the Sketch website to Embarko (https://embarko.ai) as a static site.

  Run it in PowerShell:
    powershell -ExecutionPolicy Bypass -File "C:\Users\saran\Downloads\sketch\website\deploy-embarko.ps1"

  What it does:
    1. Reads your deploy token from the first line of %USERPROFILE%\.embarko\credentials and
       uses it as DEPLOY_TOKEN, so the site goes straight into your Embarko account (never
       anonymously, so it is permanent from the first deploy).
    2. Packs this folder, leaving out this script, README.md and log files.
    3. Uploads it to https://ship.embarko.ai/apps as the app "sketch-ide". If another account
       owns that name, it tries sketch-ide-site, then sketch-ide-app.
    4. Waits until Embarko says the site is live, then prints its address.
    5. Saves the app's id in embarko.json, so later deploys reach the same app even after a
       rename in the Embarko dashboard. To redeploy, run this script again.

  Options:
    -AppName <name>   Deploy under another name (3-63 lowercase letters, digits or dashes).
    -DryRun           Pack and list the files, upload nothing.
#>
param(
  [string]$AppName = 'sketch-ide',
  [switch]$DryRun,
  # For testing this script: finish from a saved Embarko reply instead of uploading.
  [string]$ReplayReply = ''
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$site = $PSScriptRoot
$api = 'https://ship.embarko.ai'
$credentials = Join-Path $env:USERPROFILE '.embarko\credentials'
$manifest = Join-Path $site 'embarko.json'
$utf8 = New-Object System.Text.UTF8Encoding $false

function Stop-Deploy([string]$message) {
  Write-Host $message -ForegroundColor Red
  exit 1
}

if ($AppName -notmatch '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$') {
  Stop-Deploy "The app name '$AppName' must be 3-63 lowercase letters, digits or dashes, and cannot start or end with a dash."
}

# ── the deploy token ─────────────────────────────────────────────────────────
if (-not (Test-Path $credentials)) { Stop-Deploy "No deploy token found. Put it on the first line of $credentials." }
$lines = [IO.File]::ReadAllLines($credentials)
if ($lines.Count -eq 0) { Stop-Deploy "$credentials is empty. Put your deploy token on its first line." }
$env:DEPLOY_TOKEN = $lines[0].Trim()
if ($env:DEPLOY_TOKEN -notmatch '^emb_[A-Za-z0-9]{20,}$') {
  Stop-Deploy "The first line of $credentials is not an Embarko deploy token (they start with emb_)."
}
$auth = "Authorization: Bearer $($env:DEPLOY_TOKEN)"

# ── an earlier deploy's app id, if there was one ────────────────────────────
$appId = $null
if (Test-Path $manifest) {
  try { $appId = (Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).appId }
  catch { Stop-Deploy "embarko.json is not valid JSON: $($_.Exception.Message)" }
}
$names = @($AppName)
if (-not $appId -and -not $PSBoundParameters.ContainsKey('AppName')) { $names += "$AppName-site", "$AppName-app" }

function Send-Site([string]$name, [string]$archive) {
  $out = [IO.Path]::Combine($env:TEMP, 'embarko-reply-' + [guid]::NewGuid().ToString('N') + '.json')
  $code = & curl.exe -sS --max-time 300 -X POST "$api/apps" -H "X-App-Name: $name" -H 'X-Agent-Name: kiro' -H $auth -F "source=@$archive" -o $out -w '%{http_code}'
  $text = ''
  if (Test-Path $out) {
    $text = [IO.File]::ReadAllText($out, $utf8)
    Remove-Item $out -Force
  }
  $json = $null
  if ($text.Trim() -ne '') { try { $json = $text | ConvertFrom-Json } catch { $json = $null } }
  $status = 0
  [void][int]::TryParse("$code", [ref]$status)
  return [pscustomobject]@{ Code = $status; Text = $text; Json = $json }
}

# ── pack and upload ──────────────────────────────────────────────────────────
if ($ReplayReply -ne '') {
  $text = [IO.File]::ReadAllText($ReplayReply, $utf8)
  $result = [pscustomobject]@{ Code = 200; Text = $text; Json = ($text | ConvertFrom-Json) }
  $usedName = $AppName
} else {
  foreach ($tool in 'tar.exe', 'curl.exe') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Stop-Deploy "$tool was not found. It comes with Windows 10 (version 1803) and later." }
  }
  $archive = [IO.Path]::Combine($env:TEMP, 'sketch-website-' + [guid]::NewGuid().ToString('N') + '.tar.gz')
  & tar.exe -czf $archive --exclude=README.md --exclude=deploy-embarko.ps1 --exclude=*.log -C $site .
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $archive)) { Stop-Deploy 'tar could not pack the folder.' }
  $files = @(& tar.exe -tzf $archive | Where-Object { $_ -notmatch '/$' -and $_ -ne '.' })
  Write-Host ("Packed {0} files ({1:N0} KB) from {2}" -f $files.Count, ((Get-Item $archive).Length / 1KB), $site)

  if ($DryRun) {
    $files | ForEach-Object { Write-Host "  $_" }
    Remove-Item $archive -Force
    Write-Host 'Dry run: nothing was uploaded.'
    exit 0
  }

  $result = $null
  $usedName = $AppName
  foreach ($name in $names) {
    Write-Host "Deploying to Embarko as $name ..."
    $result = Send-Site $name $archive
    $usedName = $name
    $taken = $result.Code -eq 409 -and $null -ne $result.Json -and ($result.Json.code -eq 'app_name_taken' -or $result.Json.code -eq 'app_name_reserved')
    if ($taken -and $name -ne $names[-1]) {
      Write-Host "  The name $name belongs to another account. Trying the next one." -ForegroundColor Yellow
      continue
    }
    break
  }
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
}

# ── what Embarko said ────────────────────────────────────────────────────────
$reply = $result.Json
if ($result.Code -lt 200 -or $result.Code -ge 300 -or $null -eq $reply -or $reply.success -ne $true) {
  Write-Host ''
  if ($result.Code -eq 0 -and $null -eq $reply) { Stop-Deploy 'Could not reach ship.embarko.ai. Check the internet connection and run the script again.' }
  Write-Host "Embarko did not accept the deploy (HTTP $($result.Code))." -ForegroundColor Red
  if ($null -ne $reply) {
    if ($reply.code) { Write-Host "  code:  $($reply.code)" }
    if ($reply.error) { Write-Host "  error: $($reply.error)" }
    if ($reply.next) { Write-Host "  next:  $($reply.next)" }
  } elseif ($result.Text) {
    Write-Host $result.Text
  }
  exit 1
}

$name = "$($reply.app.name)"
if ($name -eq '') { $name = $usedName }
foreach ($notice in @($reply.notices)) {
  if ($null -ne $notice -and $notice.detail) { Write-Host "Note: $($notice.detail)" -ForegroundColor Yellow }
}
if ($ReplayReply -eq '') {
  [IO.File]::WriteAllText((Join-Path $env:USERPROFILE ".embarko\$name-last-deploy.json"), $result.Text, $utf8)
}

# Keep the app id with the site, as Embarko asks, so a later deploy finds this app.
if ($reply.app.id) {
  $data = [ordered]@{}
  if (Test-Path $manifest) {
    $old = Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $old.PSObject.Properties) { $data[$property.Name] = $property.Value }
  }
  $data['appId'] = "$($reply.app.id)"
  [IO.File]::WriteAllText($manifest, (($data | ConvertTo-Json -Depth 10) + "`n"), $utf8)
}

# ── wait until it is live ────────────────────────────────────────────────────
$status = "$($reply.status)"
$latest = $reply
$final = @('live', 'failed', 'crashed', 'not_deployed')
$deadline = (Get-Date).AddMinutes(15)
$shown = ''
while ($final -notcontains $status -and (Get-Date) -lt $deadline) {
  if ($status -ne $shown) { Write-Host "  Status: $status ..."; $shown = $status }
  Start-Sleep -Seconds 2
  try {
    $latest = Invoke-RestMethod -Uri "$api/apps/$name/status" -Headers @{ Authorization = "Bearer $($env:DEPLOY_TOKEN)" } -TimeoutSec 30
    $status = "$($latest.status)"
  } catch {
    Write-Host "  (The status check failed: $($_.Exception.Message). Trying again.)" -ForegroundColor Yellow
  }
}

$link = "https://$name.embarko.app"
if ($null -ne $latest.links -and $latest.links.app) { $link = "$($latest.links.app)" }
Write-Host ''
if ($status -eq 'live') {
  Write-Host "Live: $link" -ForegroundColor Green
  if ($reply.app.claimed -eq $true) {
    Write-Host 'It is in your Embarko account and stays online.'
  } else {
    Write-Host "Embarko did not mark it as yours, so it would be deleted at $($reply.app.expiresAt)." -ForegroundColor Yellow
  }
  exit 0
}
Write-Host "Not live. Final status: $status" -ForegroundColor Red
if ($latest.error) { Write-Host "  error: $($latest.error)" }
if ($latest.next) { Write-Host "  next:  $($latest.next)" }
exit 1
