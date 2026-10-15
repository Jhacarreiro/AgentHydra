# tray.ps1 - Sue's icon in the Windows toolbar (the notification area), run by lib/tray.mjs.
#
# Owner ask (Owner, 2026-09-23): "Whenever an AI starts it, it shouldn't open it up. It should be
# able to stay collapsed to the toolbar ... if I close Sue, it should say shrunk to the toolbar."
# So Sue keeps an icon here for as long as her Manager runs: clicking it brings her window back
# (or opens one), and the Manager asks it to say so when her window closes.
#
# Owner ask (Owner, 2026-09-23, later): the right-click menu "looks like crap ... like a hundred year
# old right click menu"; it should look like the Claude app's (dark, rounded), feel like a Google
# application with the AI rainbow, and show the waves that are running the way a session list does.
# So the menu is drawn by SueMenu below: a dark Google surface that Windows 11 rounds itself, the
# Gemini gradient along its top (it slides while a wave runs), and one row per running wave.
#
# One line of JSON per message in each direction, over this process's own pipes:
#   in  (stdin):  {"say":{"title":"...","text":"..."}}  a note beside the icon
#                 {"tip":"..."}                          the icon's hover text
#                 {"runs":[{"runId":"...","host":"...","done":3,"total":5}],"more":18}
#                                                        the waves running now, newest first,
#                                                        replacing the last list (an empty list: Sue
#                                                        is idle); `more` counts the ones running
#                                                        beyond it, shown as one "18 more" row
#                 end of input                           the Manager is gone: remove the icon, exit
#   out (stdout): ready | open | open <runId> | show <runId> | quit
#                 (a running wave's row: open <runId> when no window of hers is on screen, else
#                 show <runId> once it is raised, so the window turns to that run)
# It never touches the network and never reads a file other than the icon it is handed.
param(
  [Parameter(Mandatory = $true)][string]$Icon,
  [Parameter(Mandatory = $true)][string]$WindowTitle
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Sue's window is the person's own Chrome (or Edge) as an app window titled with the page's title.
# Both browsers draw every top-level window with this class, which keeps a normal tab whose window
# is titled "Sue - Google Chrome" from matching.
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SueWindow {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  const int SW_RESTORE = 9;
  /// Brings the window titled exactly `title` to the front, restoring it when minimized. False when there is none.
  public static bool Raise(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, lParam) => {
      if (!IsWindowVisible(hwnd)) return true;
      var cls = new StringBuilder(64);
      GetClassName(hwnd, cls, cls.Capacity);
      if (cls.ToString() != "Chrome_WidgetWin_1") return true;
      var text = new StringBuilder(256);
      GetWindowText(hwnd, text, text.Capacity);
      if (text.ToString() != title) return true;
      found = hwnd;
      return false;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    if (IsIconic(found)) ShowWindow(found, SW_RESTORE);
    SetForegroundWindow(found);
    return true;
  }
}
"@

# The menu, drawn and laid out by itself so it can be built and looked at without an icon (a preview
# script lifts this source out of the file and compiles it alone). C# 5: what Windows PowerShell 5.1
# compiles with.
$sueMenuSource = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

/// One wave that is running now, as the Manager reports it.
public sealed class SueRun {
  public readonly string RunId;
  public readonly string Host;
  public readonly int Done;
  public readonly int Total;
  public SueRun(string runId, string host, int done, int total) {
    RunId = OneLine(runId);
    Host = OneLine(host);
    Done = Math.Max(0, done);
    Total = Math.Max(0, total);
  }
  static string OneLine(string text) {
    return (text ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
  }
}

public enum SueRowKind { Header, Run, More, Action }

/// A row of Sue's menu: SueMenu sizes it, SueRenderer draws it.
public sealed class SueRow : ToolStripMenuItem {
  readonly SueMenu menu;
  public readonly SueRowKind Kind;
  public string Detail;
  public string RunId;
  public SueRow(SueMenu menu, SueRowKind kind, string text, string detail) : base(text) {
    this.menu = menu;
    Kind = kind;
    Detail = detail;
  }
  public override Size GetPreferredSize(Size constrainingSize) {
    return new Size(menu.RowWidth, menu.RowHeight);
  }
}

public sealed class SueSeparator : ToolStripSeparator {
  readonly SueMenu menu;
  public SueSeparator(SueMenu menu) { this.menu = menu; }
  public override Size GetPreferredSize(Size constrainingSize) {
    return new Size(menu.RowWidth, menu.SeparatorHeight);
  }
}

/// The menu's window. A stock drop-down keeps padding of its own on the right (whatever Padding is set
/// to), which would leave the rows and their rounded hover off centre; this one is as wide as its rows.
public sealed class SueStrip : ContextMenuStrip {
  readonly SueMenu menu;
  public SueStrip(SueMenu menu) { this.menu = menu; }
  public override Size GetPreferredSize(Size proposedSize) {
    Size size = base.GetPreferredSize(proposedSize);
    return menu == null ? size : new Size(menu.RowWidth, size.Height);
  }
  // Every resize, the drop-down's own included, keeps the rows' width (the base constructor sizes it
  // before `menu` is set).
  protected override void SetBoundsCore(int x, int y, int width, int height, BoundsSpecified specified) {
    if (menu != null && menu.RowWidth > 0) width = menu.RowWidth;
    base.SetBoundsCore(x, y, width, height, specified);
  }
}

/// Sue's menu: a dark Google surface, the Gemini gradient along its top, one row per running wave.
public sealed class SueMenu : IDisposable {
  public static readonly Color Surface = Color.FromArgb(0x20, 0x21, 0x24);
  public static readonly Color Ink = Color.FromArgb(0xE8, 0xEA, 0xED);
  public static readonly Color Muted = Color.FromArgb(0x9A, 0xA0, 0xA6);
  public static readonly Color Edge = Color.FromArgb(0x3C, 0x40, 0x43);
  public static readonly Color Hover = Color.FromArgb(0x35, 0x36, 0x3A);
  /// The Gemini gradient: blue, violet, rose.
  static readonly Color[] Spectrum = {
    Color.FromArgb(0x47, 0x96, 0xE3), Color.FromArgb(0x91, 0x77, 0xC7), Color.FromArgb(0xCA, 0x66, 0x73)
  };
  const TextFormatFlags OneLine = TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding;

  public readonly ContextMenuStrip Strip;
  /// "open", "open <runId>" or "quit", as the person chooses a row.
  public event Action<string> Command;
  /// Whether Windows rounds the menu's corners and draws its edge (Windows 11).
  public bool Rounded { get; private set; }
  internal int RowWidth;
  internal int RowHeight;
  internal int SeparatorHeight;

  readonly float scale;
  readonly Font body;
  readonly Font strong;
  readonly Font title;
  readonly System.Windows.Forms.Timer shimmer = new System.Windows.Forms.Timer();
  List<SueRun> runs = new List<SueRun>();
  /// Waves running beyond the rows shown: one "N more running" row stands for them all, so twenty
  /// waves at once still make a menu of the usual size.
  int more;
  int ticks;
  const int MaxRunRows = 5;
  /// The whole menu at 80% of its first size (Owner, 2026-09-23: "make it 20% smaller, slightly less wide").
  const float Compact = 0.8f;
  const int MinWidth = 236;

  public SueMenu() {
    using (Graphics screen = Graphics.FromHwnd(IntPtr.Zero)) scale = screen.DpiX / 96f;
    body = PickFont(9.75f * Compact, FontStyle.Regular, "Segoe UI Variable Text", "Segoe UI");
    strong = PickFont(9.75f * Compact, FontStyle.Bold, "Segoe UI Variable Text", "Segoe UI");
    title = PickFont(10.5f * Compact, FontStyle.Regular, "Segoe UI Variable Text Semibold", "Segoe UI Semibold");
    RowHeight = S(32);
    SeparatorHeight = S(9);
    RowWidth = S(MinWidth);

    Strip = new SueStrip(this);
    Strip.ShowImageMargin = false;
    Strip.ShowCheckMargin = false;
    Strip.ShowItemToolTips = false;
    Strip.Font = body;
    Strip.BackColor = Surface;
    Strip.ForeColor = Ink;
    Strip.AccessibleName = "Sue";
    Strip.Renderer = new SueRenderer(this);
    Strip.Padding = Padding.Empty;
    Strip.HandleCreated += delegate { Rounded = Round(Strip.Handle); };
    Strip.Opening += delegate { if (Strip.IsHandleCreated) Rounded = Round(Strip.Handle); };
    Strip.Opened += delegate { UpdateShimmer(); };
    Strip.Closed += delegate { UpdateShimmer(); };
    // About 30 frames a second, and only while the menu is open with a wave running.
    shimmer.Interval = 33;
    shimmer.Tick += delegate { Step(); };
    Build();
  }

  public string FontName { get { return body.Name; } }
  public float Scale { get { return scale; } }
  public bool Shimmering { get { return shimmer.Enabled; } }

  public void SetRuns(IList<SueRun> next) { SetRuns(next, 0); }

  /// The waves running now, newest first, replacing the last list, and how many more run beyond it.
  /// At most MaxRunRows get a row each; the rest are one "N more running" row. Safe while the menu is open.
  public void SetRuns(IList<SueRun> next, int moreBeyond) {
    var list = new List<SueRun>();
    if (next != null) foreach (SueRun run in next) if (run != null) list.Add(run);
    int nextMore = Math.Max(0, moreBeyond) + Math.Max(0, list.Count - MaxRunRows);
    if (list.Count > MaxRunRows) list.RemoveRange(MaxRunRows, list.Count - MaxRunRows);
    bool sameRows = list.Count == runs.Count && (nextMore > 0) == (more > 0);
    for (int i = 0; sameRows && i < list.Count; i++) sameRows = list[i].RunId == runs[i].RunId;
    Rectangle before = Strip.Visible ? Strip.Bounds : Rectangle.Empty;
    runs = list;
    more = nextMore;
    // The same waves with new counts keep their rows, so a row under the pointer stays lit.
    if (sameRows) Retext(); else Build();
    if (Strip.Visible) Reanchor(before);
    UpdateShimmer();
  }

  void Build() {
    var old = new List<ToolStripItem>();
    foreach (ToolStripItem item in Strip.Items) old.Add(item);
    Strip.SuspendLayout();
    Strip.Items.Clear();
    foreach (ToolStripItem item in old) item.Dispose();

    var header = new SueRow(this, SueRowKind.Header, "Sue", Status());
    header.Font = title;
    // Room above for the gradient and its glow.
    header.Margin = new Padding(0, AccentHeight, 0, 0);
    // The header opens her too (Owner, 2026-09-23: "top button should be open as well").
    header.Click += delegate { Fire("open"); };
    Strip.Items.Add(header);
    foreach (SueRun run in runs) {
      var row = new SueRow(this, SueRowKind.Run, HostOf(run), Progress(run));
      row.RunId = run.RunId;
      string word = run.RunId.Length > 0 ? "open " + run.RunId : "open";
      row.Click += delegate { Fire(word); };
      Strip.Items.Add(row);
    }
    if (more > 0) {
      var rest = new SueRow(this, SueRowKind.More, MoreText(), null);
      rest.Click += delegate { Fire("open"); };
      Strip.Items.Add(rest);
    }
    Strip.Items.Add(new SueSeparator(this));
    var open = new SueRow(this, SueRowKind.Action, "Open Sue", null);
    open.Font = strong;
    open.Click += delegate { Fire("open"); };
    Strip.Items.Add(open);
    Strip.Items.Add(new SueSeparator(this));
    var quit = new SueRow(this, SueRowKind.Action, "Quit Sue", null);
    quit.Click += delegate { Fire("quit"); };
    quit.Margin = new Padding(0, 0, 0, S(4));
    Strip.Items.Add(quit);

    Measure();
    Strip.ResumeLayout(true);
  }

  void Retext() {
    int next = 0;
    foreach (ToolStripItem item in Strip.Items) {
      var row = item as SueRow;
      if (row == null) continue;
      if (row.Kind == SueRowKind.Header) row.Detail = Status();
      if (row.Kind == SueRowKind.More) row.Text = MoreText();
      if (row.Kind != SueRowKind.Run) continue;
      SueRun run = runs[next++];
      row.Text = HostOf(run);
      row.Detail = Progress(run);
    }
    Measure();
    Strip.PerformLayout();
    Strip.Invalidate();
  }

  /// Every row is as wide as the widest one needs, within reason.
  void Measure() {
    int width = S(MinWidth);
    foreach (ToolStripItem item in Strip.Items) {
      var row = item as SueRow;
      if (row == null) continue;
      int need = S(16) + TextRenderer.MeasureText(row.Text, row.Font, Size.Empty, OneLine).Width + S(16);
      if (row.Kind == SueRowKind.Run || row.Kind == SueRowKind.More) need += S(18);
      if (!string.IsNullOrEmpty(row.Detail)) need += S(24) + TextRenderer.MeasureText(row.Detail, body, Size.Empty, OneLine).Width;
      width = Math.Max(width, need);
    }
    RowWidth = Math.Min(width, S(420));
  }

  /// A menu that grew or shrank while open keeps the edge it opened from (a tray menu opens upward).
  void Reanchor(Rectangle before) {
    Size size = Strip.GetPreferredSize(Size.Empty);
    Rectangle area = Screen.FromRectangle(before).WorkingArea;
    int top = before.Top > area.Top + area.Height / 2 ? before.Bottom - size.Height : before.Top;
    int left = Math.Min(before.Left, area.Right - size.Width);
    top = Math.Max(area.Top, Math.Min(top, area.Bottom - size.Height));
    Strip.Bounds = new Rectangle(Math.Max(area.Left, left), top, size.Width, size.Height);
  }

  void UpdateShimmer() {
    bool want = Strip.Visible && runs.Count > 0;
    if (want == shimmer.Enabled) return;
    if (want) shimmer.Start(); else shimmer.Stop();
  }

  void Step() {
    if (!Strip.Visible) { shimmer.Stop(); return; }
    ticks++;
    Strip.Invalidate(new Rectangle(0, 0, Strip.Width, AccentHeight));
    foreach (ToolStripItem item in Strip.Items) {
      var row = item as SueRow;
      if (row != null && row.Kind == SueRowKind.Run) row.Invalidate(Rectangle.Inflate(DotBounds(row.Height), S(8), S(8)));
    }
  }

  void Fire(string word) {
    Action<string> handler = Command;
    if (handler == null) return;
    try { handler(word); } catch (Exception ex) { Console.Error.WriteLine("menu: " + ex.Message); }
  }

  string Status() {
    int total = runs.Count + more;
    if (total == 0) return "Idle";
    return total == 1 ? "1 wave running" : total + " waves running";
  }

  string MoreText() {
    return more + " more running";
  }

  static string Progress(SueRun run) {
    if (run.Total <= 0) return "starting";
    return run.Done + " of " + run.Total + (run.Total == 1 ? " Sue" : " Sues");
  }

  static string HostOf(SueRun run) {
    return run.Host.Length > 0 ? run.Host : "a site";
  }

  // ---- drawing, called by SueRenderer ----

  /// The gradient's line and the glow under it, above the header. Windows 11 draws its 1 px edge over
  /// the line's top pixel.
  int AccentHeight { get { return S(10); } }

  internal void PaintAccent(Graphics g, int width) {
    bool live = runs.Count > 0;
    int line = S(4);
    int glow = live ? S(6) : 0;
    int tile = Math.Max(width, 1);
    float shift = live ? (ticks * S(4)) % tile : 0;
    for (int y = 0; y < line + glow; y++) {
      // Running: a soft glow under the line, and the colours slide. Idle: the gradient rests.
      int alpha = y < line ? 255 : (int)(150 * Math.Pow(1 - (y - line + 1) / (double)(glow + 1), 2));
      using (var brush = new LinearGradientBrush(new Rectangle(0, 0, tile, 1), Spectrum[0], Spectrum[2], 0f)) {
        brush.InterpolationColors = Blend(alpha, live);
        brush.WrapMode = WrapMode.Tile;
        brush.TranslateTransform(shift, 0);
        g.FillRectangle(brush, 0, y, width, 1);
      }
    }
  }

  internal void PaintHover(Graphics g, Size size) {
    var area = new Rectangle(S(4), S(1), size.Width - S(8), size.Height - S(2));
    SmoothingMode was = g.SmoothingMode;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    using (GraphicsPath path = RoundRect(area, S(6)))
    using (var fill = new SolidBrush(Hover)) g.FillPath(fill, path);
    g.SmoothingMode = was;
  }

  /// A separator is placed a little in from the menu's edge; its line is inset from the menu's edges.
  internal void PaintSeparator(Graphics g, ToolStripItem item) {
    int y = item.Height / 2;
    int x = item.Bounds.X;
    using (var pen = new Pen(Edge)) g.DrawLine(pen, S(12) - x, y, Strip.Width - S(13) - x, y);
  }

  internal void PaintRow(Graphics g, SueRow row) {
    int h = row.Height;
    int left = S(16);
    int right = row.Width - S(16);
    if (row.Kind == SueRowKind.Run) PaintDot(g, DotBounds(h));
    if (row.Kind == SueRowKind.Run || row.Kind == SueRowKind.More) left += S(18);
    if (!string.IsNullOrEmpty(row.Detail)) {
      int width = TextRenderer.MeasureText(g, row.Detail, body, Size.Empty, OneLine).Width;
      TextRenderer.DrawText(g, row.Detail, body, new Rectangle(right - width, 0, width, h), Muted, OneLine | TextFormatFlags.Right);
      right -= width + S(24);
    }
    var text = new Rectangle(left, 0, Math.Max(0, right - left), h);
    Color ink = row.Kind == SueRowKind.More ? Muted : Ink;
    TextRenderer.DrawText(g, row.Text, row.Font, text, ink, OneLine | TextFormatFlags.EndEllipsis);
  }

  Rectangle DotBounds(int rowHeight) {
    int d = S(8);
    return new Rectangle(S(16), (rowHeight - d) / 2, d, d);
  }

  /// A running wave's dot: the gradient turning, with a ring that grows out of it and fades.
  void PaintDot(Graphics g, Rectangle dot) {
    SmoothingMode was = g.SmoothingMode;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    float t = (ticks % 36) / 36f;
    float grow = S(6) * t;
    using (var ring = new SolidBrush(Color.FromArgb((int)(120 * (1 - t)), Spectrum[1])))
      g.FillEllipse(ring, dot.X - grow, dot.Y - grow, dot.Width + 2 * grow, dot.Height + 2 * grow);
    using (var fill = new LinearGradientBrush(Rectangle.Inflate(dot, 1, 1), Spectrum[0], Spectrum[2], (ticks * 10) % 360f)) {
      fill.InterpolationColors = Blend(255, false);
      g.FillEllipse(fill, dot);
    }
    g.SmoothingMode = was;
  }

  static ColorBlend Blend(int alpha, bool loop) {
    var blend = new ColorBlend();
    Color a = Color.FromArgb(alpha, Spectrum[0]);
    Color b = Color.FromArgb(alpha, Spectrum[1]);
    Color c = Color.FromArgb(alpha, Spectrum[2]);
    blend.Colors = loop ? new[] { a, b, c, a } : new[] { a, b, c };
    blend.Positions = loop ? new[] { 0f, 0.33f, 0.66f, 1f } : new[] { 0f, 0.5f, 1f };
    return blend;
  }

  static GraphicsPath RoundRect(Rectangle r, int radius) {
    int d = radius * 2;
    var path = new GraphicsPath();
    path.AddArc(r.X, r.Y, d, d, 180, 90);
    path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    path.CloseFigure();
    return path;
  }

  internal int S(float px) { return (int)Math.Round(px * scale * Compact); }

  static Font PickFont(float size, FontStyle style, params string[] names) {
    foreach (string name in names) {
      try {
        var font = new Font(name, size, style);
        if (string.Equals(font.Name, name, StringComparison.OrdinalIgnoreCase)) return font;
        font.Dispose();
      } catch (ArgumentException) { }
    }
    return new Font(SystemFonts.MenuFont.FontFamily, size, style);
  }

  // ---- Windows ----

  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  /// Windows 11 rounds the menu and draws its edge; Windows 10 says no and SueRenderer draws a square edge.
  static bool Round(IntPtr hwnd) {
    try {
      int round = 2; // DWMWA_WINDOW_CORNER_PREFERENCE (33) = DWMWCP_ROUND
      if (DwmSetWindowAttribute(hwnd, 33, ref round, 4) != 0) return false;
      int edge = 0x0043403C; // DWMWA_BORDER_COLOR (34), COLORREF of #3c4043
      DwmSetWindowAttribute(hwnd, 34, ref edge, 4);
      return true;
    } catch (DllNotFoundException) {
      return false;
    } catch (EntryPointNotFoundException) {
      return false;
    }
  }

  /// Crisp text on a scaled display. Call before any window exists: Windows fixes it per process.
  public static void UseCrispPixels() {
    try { SetProcessDPIAware(); } catch (EntryPointNotFoundException) { }
  }

  public void Dispose() {
    shimmer.Dispose();
    Strip.Dispose();
    body.Dispose();
    strong.Dispose();
    title.Dispose();
  }
}

sealed class SueRenderer : ToolStripRenderer {
  readonly SueMenu menu;
  public SueRenderer(SueMenu menu) { this.menu = menu; }

  protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) {
    using (var fill = new SolidBrush(SueMenu.Surface)) e.Graphics.FillRectangle(fill, new Rectangle(Point.Empty, e.ToolStrip.Size));
  }

  protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) {
    Size size = e.ToolStrip.Size;
    if (!menu.Rounded) {
      using (var pen = new Pen(SueMenu.Edge)) e.Graphics.DrawRectangle(pen, 0, 0, size.Width - 1, size.Height - 1);
    }
    menu.PaintAccent(e.Graphics, size.Width);
  }

  protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e) {
    var row = e.Item as SueRow;
    if (row == null || !row.Enabled || !(row.Selected || row.Pressed)) return;
    menu.PaintHover(e.Graphics, row.Size);
  }

  protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
    var row = e.Item as SueRow;
    if (row == null) { base.OnRenderItemText(e); return; }
    menu.PaintRow(e.Graphics, row);
  }

  protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e) {
    menu.PaintSeparator(e.Graphics, e.Item);
  }
}
'@
Add-Type -TypeDefinition $sueMenuSource -ReferencedAssemblies System.Windows.Forms, System.Drawing
[SueMenu]::UseCrispPixels()

