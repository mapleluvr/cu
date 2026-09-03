$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class CuCaptureNative {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", SetLastError=true)]
  private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")]
  private static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
  [DllImport("wtsapi32.dll", SetLastError=true)]
  private static extern bool WTSQuerySessionInformation(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytesReturned);
  [DllImport("wtsapi32.dll")]
  private static extern void WTSFreeMemory(IntPtr buffer);

  public static bool IsSessionConnected(int sessionId) {
    IntPtr buffer;
    int bytesReturned;
    if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, 8, out buffer, out bytesReturned) || buffer == IntPtr.Zero || bytesReturned < 4) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      return Marshal.ReadInt32(buffer) == 0;
    } finally {
      WTSFreeMemory(buffer);
    }
  }

  public static string InputDesktopName() {
    const uint DESKTOP_READOBJECTS = 0x0001;
    IntPtr desktop = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
    if (desktop == IntPtr.Zero) return null;
    try {
      int needed;
      GetUserObjectInformation(desktop, 2, null, 0, out needed);
      if (needed <= 2 || needed > 1024) return null;
      StringBuilder value = new StringBuilder(needed / 2);
      return GetUserObjectInformation(desktop, 2, value, needed, out needed) ? value.ToString() : null;
    } finally {
      CloseDesktop(desktop);
    }
  }
}
'@

try {
  Add-Type -TypeDefinition $nativeSource -Language CSharp
  $dpiAware = [CuCaptureNative]::SetProcessDpiAwarenessContext([IntPtr](-4))
  if (-not $dpiAware) {
    throw 'dpi_awareness_failed'
  }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  [Console]::Error.WriteLine('capture_failed')
  exit 1
}

$destination = $null
$destinationCreated = $false
$published = $false
$bitmap = $null
$graphics = $null
$file = $null

function Test-ExactKeys {
  param($Value, [string[]]$Keys)
  if ($null -eq $Value) { return $false }
  $actual = if ($Value -is [Collections.IDictionary]) {
    @($Value.Keys)
  } else {
    @($Value.PSObject.Properties.Name)
  }
  if ($actual.Count -ne $Keys.Count) { return $false }
  foreach ($key in $Keys) {
    if ($actual -cnotcontains $key) { return $false }
  }
  return $true
}

function Test-CanonicalIntToken {
  param($Value, [int64]$Minimum, [int64]$Maximum)
  if ($Value -isnot [int] -and $Value -isnot [long]) { return $false }
  $number = [int64]$Value
  return $number -ge $Minimum -and $number -le $Maximum
}

function Test-ScalarString {
  param($Value)
  return $Value -is [string]
}

function Test-DisplayTopology {
  param($VirtualScreen, $Monitors)
  if (-not (Test-ExactKeys -Value $VirtualScreen -Keys @('x','y','width','height')) -or
      -not (Test-CanonicalIntToken -Value $VirtualScreen.x -Minimum -2147483648 -Maximum 2147483647) -or
      -not (Test-CanonicalIntToken -Value $VirtualScreen.y -Minimum -2147483648 -Maximum 2147483647) -or
      -not (Test-CanonicalIntToken -Value $VirtualScreen.width -Minimum 1 -Maximum 2147483647) -or
      -not (Test-CanonicalIntToken -Value $VirtualScreen.height -Minimum 1 -Maximum 2147483647) -or
      ([int64]$VirtualScreen.x + $VirtualScreen.width) -gt 2147483647 -or
      ([int64]$VirtualScreen.y + $VirtualScreen.height) -gt 2147483647) {
    return $false
  }
  $monitorList = @($Monitors)
  if ($monitorList.Count -lt 1 -or $monitorList.Count -gt 32) { return $false }
  $primaryCount = 0
  $placements = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($monitor in $monitorList) {
    if (-not (Test-ExactKeys -Value $monitor -Keys @('x','y','width','height','primary')) -or
        -not (Test-CanonicalIntToken -Value $monitor.x -Minimum -2147483648 -Maximum 2147483647) -or
        -not (Test-CanonicalIntToken -Value $monitor.y -Minimum -2147483648 -Maximum 2147483647) -or
        -not (Test-CanonicalIntToken -Value $monitor.width -Minimum 1 -Maximum 2147483647) -or
        -not (Test-CanonicalIntToken -Value $monitor.height -Minimum 1 -Maximum 2147483647) -or
        $monitor.primary -isnot [bool]) {
      return $false
    }
    $monitorRight = [int64]$monitor.x + $monitor.width
    $monitorBottom = [int64]$monitor.y + $monitor.height
    if ($monitor.x -lt $VirtualScreen.x -or $monitor.y -lt $VirtualScreen.y -or
        $monitorRight -gt ([int64]$VirtualScreen.x + $VirtualScreen.width) -or
        $monitorBottom -gt ([int64]$VirtualScreen.y + $VirtualScreen.height)) {
      return $false
    }
    $placement = [ordered]@{
      x = [int]$monitor.x
      y = [int]$monitor.y
      width = [int]$monitor.width
      height = [int]$monitor.height
    } | ConvertTo-Json -Compress
    if (-not $placements.Add($placement)) { return $false }
    if ($monitor.primary) { $primaryCount += 1 }
  }
  return $primaryCount -eq 1
}

