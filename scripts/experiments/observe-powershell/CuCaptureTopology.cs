using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class CuCaptureNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
  [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSQuerySessionInformation(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytesReturned);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr buffer);
  [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
  private delegate bool MonitorCallback(IntPtr monitor, IntPtr hdc, ref NativeRect rectangle, IntPtr data);
  [DllImport("user32.dll", SetLastError=true)] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorCallback callback, IntPtr data);
  [DllImport("user32.dll", EntryPoint="GetMonitorInfoW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [StructLayout(LayoutKind.Sequential)] private struct NativeRect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct MonitorInfo {
    public uint size; public NativeRect monitor; public NativeRect work; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string device;
  }
  public sealed class Bounds { public int X, Y, Width, Height; }
  public sealed class Screen { public Bounds Bounds; public bool Primary; public string DeviceName; }
  public static Bounds VirtualScreen() {
    return new Bounds { X=GetSystemMetrics(76), Y=GetSystemMetrics(77), Width=GetSystemMetrics(78), Height=GetSystemMetrics(79) };
  }
  public static Screen[] AllScreens() {
    var screens=new List<Screen>();
    Exception failure=null;
    MonitorCallback callback=delegate(IntPtr monitor, IntPtr hdc, ref NativeRect rect, IntPtr data) {
      try {
        var info=new MonitorInfo(); info.size=(uint)Marshal.SizeOf(typeof(MonitorInfo));
        if(!GetMonitorInfo(monitor, ref info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if(screens.Count>=32) throw new InvalidOperationException("display_limit");
        screens.Add(new Screen { Bounds=new Bounds { X=info.monitor.left,Y=info.monitor.top,Width=checked(info.monitor.right-info.monitor.left),Height=checked(info.monitor.bottom-info.monitor.top) }, Primary=(info.flags&1)!=0,DeviceName=info.device });
        return true;
      } catch(Exception error) { failure=error; return false; }
    };
    bool success=EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,callback,IntPtr.Zero);
    GC.KeepAlive(callback);
    if(failure!=null) throw failure;
    if(!success||screens.Count==0) throw new Win32Exception(Marshal.GetLastWin32Error());
    return screens.ToArray();
  }
}
