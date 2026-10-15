# window-hider.ps1 - takes a headed SUE wave's Chrome windows out of the taskbar and Alt+Tab.
#
# A headed wave's windows are parked at -32000,-32000 (lib/findings.mjs browserArgsFor), which keeps
# them off the screen but NOT out of the shell: each one is an ordinary unowned app window with a
# taskbar button titled with the site's page. On 2026-09-23 they were closed from there, and a closed
# window is a closed page under a Sue ("Target page, context or browser has been closed"). This makes
# every top-level Chrome window in the run's process tree a tool window and deletes its taskbar
# button, so the shell has nothing to offer anyone to close. The page itself is untouched: the window
# stays visible (off-screen), so the site still sees a visible page.
#
# Started by lib/window-hider.mjs while a headed Sue is out, with the pid of the process running her
# (the cannon, or reap.mjs for a janitor). Every second it looks again, which catches the window each
# new Sue, pop-up and reopened browser brings. It prints one line per window it hid
# ("hid 0x<hwnd> pid <pid>") and ends by itself when that process is gone.
param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [int]$EveryMs = 1000
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISueTaskbarList {
  void HrInit();
  void AddTab(IntPtr hwnd);
  void DeleteTab(IntPtr hwnd);
  void ActivateTab(IntPtr hwnd);
  void SetActiveAlt(IntPtr hwnd);
}

public static class SueWindowHider {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32 {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  const int GWL_EXSTYLE = -20;
  const long WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000;
  const uint GW_OWNER = 4, TH32CS_SNAPPROCESS = 2, SYNCHRONIZE = 0x100000, QUERY_LIMITED = 0x1000;
  static ISueTaskbarList taskbar;
  /// Each window-owning pid the last pass judged, with the creation time it was judged at. A process
  /// never changes parents, so a window that is not the run's (the person's own Chrome, an Electron
  /// app, another run's browser) is judged once, not with a process snapshot every second: that
  /// snapshot burned 8,177 CPU-seconds under a run that hung for four days (board #7303). A pid
  /// handed to a new process has a new creation time and is judged again.
  static Dictionary<uint, KeyValuePair<long, bool>> judged = new Dictionary<uint, KeyValuePair<long, bool>>();

  static long CreatedAt(uint pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return -1;
    long created, exited, kernel, user;
    bool ok = GetProcessTimes(h, out created, out exited, out kernel, out user);
    CloseHandle(h);
    return ok ? created : -1;
  }

  /// Whether `pid` belongs to the run: its parent chain reaches `root`, and at every hop the child
  /// was created after its parent, so a dead parent's number handed to a stranger never pulls it in.
  static bool Inside(uint pid, uint root, Dictionary<uint, uint> parentOf, Dictionary<uint, long> created) {
    Func<uint, long> at = p => { long v; if (!created.TryGetValue(p, out v)) { v = CreatedAt(p); created[p] = v; } return v; };
    uint child = pid;
    for (int hop = 0; hop < 32; hop++) {
      if (child == root) return true;
      uint parent;
      if (!parentOf.TryGetValue(child, out parent) || parent == 0 || parent == child) return false;
      long c = at(child), p = at(parent);
      if (c < 0 || p < 0 || c < p) return false;
      child = parent;
    }
    return false;
  }

  static Dictionary<uint, uint> Parents() {
    var parentOf = new Dictionary<uint, uint>();
    IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return parentOf;
    try {
      var e = new PROCESSENTRY32();
      e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      for (bool more = Process32FirstW(snap, ref e); more; more = Process32NextW(snap, ref e)) parentOf[e.th32ProcessID] = e.th32ParentProcessID;
    } finally { CloseHandle(snap); }
    return parentOf;
  }

  /// One look: hides every top-level Chrome window of the run not hidden yet; returns a line each.
  /// A pass with nothing new to hide costs one EnumWindows and one creation-time read per process
  /// owning a window it skips; the process snapshot is taken only for a process not judged before.
  public static List<string> Pass(uint root) {
    var said = new List<string>();
    var fresh = new List<KeyValuePair<IntPtr, uint>>();
    EnumWindows((hwnd, lParam) => {
      if (GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return true;
      long ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
      if ((ex & WS_EX_TOOLWINDOW) != 0 && (ex & WS_EX_APPWINDOW) == 0) return true;
      var cls = new StringBuilder(64);
      GetClassName(hwnd, cls, cls.Capacity);
      if (cls.ToString() != "Chrome_WidgetWin_1") return true;
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid != root) fresh.Add(new KeyValuePair<IntPtr, uint>(hwnd, pid));
      return true;
    }, IntPtr.Zero);
    Dictionary<uint, uint> parentOf = null;
    var created = new Dictionary<uint, long>();
    var verdict = new Dictionary<uint, KeyValuePair<long, bool>>();
    foreach (var w in fresh) {
      KeyValuePair<long, bool> v;
      if (!verdict.TryGetValue(w.Value, out v)) {
        long at = CreatedAt(w.Value);
        created[w.Value] = at;
        // A process whose creation time cannot be read is never inside (Inside asks the same), so it needs no snapshot.
        if (at < 0) v = new KeyValuePair<long, bool>(at, false);
        else if (!judged.TryGetValue(w.Value, out v) || v.Key != at) {
          if (parentOf == null) parentOf = Parents();
          v = new KeyValuePair<long, bool>(at, Inside(w.Value, root, parentOf, created));
        }
        verdict[w.Value] = v;
      }
      if (!v.Value) continue;
      if (taskbar == null) {
        try { taskbar = (ISueTaskbarList)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("56FDF344-FD6D-11d0-958A-006097C9A090"))); taskbar.HrInit(); }
        catch { taskbar = null; }
      }
      long ex = GetWindowLongPtr(w.Key, GWL_EXSTYLE).ToInt64();
      SetWindowLongPtr(w.Key, GWL_EXSTYLE, new IntPtr((ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW));
      if (taskbar != null && IsWindowVisible(w.Key)) { try { taskbar.DeleteTab(w.Key); } catch { } }
      said.Add(String.Format("hid 0x{0:x} pid {1}", w.Key.ToInt64(), w.Value));
    }
    // Only the pids seen this pass carry over, so the table holds today's windows, never every pid since the start.
    judged = verdict;
    return said;
  }

  /// Waits `ms` for the root process to end; true when it has (or cannot be watched at all).
  public static bool RootGone(IntPtr rootHandle, uint ms) {
    return rootHandle == IntPtr.Zero || WaitForSingleObject(rootHandle, ms) == 0;
  }

  public static IntPtr Watch(uint pid) { return OpenProcess(SYNCHRONIZE, false, pid); }
}
'@

$root = [uint32]$RootPid
$handle = [SueWindowHider]::Watch($root)
do {
  foreach ($line in [SueWindowHider]::Pass($root)) { [Console]::Out.WriteLine($line) }
  [Console]::Out.Flush()
} while (-not [SueWindowHider]::RootGone($handle, [uint32]$EveryMs))
