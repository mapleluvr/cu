param(
  [Parameter(Mandatory = $true)][string]$ControlPath,
  [Parameter(Mandatory = $true)][string]$EventPath,
  [Parameter(Mandatory = $true)][string]$FocusPath,
  [Parameter(Mandatory = $true)][string]$FocusAckPath,
  [Parameter(Mandatory = $true)][string]$Token
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$native = @'
using System;
using System.Runtime.InteropServices;
public static class CuFixtureNative {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
'@
Add-Type -TypeDefinition $native -Language CSharp
$dpiAware = [CuFixtureNative]::SetProcessDpiAwarenessContext([IntPtr](-4))
if (-not $dpiAware) {
  throw 'dpi_awareness_failed'
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-PatternColors {
  param([string]$Value)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value))
  } finally {
    $sha.Dispose()
  }
  $target = @()
  $decoy = @()
  for ($index = 0; $index -lt 4; $index++) {
    $offset = $index * 3
    $red = 32 + ([int]$digest[$offset] % 192)
    $green = 32 + ([int]$digest[$offset + 1] % 192)
    $blue = 32 + ([int]$digest[$offset + 2] % 192)
    $target += [System.Drawing.Color]::FromArgb($red, $green, $blue)
    $decoy += [System.Drawing.Color]::FromArgb(255 - $red, 255 - $green, 255 - $blue)
  }
  return [pscustomobject]@{ target = $target; decoy = $decoy }
}

function Write-ClickEvent {
  param([string]$Role, $EventArgs)
  $entry = [ordered]@{
    kind = 'click'
    role = $Role
    button = $EventArgs.Button.ToString().ToLowerInvariant()
    x = [int]$EventArgs.X
    y = [int]$EventArgs.Y
    count = [int]$EventArgs.Clicks
  }
  [System.IO.File]::AppendAllText(
    $EventPath,
    (($entry | ConvertTo-Json -Compress -Depth 3) + "`n"),
    [System.Text.UTF8Encoding]::new($false)
  )
}

function New-PatternForm {
  param(
    [string]$Title,
    [string]$Role,
    [int]$Left,
    [int]$Top,
    [System.Drawing.Color[]]$Colors
  )
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $Title
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Location = New-Object System.Drawing.Point($Left, $Top)
  $form.ClientSize = New-Object System.Drawing.Size(400, 300)
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.TopMost = $true
  $form.Name = $Role
  $form.Tag = $Colors
  $form.Add_MouseClick({
    param($sender, $eventArgs)
    Write-ClickEvent -Role ([string]$sender.Name) -EventArgs $eventArgs
  })
  $form.Add_Paint({
    param($sender, $eventArgs)
    $graphics = $eventArgs.Graphics
    $colors = [System.Drawing.Color[]]$sender.Tag
    for ($index = 0; $index -lt 4; $index++) {
      $brush = New-Object System.Drawing.SolidBrush($colors[$index])
      try {
        $x = if (($index % 2) -eq 0) { 0 } else { 200 }
        $y = if ($index -lt 2) { 0 } else { 150 }
        $graphics.FillRectangle($brush, $x, $y, 200, 150)
      } finally {
        $brush.Dispose()
      }
    }
  })
  return $form
}

$working = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$targetLeft = $working.Left + 40
$targetTop = $working.Top + 40
$decoyLeft = [Math]::Min($working.Right - 430, $targetLeft + 460)
$decoyTop = $targetTop
$patternColors = Get-PatternColors -Value $Token
$target = New-PatternForm -Title ("cu-target-" + $Token) -Role 'target' -Left $targetLeft -Top $targetTop -Colors $patternColors.target
$decoy = New-PatternForm -Title ("cu-decoy-" + $Token) -Role 'decoy' -Left $decoyLeft -Top $decoyTop -Colors $patternColors.decoy
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 50
$timer.Add_Tick({
  if ([System.IO.File]::Exists($ControlPath)) {
    $timer.Stop()
    $decoy.Close()
    $target.Close()
  } elseif ([System.IO.File]::Exists($FocusPath)) {
    $role = [System.IO.File]::ReadAllText($FocusPath)
    $form = if ($role -ceq 'target') { $target } elseif ($role -ceq 'decoy') { $decoy } else { $null }
    if ($null -eq $form) { throw 'focus_invalid' }
    [void]$form.Activate()
    [System.Windows.Forms.Application]::DoEvents()
    if ([CuFixtureNative]::GetForegroundWindow() -eq $form.Handle) {
      [System.IO.File]::WriteAllText($FocusAckPath, $role, [System.Text.UTF8Encoding]::new($false))
      [System.IO.File]::Delete($FocusPath)
    }
  }
})

try {
  $decoy.Show()
  $target.Show()
  $target.Activate()
  [System.Windows.Forms.Application]::DoEvents()
  $targetRect = $target.RectangleToScreen($target.ClientRectangle)
  $decoyRect = $decoy.RectangleToScreen($decoy.ClientRectangle)
  $ready = [ordered]@{
    kind = 'cu.controlled-window.ready/v1'
    token = $Token
    target = [ordered]@{ x = $targetRect.X; y = $targetRect.Y; width = $targetRect.Width; height = $targetRect.Height }
    decoy = [ordered]@{ x = $decoyRect.X; y = $decoyRect.Y; width = $decoyRect.Width; height = $decoyRect.Height }
  }
  [Console]::Out.WriteLine(($ready | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
  $timer.Start()
  [System.Windows.Forms.Application]::Run($target)
} finally {
  $timer.Dispose()
  $decoy.Dispose()
  $target.Dispose()
}