function Test-TopologyForPurpose {
  param($VirtualScreen, $Monitors, [bool]$RequireDistinctDisplays)
  if (-not $RequireDistinctDisplays) { return $true }
  return Test-DisplayTopology -VirtualScreen $VirtualScreen -Monitors $Monitors
}

function Test-RegionSelectorShape {
  param($Selector)
  if ($null -eq $Selector) { return $false }
  if (Test-ExactKeys -Value $Selector -Keys @('kind','left','top','right','bottom')) {
    if (-not (Test-ScalarString -Value $Selector.kind) -or $Selector.kind -cne 'normalized') { return $false }
    foreach ($name in @('left','top','right','bottom')) {
      if (-not (Test-CanonicalIntToken -Value $Selector.$name -Minimum 0 -Maximum 999)) { return $false }
    }
    return $Selector.left -le $Selector.right -and $Selector.top -le $Selector.bottom
  }
  if (Test-ExactKeys -Value $Selector -Keys @('kind','left','top','width','height')) {
    return (
      (Test-ScalarString -Value $Selector.kind) -and
      $Selector.kind -ceq 'pixel' -and
      (Test-CanonicalIntToken -Value $Selector.left -Minimum -2147483648 -Maximum 2147483647) -and
      (Test-CanonicalIntToken -Value $Selector.top -Minimum -2147483648 -Maximum 2147483647) -and
      (Test-CanonicalIntToken -Value $Selector.width -Minimum 1 -Maximum 4096) -and
      (Test-CanonicalIntToken -Value $Selector.height -Minimum 1 -Maximum 4096)
    )
  }
  return $false
}

function Test-SelectorShape {
  param($Selector)
  if (Test-RegionSelectorShape -Selector $Selector) { return $true }
  if (
    (Test-ExactKeys -Value $Selector -Keys @('kind','displayId','region')) -and
    (Test-ScalarString -Value $Selector.kind) -and
    $Selector.kind -ceq 'display_region' -and
    (Test-ScalarString -Value $Selector.displayId) -and
    $Selector.displayId -cmatch '^dsp_[a-f0-9]{32}$' -and
    (Test-RegionSelectorShape -Selector $Selector.region)
  ) {
    return $true
  }
  if (
    (Test-ExactKeys -Value $Selector -Keys @('kind','displayIds')) -and
    (Test-ScalarString -Value $Selector.kind) -and
    $Selector.kind -ceq 'full_screen'
  ) {
    $ids = @($Selector.displayIds)
    if ($ids.Count -lt 1 -or $ids.Count -gt 32) { return $false }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($id in $ids) {
      if (-not (Test-ScalarString -Value $id) -or $id -cnotmatch '^dsp_[a-f0-9]{32}$' -or -not $seen.Add([string]$id)) {
        return $false
      }
    }
    return $true
  }
  return $false
}

function New-RectObject {
  param([int]$X, [int]$Y, [int]$Width, [int]$Height)
  return [ordered]@{ x = $X; y = $Y; width = $Width; height = $Height }
}

