$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class CuInputNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct MONITORINFOEX {
    public int cbSize;
    public int left;
    public int top;
    public int right;
    public int bottom;
    public int workLeft;
    public int workTop;
    public int workRight;
    public int workBottom;
    public int flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string deviceName;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public INPUTUNION u;
  }

  public sealed class InputRecord {
    public int Type;
    public int Dx;
    public int Dy;
    public uint Flags;
    public int Data;
    public uint VirtualKey;
    public uint ScanCode;
    public uint DelayAfterMs;
  }

  public sealed class MonitorRecord {
    public int x;
    public int y;
    public int width;
    public int height;
    public bool primary;
    public string deviceName;
  }

  public delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

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
  [DllImport("user32.dll")]
  private static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError=true)]
  private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("user32.dll", SetLastError=true)]
  private static extern uint SendInput(uint count, [In] INPUT[] inputs, int size);

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

  public static MonitorRecord[] Monitors() {
    List<MonitorRecord> monitors = new List<MonitorRecord>();
    MonitorEnumProc callback = delegate(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data) {
      MONITORINFOEX info = new MONITORINFOEX();
      info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      if (!GetMonitorInfo(monitor, ref info)) return false;
      MonitorRecord record = new MonitorRecord();
      record.x = info.left;
      record.y = info.top;
      record.width = checked(info.right - info.left);
      record.height = checked(info.bottom - info.top);
      record.primary = (info.flags & 1) != 0;
      record.deviceName = info.deviceName;
      monitors.Add(record);
      return true;
    };
    if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero) || monitors.Count == 0) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    return monitors.ToArray();
  }

  public static int Metric(int index) {
    return GetSystemMetrics(index);
  }

  public static int Send(InputRecord[] records) {
    INPUT[] inputs = new INPUT[records.Length];
    for (int index = 0; index < records.Length; index++) {
      InputRecord record = records[index];
      INPUT input = new INPUT();
      input.type = (uint)record.Type;
      if (record.Type == 0) {
        input.u.mi = new MOUSEINPUT {
          dx = record.Dx,
          dy = record.Dy,
          mouseData = unchecked((uint)record.Data),
          dwFlags = record.Flags,
          time = 0,
          dwExtraInfo = IntPtr.Zero
        };
      } else {
        input.u.ki = new KEYBDINPUT {
          wVk = checked((ushort)record.VirtualKey),
          wScan = checked((ushort)record.ScanCode),
          dwFlags = record.Flags,
          time = 0,
          dwExtraInfo = IntPtr.Zero
        };
      }
      inputs[index] = input;
    }
    return checked((int)SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))));
  }
}
'@

function Test-ExactKeys {
  param($Value, [string[]]$Keys)
  if ($null -eq $Value) { return $false }
  $actual = @($Value.PSObject.Properties.Name)
  if ($actual.Count -ne $Keys.Count) { return $false }
  foreach ($key in $Keys) {
    if ($actual -cnotcontains $key) { return $false }
  }
  return $true
}

function Test-CanonicalInt {
  param($Value, [int64]$Minimum, [int64]$Maximum)
  if ($Value -isnot [int] -and $Value -isnot [long]) { return $false }
  $number = [int64]$Value
  return $number -ge $Minimum -and $number -le $Maximum
}

function New-RectObject {
  param([int]$X, [int]$Y, [int]$Width, [int]$Height)
  return [ordered]@{ x = $X; y = $Y; width = $Width; height = $Height }
}

