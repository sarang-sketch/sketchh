# W11 real-app probe: launch the QA exe isolated and dump the Windows UI Automation
# tree so we can see whether the WebView2 content controls are reachable from UIA on
# this host. If the page's buttons/edits do NOT appear, relaunch with
# WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-renderer-accessibility (W2 saw that var
# reach the webview's browser process).
#
# Drives NOTHING: it only reads the tree (names + control types + patterns) to a depth
# cap, so it is safe to run while the owner uses the machine. Launches with a fresh
# USERPROFILE/HOME + a fresh WEBVIEW2_USER_DATA_FOLDER + SKETCH_FAKE_PROVIDER=1, stops
# the app by the PID it launched.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Seconds = 16,
  [int]$MaxDepth = 7,
  [switch]$ForceA11y
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$home0 = Join-Path $env:TEMP ('sketch-qa-uia-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $home0 | Out-Null
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Exe
$psi.UseShellExecute = $false
$psi.EnvironmentVariables['USERPROFILE'] = $home0
$psi.EnvironmentVariables['HOME'] = $home0
$psi.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = (Join-Path $home0 'webview')
$psi.EnvironmentVariables['SKETCH_FAKE_PROVIDER'] = '1'
if ($ForceA11y) {
  $psi.EnvironmentVariables['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = '--force-renderer-accessibility'
}
$proc = [System.Diagnostics.Process]::Start($psi)
Write-Host "w11-uia-probe: started pid $($proc.Id) (ForceA11y=$ForceA11y)"
$script:counts = @{}
try {
  Start-Sleep -Seconds $Seconds
  $auto = [System.Windows.Automation.AutomationElement]
  # find the window owned by our PID
  $root = $auto::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if ($win -eq $null) { throw "no top-level window for pid $($proc.Id)" }
  Write-Host ("window: name='{0}' class='{1}'" -f $win.Current.Name, $win.Current.ClassName)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  function Walk($el, $depth) {
    if ($depth -gt $MaxDepth) { return }
    $child = $walker.GetFirstChild($el)
    while ($child -ne $null) {
      $ct = $child.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''
      $nm = $child.Current.Name
      $script:counts[$ct] = 1 + ($script:counts[$ct] | ForEach-Object { $_ }) 
      if ($nm -and $nm.Trim().Length -gt 0 -and $ct -match 'Button|Edit|Text|ListItem|TabItem|MenuItem|CheckBox|RadioButton|Hyperlink|ComboBox') {
        $pad = ' ' * ($depth * 2)
        $short = $nm; if ($short.Length -gt 60) { $short = $short.Substring(0,60) + '...' }
        Write-Host ("{0}[{1}] {2}" -f $pad, $ct, $short)
      }
      Walk $child ($depth + 1)
      $child = $walker.GetNextSibling($child)
    }
  }
  Walk $win 0
  Write-Host "--- control-type counts ---"
  $script:counts.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host ("  {0}: {1}" -f $_.Key, $_.Value) }
} catch {
  Write-Host "w11-uia-probe: ERROR $($_.Exception.Message)"
} finally {
  if (-not $proc.HasExited) { taskkill /T /F /PID $proc.Id 2>&1 | Out-Null }
  Remove-Item $home0 -Recurse -Force -ErrorAction SilentlyContinue
}