function Get-Snapshot {
  param([bool]$RequireDistinctDisplays = $false)
  $sessionId = [int][System.Diagnostics.Process]::GetCurrentProcess().SessionId
  $connected = [CuCaptureNative]::IsSessionConnected($sessionId)
  $desktopName = [CuCaptureNative]::InputDesktopName()
  if (-not [Environment]::UserInteractive -or -not $connected -or $desktopName -cne 'Default') {
    throw 'desktop_unavailable'
  }
  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $monitors = @()
  foreach ($screen in ([System.Windows.Forms.Screen]::AllScreens | Sort-Object @{ Expression = { $_.Bounds.X } }, @{ Expression = { $_.Bounds.Y } }, @{ Expression = { $_.DeviceName } })) {
    $monitors += [ordered]@{
      x = [int]$screen.Bounds.X
      y = [int]$screen.Bounds.Y
      width = [int]$screen.Bounds.Width
      height = [int]$screen.Bounds.Height
      primary = [bool]$screen.Primary
    }
  }
  $virtualScreen = New-RectObject -X $virtual.X -Y $virtual.Y -Width $virtual.Width -Height $virtual.Height
  if (-not (Test-TopologyForPurpose -VirtualScreen $virtualScreen -Monitors $monitors -RequireDistinctDisplays $RequireDistinctDisplays)) {
    throw 'topology_invalid'
  }
  $window = [CuCaptureNative]::GetForegroundWindow()
  [uint32]$processId = 0
  [void][CuCaptureNative]::GetWindowThreadProcessId($window, [ref]$processId)
  return [ordered]@{
    virtualScreen = $virtualScreen
    monitors = $monitors
    desktop = [ordered]@{
      interactive = $true
      connected = [bool]$connected
      kind = 'default'
      sessionId = $sessionId
      desktopName = $desktopName
    }
    foreground = [ordered]@{
      windowHandle = ('0x' + $window.ToInt64().ToString('x16'))
      processId = [int]$processId
    }
  }
}