function Get-Snapshot {
  $sessionId = [int][System.Diagnostics.Process]::GetCurrentProcess().SessionId
  $connected = [CuInputNative]::IsSessionConnected($sessionId)
  $desktopName = [CuInputNative]::InputDesktopName()
  if (-not [Environment]::UserInteractive -or -not $connected -or $desktopName -cne 'Default') {
    throw 'desktop_unavailable'
  }
  $monitors = @(
    [CuInputNative]::Monitors() |
      Sort-Object @{ Expression = { $_.x } }, @{ Expression = { $_.y } }, @{ Expression = { $_.deviceName } } |
      ForEach-Object {
        [ordered]@{
          x = [int]$_.x
          y = [int]$_.y
          width = [int]$_.width
          height = [int]$_.height
          primary = [bool]$_.primary
        }
      }
  )
  if ($monitors.Count -lt 1 -or $monitors.Count -gt 32 -or (@($monitors | Where-Object { $_.primary }).Count -ne 1)) {
    throw 'monitor_invalid'
  }
  $virtual = New-RectObject -X ([CuInputNative]::Metric(76)) -Y ([CuInputNative]::Metric(77)) -Width ([CuInputNative]::Metric(78)) -Height ([CuInputNative]::Metric(79))
  if ($virtual.width -lt 1 -or $virtual.height -lt 1) { throw 'virtual_invalid' }
  $window = [CuInputNative]::GetForegroundWindow()
  [uint32]$processId = 0
  [void][CuInputNative]::GetWindowThreadProcessId($window, [ref]$processId)
  return [ordered]@{
    virtualScreen = $virtual
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

function Test-PortableVirtualKey {
  param([uint32]$Value)
  if (($Value -ge 0x41 -and $Value -le 0x5a) -or
      ($Value -ge 0x30 -and $Value -le 0x39) -or
      ($Value -ge 0x60 -and $Value -le 0x69) -or
      ($Value -ge 0x70 -and $Value -le 0x87)) { return $true }
  return $Value -in @(0x08,0x09,0x0d,0x10,0x11,0x12,0x13,0x14,0x1b,0x20,0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2c,0x2d,0x2e,0x5b,0x5d,0x6a,0x6b,0x6d,0x6e,0x6f,0x90,0x91,0xba,0xbb,0xbc,0xbd,0xbe,0xbf,0xc0,0xdb,0xdc,0xdd,0xde)
}

function New-InputRecord {
  param([int]$Type, [int]$Dx, [int]$Dy, [uint32]$Flags, [int]$Data, [uint32]$VirtualKey, [uint32]$ScanCode, [uint32]$DelayAfterMs)
  $record = New-Object CuInputNative+InputRecord
  $record.Type = $Type
  $record.Dx = $Dx
  $record.Dy = $Dy
  $record.Flags = $Flags
  $record.Data = $Data
  $record.VirtualKey = $VirtualKey
  $record.ScanCode = $ScanCode
  $record.DelayAfterMs = $DelayAfterMs
  return $record
}

function Read-Records {
  param([string]$Encoded)
  if ($Encoded -isnot [string] -or $Encoded.Length -lt 4) { throw 'request_invalid' }
  try {
    $bytes = [Convert]::FromBase64String($Encoded)
  } catch {
    throw 'request_invalid'
  }
  if ($bytes.Length -lt 32 -or ($bytes.Length % 32) -ne 0 -or ($bytes.Length / 32) -gt 262144) {
    throw 'request_invalid'
  }
  $records = New-Object 'System.Collections.Generic.List[CuInputNative+InputRecord]'
  [uint64]$totalDelayMs = 0
  for ($offset = 0; $offset -lt $bytes.Length; $offset += 32) {
    $type = [BitConverter]::ToInt32($bytes, $offset)
    $dx = [BitConverter]::ToInt32($bytes, $offset + 4)
    $dy = [BitConverter]::ToInt32($bytes, $offset + 8)
    $flags = [BitConverter]::ToUInt32($bytes, $offset + 12)
    $data = [BitConverter]::ToInt32($bytes, $offset + 16)
    $virtualKey = [BitConverter]::ToUInt32($bytes, $offset + 20)
    $scanCode = [BitConverter]::ToUInt32($bytes, $offset + 24)
    $delayAfterMs = [BitConverter]::ToUInt32($bytes, $offset + 28)
    if ($delayAfterMs -gt 5000) { throw 'request_invalid' }
    $totalDelayMs += [uint64]$delayAfterMs
    if ($totalDelayMs -gt 35000) { throw 'request_invalid' }
    if ($type -eq 0) {
      $mouseMove = $flags -eq 0xc001 -and $dx -ge 0 -and $dx -le 65535 -and $dy -ge 0 -and $dy -le 65535 -and $data -eq 0 -and $virtualKey -eq 0 -and $scanCode -eq 0
      $mouseButton = $flags -in @(0x0002,0x0004,0x0008,0x0010,0x0020,0x0040) -and $dx -eq 0 -and $dy -eq 0 -and $data -eq 0 -and $virtualKey -eq 0 -and $scanCode -eq 0
      $mouseWheel = $flags -eq 0x0800 -and $dx -eq 0 -and $dy -eq 0 -and $data -ne 0 -and ($data % 120) -eq 0 -and ([Math]::Abs([int64]$data / 120)) -le 100 -and $virtualKey -eq 0 -and $scanCode -eq 0
      if (-not ($mouseMove -or $mouseButton -or $mouseWheel)) { throw 'request_invalid' }
    } elseif ($type -eq 1) {
      $unicode = $virtualKey -eq 0 -and $scanCode -ge 1 -and $scanCode -le 65535 -and $flags -in @(0x0004,0x0006) -and $dx -eq 0 -and $dy -eq 0 -and $data -eq 0
      $virtual = (Test-PortableVirtualKey $virtualKey) -and $scanCode -eq 0 -and $flags -in @(0x0000,0x0001,0x0002,0x0003) -and $dx -eq 0 -and $dy -eq 0 -and $data -eq 0
      if (-not ($unicode -or $virtual)) { throw 'request_invalid' }
    } else {
      throw 'request_invalid'
    }
    [void]$records.Add((New-InputRecord -Type $type -Dx $dx -Dy $dy -Flags $flags -Data $data -VirtualKey $virtualKey -ScanCode $scanCode -DelayAfterMs $delayAfterMs))
  }
  return $records
}

function Get-HeldEntry {
  param($Record)
  if ($Record.Type -eq 0) {
    $down = @{ 0x0002 = 'left'; 0x0008 = 'right'; 0x0020 = 'middle' }
    $up = @{ 0x0004 = 'left'; 0x0010 = 'right'; 0x0040 = 'middle' }
    if ($down.ContainsKey($Record.Flags)) { return [ordered]@{ kind = 'button'; value = $down[$Record.Flags]; flags = $Record.Flags } }
    if ($up.ContainsKey($Record.Flags)) { return [ordered]@{ kind = 'button_up'; value = $up[$Record.Flags]; flags = $Record.Flags } }
    return $null
  }
  if (($Record.Flags -band 0x0004) -ne 0) {
    $kind = if (($Record.Flags -band 0x0002) -ne 0) { 'unicode_up' } else { 'unicode' }
    return [ordered]@{ kind = $kind; value = [int]$Record.ScanCode; flags = $Record.Flags }
  }
  if (($Record.Flags -band 0x0002) -ne 0) { return [ordered]@{ kind = 'key_up'; value = [int]$Record.VirtualKey; flags = $Record.Flags } }
  return [ordered]@{ kind = 'key'; value = [int]$Record.VirtualKey; flags = $Record.Flags }
}

function Apply-HeldRecord {
  param($Held, $Record)
  $entry = Get-HeldEntry $Record
  if ($null -eq $entry) { return }
  if ($entry.kind -eq 'key' -or $entry.kind -eq 'button' -or $entry.kind -eq 'unicode') {
    [void]$Held.Add($entry)
    return
  }
  if ($Held.Count -lt 1) { throw 'held_invalid' }
  $last = $Held[$Held.Count - 1]
  $expectedKind = if ($entry.kind -eq 'key_up') { 'key' } elseif ($entry.kind -eq 'unicode_up') { 'unicode' } else { 'button' }
  if ($last.kind -ne $expectedKind -or $last.value -ne $entry.value) { throw 'held_invalid' }
  $Held.RemoveAt($Held.Count - 1)
}

function New-CleanupRecord {
  param($Entry)
  if ($Entry.kind -eq 'key') {
    return New-InputRecord -Type 1 -Dx 0 -Dy 0 -Flags ([uint32]($Entry.flags -bor 0x0002)) -Data 0 -VirtualKey ([uint32]$Entry.value) -ScanCode 0 -DelayAfterMs 0
  }
  if ($Entry.kind -eq 'unicode') {
    return New-InputRecord -Type 1 -Dx 0 -Dy 0 -Flags 0x0006 -Data 0 -VirtualKey 0 -ScanCode ([uint32]$Entry.value) -DelayAfterMs 0
  }
  $upFlags = @{ 0x0002 = 0x0004; 0x0008 = 0x0010; 0x0020 = 0x0040 }
  return New-InputRecord -Type 0 -Dx 0 -Dy 0 -Flags ([uint32]$upFlags[$Entry.flags]) -Data 0 -VirtualKey 0 -ScanCode 0 -DelayAfterMs 0
}

function Send-Records {
  param($Records, $Held)
  [int]$accepted = 0
  [int]$index = 0
  while ($index -lt $Records.Count) {
    $batch = New-Object 'System.Collections.Generic.List[CuInputNative+InputRecord]'
    do {
      [void]$batch.Add($Records[$index])
      $delay = [int]$Records[$index].DelayAfterMs
      $index++
    } while ($index -lt $Records.Count -and $delay -eq 0)
    $sent = [CuInputNative]::Send($batch.ToArray())
    if ($sent -lt 0 -or $sent -gt $batch.Count) { throw 'send_invalid' }
    for ($batchIndex = 0; $batchIndex -lt $sent; $batchIndex++) {
      Apply-HeldRecord -Held $Held -Record $batch[$batchIndex]
      $accepted++
    }
    if ($sent -ne $batch.Count) { break }
    if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
  }
  return $accepted
}

try {
  Add-Type -TypeDefinition $nativeSource -Language CSharp
  $dpiAware = [CuInputNative]::SetProcessDpiAwarenessContext([IntPtr](-4))
  if (-not $dpiAware) { throw 'dpi_awareness_failed' }
  $snapshot = Get-Snapshot
  $snapshotCanonical = $snapshot | ConvertTo-Json -Compress -Depth 10
  $ready = [ordered]@{
    kind = 'cu.windows-input.ready/v1'
    virtualScreen = $snapshot.virtualScreen
    monitors = $snapshot.monitors
    desktop = $snapshot.desktop
    foreground = $snapshot.foreground
  }
  [Console]::Out.WriteLine(($ready | ConvertTo-Json -Compress -Depth 10))
  [Console]::Out.Flush()

  $requestText = [Console]::In.ReadToEnd()
  if ([Text.Encoding]::UTF8.GetByteCount($requestText) -gt 12582912) { throw 'request_too_large' }
  $firstNewline = $requestText.IndexOf("`n")
  $secondNewline = if ($firstNewline -ge 0) { $requestText.IndexOf("`n", $firstNewline + 1) } else { -1 }
  if ($firstNewline -lt 1 -or $secondNewline -ne ($requestText.Length - 1)) { throw 'request_invalid' }
  $requestLine = $requestText.Substring(0, $firstNewline)
  $executeLine = $requestText.Substring($firstNewline + 1, $secondNewline - $firstNewline - 1)
  $request = $requestLine | ConvertFrom-Json
  $execute = $executeLine | ConvertFrom-Json
  if (-not (Test-ExactKeys -Value $request -Keys @('kind','recordsBase64','declaredDelayMs','generatedDragDurationMs')) -or
      $request.kind -isnot [string] -or $request.kind -cne 'cu.windows-input.request/v1' -or
      $request.recordsBase64 -isnot [string] -or
      ($request.declaredDelayMs -isnot [int] -and $request.declaredDelayMs -isnot [long]) -or
      $request.declaredDelayMs -lt 0 -or $request.declaredDelayMs -gt 30000 -or
      ($request.generatedDragDurationMs -isnot [int] -and $request.generatedDragDurationMs -isnot [long]) -or
      $request.generatedDragDurationMs -lt 0 -or $request.generatedDragDurationMs -gt 5000) {
    throw 'request_invalid'
  }
  if (-not (Test-ExactKeys -Value $execute -Keys @('kind','executionId')) -or
      $execute.kind -isnot [string] -or $execute.kind -cne 'cu.windows-input.execute/v1' -or
      $execute.executionId -isnot [string] -or $execute.executionId -cnotmatch '^inp_[a-f0-9]{32}$') {
    throw 'request_invalid'
  }
  if ($requestLine -cne ($request | ConvertTo-Json -Compress -Depth 4) -or
      $executeLine -cne ($execute | ConvertTo-Json -Compress -Depth 4)) {
    throw 'request_invalid'
  }
  $records = @(Read-Records -Encoded $request.recordsBase64)
  [uint64]$recordDelayMs = 0
  foreach ($record in $records) { $recordDelayMs += [uint64]$record.DelayAfterMs }
  if ($recordDelayMs -ne ([uint64]$request.declaredDelayMs + [uint64]$request.generatedDragDurationMs)) {
    throw 'request_invalid'
  }
  $preEffectSnapshot = Get-Snapshot
  if (($preEffectSnapshot | ConvertTo-Json -Compress -Depth 10) -cne $snapshotCanonical) {
    throw 'environment_changed'
  }
  $held = New-Object 'System.Collections.Generic.List[object]'
  $accepted = Send-Records -Records $records -Held $held
  $cleanup = 'not_needed'
  if ($held.Count -gt 0) {
    $cleanup = 'released'
    $cleanupRecords = New-Object 'System.Collections.Generic.List[CuInputNative+InputRecord]'
    for ($index = $held.Count - 1; $index -ge 0; $index--) {
      [void]$cleanupRecords.Add((New-CleanupRecord -Entry $held[$index]))
    }
    $cleanupAccepted = Send-Records -Records $cleanupRecords -Held $held
    if ($cleanupAccepted -ne $cleanupRecords.Count -or $held.Count -ne 0) { $cleanup = 'unproven' }
  }
  $heldAfter = @($held | ForEach-Object { [string]$_.kind })
  $result = [ordered]@{
    kind = 'cu.windows-input.result/v1'
    executionId = $execute.executionId
    requestedNativeRecords = [int]$records.Count
    acceptedNativeRecords = [int]$accepted
    cleanup = $cleanup
    heldAfter = $heldAfter
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
} catch {
  [Console]::Error.WriteLine('input_failed')
  exit 3
}