# Raw UTF-8 streams, not [Console]: this process has no console, and a note may carry any character.
$utf8 = New-Object System.Text.UTF8Encoding($false)
$script:reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$script:writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$script:writer.AutoFlush = $true

function Tell([string]$word) {
  try { $script:writer.WriteLine($word) } catch { }
}

# ⛔ From BYTES, never Bitmap($Icon): GDI+ keeps a path-loaded image's file open for the image's whole
# life, and this process lives as long as the Manager. The icon is a TRACKED file
# (services/studio/web/public/sue-favicon-32x32.png), so while Sue ran, git could not replace it and
# every checkout's sync died on "unable to unlink ... Invalid argument" (2026-09-27). GDI+ needs the
# stream alive while the bitmap is, so it stays in script scope.
$script:iconStream = New-Object System.IO.MemoryStream(, [System.IO.File]::ReadAllBytes($Icon))
$bitmap = New-Object System.Drawing.Bitmap($script:iconStream)
$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$script:notify.Text = "Sue"

# A click brings her window back; when there is none, the Manager opens one.
$bringBack = {
  if (-not [SueWindow]::Raise($WindowTitle)) { Tell "open" }
}

# SueMenu draws the menu and says which row was chosen. A running wave's row raises her window and
# asks the Manager to turn it to that run, or asks the Manager to open one there.
$script:menu = New-Object SueMenu
$script:menu.add_Command({
  param([string]$word)
  if ($word -eq "open") { & $bringBack }
  elseif ($word.StartsWith("open ")) {
    if ([SueWindow]::Raise($WindowTitle)) { Tell ("show " + $word.Substring(5)) } else { Tell $word }
  }
  else { Tell $word }
})
$script:notify.ContextMenuStrip = $script:menu.Strip

