# Capture ONLY the QA app's own window via PrintWindow, for hosts whose WebView2
# refuses a remote-debugging port (this machine's runtime 156 does). PrintWindow
# renders the target window's own bitmap directly from the window — it does NOT read
# the screen region, so a window from any other app (e.g. the owner's running Sketch)
# that overlaps it is never captured. Launches the exe isolated, waits, grabs the
# window, writes a PNG, and stops the app.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Seconds = 14
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinShot {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$h0 = Join-Path $env:TEMP ('sketch-qa-win-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $h0 | Out-Null
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Exe
$psi.UseShellExecute = $false
$psi.EnvironmentVariables['USERPROFILE'] = $h0
$psi.EnvironmentVariables['HOME'] = $h0
$psi.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = (Join-Path $h0 'webview')
$psi.EnvironmentVariables['SKETCH_FAKE_PROVIDER'] = '1'
$proc = [System.Diagnostics.Process]::Start($psi)
Write-Host "qa-window-shot: started pid $($proc.Id)"
try {
  Start-Sleep -Seconds $Seconds
  $proc.Refresh()
  $hwnd = $proc.MainWindowHandle
  if ($hwnd -eq [IntPtr]::Zero) { throw "no main window handle" }
  $r = New-Object WinShot+RECT
  [WinShot]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
  if ($w -le 0 -or $hgt -le 0) { throw "window has no size" }
  $bmp = New-Object System.Drawing.Bitmap $w, $hgt
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  # flag 2 = PW_RENDERFULLCONTENT: needed to capture DirectComposition/WebView2 surfaces.
  $ok = [WinShot]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc)
  New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host "qa-window-shot: wrote $Out ($w x $hgt), PrintWindow ok=$ok"
} finally {
  if (-not $proc.HasExited) { taskkill /T /F /PID $proc.Id 2>&1 | Out-Null }
  Remove-Item $h0 -Recurse -Force -ErrorAction SilentlyContinue
}
