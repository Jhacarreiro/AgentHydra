# Starts `node <script> <args>` inside a KILL_ON_JOB_CLOSE job (what a runner under the CLI / MCP server sits in),
# waits for <killFile> to exist, then closes the job handle, which kills everything still inside it.
param([string]$Node, [string]$Script, [string]$OutFile, [string]$DirArg, [string]$KillFile)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class Job {
  [StructLayout(LayoutKind.Sequential)] public struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] public struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXT { public BASIC Basic; public IO Io; public UIntPtr p,j,pm,jm; }
  [DllImport("kernel32.dll")] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, int len);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public static IntPtr Make() { var j = CreateJobObject(IntPtr.Zero, null); var i = new EXT(); i.Basic.LimitFlags = 0x2000; SetInformationJobObject(j, 9, ref i, Marshal.SizeOf(i)); return j; }
}
"@
$job = [Job]::Make()
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Node
$psi.Arguments = "`"$Script`" `"$OutFile`" `"$DirArg`""
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)
[void][Job]::AssignProcessToJobObject($job, $p.Handle)
while (-not (Test-Path $KillFile)) { Start-Sleep -Milliseconds 100 }
[void][Job]::CloseHandle($job)