$script:notify.add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { & $bringBack }
})
$script:notify.add_BalloonTipClicked($bringBack)
$script:notify.Visible = $true

function Stop-Tray {
  $script:timer.Stop()
  $script:notify.Visible = $false
  $script:notify.Dispose()
  $script:menu.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

# Hover text has a hard limit in this framework; longer text throws.
function Set-Tip([string]$text) {
  if ($text.Length -gt 63) { $text = $text.Substring(0, 62) + [char]0x2026 }
  $script:notify.Text = $text
}

function Set-Runs($runs, [int]$more) {
  $list = New-Object 'System.Collections.Generic.List[SueRun]'
  foreach ($run in @($runs)) {
    if ($null -eq $run) { continue }
    $list.Add((New-Object SueRun -ArgumentList ([string]$run.runId), ([string]$run.host), ([int]$run.done), ([int]$run.total)))
  }
  $script:menu.SetRuns($list, $more)
}

function Handle([string]$line) {
  $message = $null
  try { $message = $line | ConvertFrom-Json } catch { return }
  if ($null -eq $message) { return }
  if ($message.PSObject.Properties.Name -contains "say") {
    $script:notify.ShowBalloonTip(5000, [string]$message.say.title, [string]$message.say.text, [System.Windows.Forms.ToolTipIcon]::None)
  }
  if ($message.PSObject.Properties.Name -contains "tip") { Set-Tip ([string]$message.tip) }
  # A list it cannot read leaves the rows as they were; the Manager's log keeps why.
  if ($message.PSObject.Properties.Name -contains "runs") {
    try { Set-Runs $message.runs ([int]$message.more) } catch { [Console]::Error.WriteLine("runs: $($_.Exception.Message)") }
  }
}

# Standard input is read without blocking the message loop: one pending read, checked on a timer.
$script:pending = $script:reader.ReadLineAsync()
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 200
$script:timer.add_Tick({
  while ($script:pending.IsCompleted) {
    $line = $null
    try { $line = $script:pending.Result } catch { }
    if ($null -eq $line) { Stop-Tray; return }
    Handle $line
    $script:pending = $script:reader.ReadLineAsync()
  }
})
$script:timer.Start()

Tell "ready"
[System.Windows.Forms.Application]::Run()