function Get-Sha256Hex {
  param([string]$Value)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-TopologyFingerprint {
  param($VirtualScreen, $Monitors)
  $value = [ordered]@{
    virtualScreen = $VirtualScreen
    monitors = @($Monitors)
  } | ConvertTo-Json -Compress -Depth 10
  return Get-Sha256Hex -Value $value
}

function Get-DisplayId {
  param([string]$TopologyFingerprint, [int]$Index)
  $value = [ordered]@{
    kind = 'cu.display-id/v1'
    topologyFingerprint = $TopologyFingerprint
    index = $Index
  } | ConvertTo-Json -Compress -Depth 4
  return 'dsp_' + (Get-Sha256Hex -Value $value).Substring(0, 32)
}

function Resolve-Selector {
  param($Selector, $VirtualScreen, $Monitors)
  if (-not (Test-SelectorShape -Selector $Selector)) {
    throw 'selector_invalid'
  }
  if ($Selector.kind -ceq 'display_region') {
    if (-not (Test-TopologyForPurpose -VirtualScreen $VirtualScreen -Monitors $Monitors -RequireDistinctDisplays $true)) {
      throw 'display_topology_invalid'
    }
    $rect = Resolve-Selector -Selector $Selector.region -VirtualScreen $VirtualScreen -Monitors $Monitors
    $topologyFingerprint = Get-TopologyFingerprint -VirtualScreen $VirtualScreen -Monitors $Monitors
    $selectedMonitor = $null
    $monitorList = @($Monitors)
    for ($index = 0; $index -lt $monitorList.Count; $index += 1) {
      if ((Get-DisplayId -TopologyFingerprint $topologyFingerprint -Index $index) -ceq $Selector.displayId) {
        $selectedMonitor = $monitorList[$index]
        break
      }
    }
    if ($null -eq $selectedMonitor -or
        $rect.x -lt $selectedMonitor.x -or $rect.y -lt $selectedMonitor.y -or
        ([int64]$rect.x + $rect.width) -gt ([int64]$selectedMonitor.x + $selectedMonitor.width) -or
        ([int64]$rect.y + $rect.height) -gt ([int64]$selectedMonitor.y + $selectedMonitor.height)) {
      throw 'display_binding_invalid'
    }
    return $rect
  }
  if ($Selector.kind -ceq 'full_screen') {
    if (-not (Test-TopologyForPurpose -VirtualScreen $VirtualScreen -Monitors $Monitors -RequireDistinctDisplays $true)) {
      throw 'display_topology_invalid'
    }
    $topologyFingerprint = Get-TopologyFingerprint -VirtualScreen $VirtualScreen -Monitors $Monitors
    $monitorList = @($Monitors)
    $selected = New-Object System.Collections.ArrayList
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($displayId in @($Selector.displayIds)) {
      if (-not $seen.Add([string]$displayId)) { throw 'display_binding_invalid' }
      $selectedIndex = -1
      for ($index = 0; $index -lt $monitorList.Count; $index += 1) {
        if ((Get-DisplayId -TopologyFingerprint $topologyFingerprint -Index $index) -ceq $displayId) {
          $selectedIndex = $index
          break
        }
      }
      if ($selectedIndex -lt 0) { throw 'display_binding_invalid' }
      [void]$selected.Add($monitorList[$selectedIndex])
    }
    if ($selected.Count -lt 1) { throw 'display_binding_invalid' }
    $left = [int64]$selected[0].x
    $top = [int64]$selected[0].y
    $right = $left + [int64]$selected[0].width
    $bottom = $top + [int64]$selected[0].height
    foreach ($monitor in $selected) {
      $left = [Math]::Min($left, [int64]$monitor.x)
      $top = [Math]::Min($top, [int64]$monitor.y)
      $right = [Math]::Max($right, [int64]$monitor.x + $monitor.width)
      $bottom = [Math]::Max($bottom, [int64]$monitor.y + $monitor.height)
    }
    $width = $right - $left
    $height = $bottom - $top
    if ($width -lt 1 -or $height -lt 1 -or $width -gt 32768 -or $height -gt 32768) {
      throw 'full_screen_size_invalid'
    }
    return New-RectObject -X ([int]$left) -Y ([int]$top) -Width ([int]$width) -Height ([int]$height)
  }
  if ($Selector.kind -ceq 'normalized') {
    if (-not (Test-ExactKeys -Value $Selector -Keys @('kind','left','top','right','bottom'))) { throw 'selector_invalid' }
    foreach ($name in @('left','top','right','bottom')) {
      if (-not (Test-CanonicalIntToken -Value $Selector.$name -Minimum 0 -Maximum 999)) { throw 'selector_invalid' }
    }
    if ($Selector.left -gt $Selector.right -or $Selector.top -gt $Selector.bottom) { throw 'selector_invalid' }
    $localLeft = [Math]::Floor(([double]$Selector.left * ($VirtualScreen.width - 1)) / 999.0)
    $localTop = [Math]::Floor(([double]$Selector.top * ($VirtualScreen.height - 1)) / 999.0)
    $rightExclusive = [Math]::Min($VirtualScreen.width, [Math]::Ceiling(([double]$Selector.right * ($VirtualScreen.width - 1)) / 999.0) + 1)
    $bottomExclusive = [Math]::Min($VirtualScreen.height, [Math]::Ceiling(([double]$Selector.bottom * ($VirtualScreen.height - 1)) / 999.0) + 1)
    $rect = New-RectObject -X ([int]($VirtualScreen.x + $localLeft)) -Y ([int]($VirtualScreen.y + $localTop)) -Width ([int]($rightExclusive - $localLeft)) -Height ([int]($bottomExclusive - $localTop))
  } elseif ($Selector.kind -ceq 'pixel') {
    if (-not (Test-ExactKeys -Value $Selector -Keys @('kind','left','top','width','height'))) { throw 'selector_invalid' }
    if (-not (Test-CanonicalIntToken -Value $Selector.left -Minimum -2147483648 -Maximum 2147483647) -or
        -not (Test-CanonicalIntToken -Value $Selector.top -Minimum -2147483648 -Maximum 2147483647) -or
        -not (Test-CanonicalIntToken -Value $Selector.width -Minimum 1 -Maximum 4096) -or
        -not (Test-CanonicalIntToken -Value $Selector.height -Minimum 1 -Maximum 4096)) {
      throw 'selector_invalid'
    }
    $rect = New-RectObject -X ([int]$Selector.left) -Y ([int]$Selector.top) -Width ([int]$Selector.width) -Height ([int]$Selector.height)
  } else {
    throw 'selector_invalid'
  }
  if ($rect.width -gt 4096 -or $rect.height -gt 4096 -or
      $rect.x -lt $VirtualScreen.x -or $rect.y -lt $VirtualScreen.y -or
      ([int64]$rect.x + $rect.width) -gt ([int64]$VirtualScreen.x + $VirtualScreen.width) -or
      ([int64]$rect.y + $rect.height) -gt ([int64]$VirtualScreen.y + $VirtualScreen.height)) {
    throw 'region_outside_virtual_screen'
  }
  if ($rect.x -le $VirtualScreen.x -and $rect.y -le $VirtualScreen.y -and
      ([int64]$rect.x + $rect.width) -ge ([int64]$VirtualScreen.x + $VirtualScreen.width) -and
      ([int64]$rect.y + $rect.height) -ge ([int64]$VirtualScreen.y + $VirtualScreen.height)) {
    throw 'region_contains_virtual_screen'
  }
  return $rect
}

try {
  $requestText = [Console]::In.ReadToEnd()
  if ([Text.Encoding]::UTF8.GetByteCount($requestText) -gt 65536) { throw 'request_too_large' }
  $request = $requestText | ConvertFrom-Json
  if (-not (Test-ScalarString -Value $request.kind) -or
      -not (Test-ScalarString -Value $request.requestId) -or
      $request.requestId -cnotmatch '^req_[a-f0-9]{32}$') {
    throw 'request_invalid'
  }
  $isDisplayRequest = (
    (Test-ExactKeys -Value $request -Keys @('kind','requestId')) -and
    $request.kind -ceq 'cu.windows-display.request/v1'
  )
  $isCaptureRequest = (
    (Test-ExactKeys -Value $request -Keys @('kind','requestId','destinationPath','selector')) -and
    $request.kind -ceq 'cu.windows-capture.request/v1' -and
    $request.destinationPath -is [string] -and
    (Test-SelectorShape -Selector $request.selector)
  )
  if (-not $isDisplayRequest -and -not $isCaptureRequest) {
    throw 'request_invalid'
  }
  $canonicalRequestText = $request | ConvertTo-Json -Compress -Depth 4
  if ($requestText -cne ($canonicalRequestText + "`n")) {
    throw 'request_invalid'
  }

  if ($isDisplayRequest) {
    $displayPre = Get-Snapshot -RequireDistinctDisplays $true
    $displayPost = Get-Snapshot -RequireDistinctDisplays $true
    $displayPreIdentity = [ordered]@{
      virtualScreen = $displayPre.virtualScreen
      monitors = $displayPre.monitors
      desktop = $displayPre.desktop
    } | ConvertTo-Json -Compress -Depth 10
    $displayPostIdentity = [ordered]@{
      virtualScreen = $displayPost.virtualScreen
      monitors = $displayPost.monitors
      desktop = $displayPost.desktop
    } | ConvertTo-Json -Compress -Depth 10
    if ($displayPreIdentity -cne $displayPostIdentity) { throw 'environment_changed' }

    $displayResult = [ordered]@{
      kind = 'cu.windows-display.result/v1'
      requestId = [string]$request.requestId
      virtualScreen = $displayPre.virtualScreen
      monitors = $displayPre.monitors
    }
    [Console]::Out.WriteLine(($displayResult | ConvertTo-Json -Compress -Depth 12))
    [Console]::Out.Flush()
    $published = $true
  } else {
    $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $candidateDestination = [IO.Path]::GetFullPath([string]$request.destinationPath)
    if ([IO.Path]::GetDirectoryName($candidateDestination) -ine $tempRoot -or [IO.Path]::GetExtension($candidateDestination) -cne '.png' -or [IO.File]::Exists($candidateDestination)) {
      throw 'destination_invalid'
    }
    $destination = $candidateDestination

    $requireDistinctDisplays = $request.selector.kind -ceq 'display_region' -or $request.selector.kind -ceq 'full_screen'
    $pre = Get-Snapshot -RequireDistinctDisplays $requireDistinctDisplays
    $sourceRect = Resolve-Selector -Selector $request.selector -VirtualScreen $pre.virtualScreen -Monitors $pre.monitors
    $bitmap = New-Object System.Drawing.Bitmap($sourceRect.width, $sourceRect.height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($sourceRect.x, $sourceRect.y, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    $file = New-Object System.IO.FileStream($destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $destinationCreated = $true
    $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $file.Flush($true)
    $file.Dispose()
    $file = $null
    $graphics.Dispose()
    $graphics = $null
    $bitmap.Dispose()
    $bitmap = $null

    $post = Get-Snapshot -RequireDistinctDisplays $requireDistinctDisplays
    $preIdentity = $pre | ConvertTo-Json -Compress -Depth 10
    $postIdentity = $post | ConvertTo-Json -Compress -Depth 10
    if ($preIdentity -cne $postIdentity) { throw 'environment_changed' }

    $bytes = [IO.File]::ReadAllBytes($destination)
    if ($bytes.Length -lt 1 -or $bytes.Length -gt 67108864) { throw 'capture_size_invalid' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
    $result = [ordered]@{
      kind = 'cu.windows-capture.result/v1'
      requestId = [string]$request.requestId
      destinationPath = $destination
      sourceRectPx = $sourceRect
      virtualScreen = $pre.virtualScreen
      monitors = $pre.monitors
      desktop = $pre.desktop
      foreground = $pre.foreground
      image = [ordered]@{
        sha256 = $digest
        byteLength = [int]$bytes.Length
        width = [int]$sourceRect.width
        height = [int]$sourceRect.height
      }
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 12))
    [Console]::Out.Flush()
    $published = $true
  }
} catch {
  [Console]::Error.WriteLine('capture_failed')
  exit 3
} finally {
  if ($null -ne $file) { try { $file.Dispose() } catch {} }
  if ($null -ne $graphics) { try { $graphics.Dispose() } catch {} }
  if ($null -ne $bitmap) { try { $bitmap.Dispose() } catch {} }
  if (-not $published -and $destinationCreated -and $null -ne $destination) {
    try { if ([IO.File]::Exists($destination)) { [IO.File]::Delete($destination) } } catch {}
  }
}
