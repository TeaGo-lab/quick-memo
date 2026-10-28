using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace QuickMemo
{
    public enum DockEdge
    {
        None,
        Left,
        Right,
        Top
    }

    /// <summary>
    /// 绘制 macOS 风格流光渐变圆角图标（便签折页 + AI 四角星芒）
    /// </summary>
    public static class AppIconRenderer
    {
        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);

        public static Bitmap RenderIconBitmap(int size)
        {
            var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                g.Clear(Color.Transparent);

                float pad = size * 0.06f;
                float boxSize = size - pad * 2f;
                float radius = boxSize * 0.24f;
                RectangleF rect = new RectangleF(pad, pad, boxSize, boxSize);

                using (GraphicsPath bgPath = CreateRoundedRectPath(rect, radius))
                {
                    using (var bgBrush = new LinearGradientBrush(
                        new PointF(rect.Left, rect.Top),
                        new PointF(rect.Right, rect.Bottom),
                        Color.FromArgb(255, 99, 102, 241),
                        Color.FromArgb(255, 6, 182, 212)))
                    {
                        var blend = new ColorBlend(3)
                        {
                            Colors = new[]
                            {
                                Color.FromArgb(255, 99, 102, 241),
                                Color.FromArgb(255, 37, 99, 235),
                                Color.FromArgb(255, 6, 182, 212)
                            },
                            Positions = new[] { 0f, 0.52f, 1f }
                        };
                        bgBrush.InterpolationColors = blend;
                        g.FillPath(bgBrush, bgPath);
                    }

                    RectangleF glossRect = new RectangleF(rect.Left, rect.Top, rect.Width, rect.Height * 0.55f);
                    using (var glossBrush = new LinearGradientBrush(
                        glossRect,
                        Color.FromArgb(75, 255, 255, 255),
                        Color.FromArgb(0, 255, 255, 255),
                        LinearGradientMode.Vertical))
                    {
                        g.SetClip(bgPath);
                        g.FillEllipse(glossBrush, rect.Left - rect.Width * 0.2f, rect.Top - rect.Height * 0.35f, rect.Width * 1.4f, rect.Height * 0.9f);
                        g.ResetClip();
                    }

                    using (var borderPen = new Pen(Color.FromArgb(115, 255, 255, 255), Math.Max(1f, size * 0.022f)))
                    {
                        g.DrawPath(borderPen, bgPath);
                    }
                }

                float cardW = boxSize * 0.54f;
                float cardH = boxSize * 0.60f;
                float cardX = pad + (boxSize - cardW) * 0.44f;
                float cardY = pad + (boxSize - cardH) * 0.52f;
                float cardRadius = cardW * 0.18f;
                RectangleF cardRect = new RectangleF(cardX, cardY, cardW, cardH);

                RectangleF shadowRect = new RectangleF(cardX + size * 0.015f, cardY + size * 0.03f, cardW, cardH);
                using (GraphicsPath shadowPath = CreateRoundedRectPath(shadowRect, cardRadius))
                using (var shadowBrush = new SolidBrush(Color.FromArgb(55, 15, 23, 42)))
                {
                    g.FillPath(shadowBrush, shadowPath);
                }

                using (GraphicsPath cardPath = CreateRoundedRectPath(cardRect, cardRadius))
                using (var cardBrush = new LinearGradientBrush(
                    cardRect,
                    Color.FromArgb(250, 255, 255, 255),
                    Color.FromArgb(230, 241, 245, 249),
                    LinearGradientMode.Vertical))
                {
                    g.FillPath(cardBrush, cardPath);
                }

                float lineLeft = cardX + cardW * 0.20f;
                float lineThickness = Math.Max(1.5f, size * 0.048f);
                using (var linePen1 = new Pen(Color.FromArgb(235, 59, 130, 246), lineThickness) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                using (var linePen2 = new Pen(Color.FromArgb(180, 99, 102, 241), lineThickness) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                using (var linePen3 = new Pen(Color.FromArgb(140, 148, 163, 184), lineThickness) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                {
                    float y1 = cardY + cardH * 0.30f;
                    float y2 = cardY + cardH * 0.52f;
                    float y3 = cardY + cardH * 0.74f;
                    g.DrawLine(linePen1, lineLeft, y1, cardX + cardW * 0.78f, y1);
                    g.DrawLine(linePen2, lineLeft, y2, cardX + cardW * 0.68f, y2);
                    g.DrawLine(linePen3, lineLeft, y3, cardX + cardW * 0.52f, y3);
                }

                float starCx = pad + boxSize * 0.74f;
                float starCy = pad + boxSize * 0.27f;
                float starR = boxSize * 0.21f;
                using (GraphicsPath starPath = CreateFourPointStarPath(starCx, starCy, starR, starR * 0.28f))
                using (var starBrush = new LinearGradientBrush(
                    new RectangleF(starCx - starR, starCy - starR, starR * 2, starR * 2),
                    Color.FromArgb(255, 255, 251, 235),
                    Color.FromArgb(255, 251, 191, 36),
                    LinearGradientMode.ForwardDiagonal))
                {
                    g.FillPath(starBrush, starPath);
                    using (var starPen = new Pen(Color.FromArgb(220, 255, 255, 255), Math.Max(1f, size * 0.015f)))
                    {
                        g.DrawPath(starPen, starPath);
                    }
                }
            }
            return bmp;
        }

        public static Icon CreateRuntimeIcon(int size)
        {
            using (Bitmap bmp = RenderIconBitmap(size))
            {
                IntPtr hIcon = bmp.GetHicon();
                using (Icon temp = Icon.FromHandle(hIcon))
                {
                    Icon cloned = (Icon)temp.Clone();
                    DestroyIcon(hIcon);
                    return cloned;
                }
            }
        }

        public static void SaveIconFiles(string pngPath, string icoPath)
        {
            using (Bitmap bmp256 = RenderIconBitmap(256))
            {
                bmp256.Save(pngPath, ImageFormat.Png);
            }

            int[] sizes = new[] { 256, 64, 32, 16 };
            byte[][] pngBuffers = new byte[sizes.Length][];
            for (int i = 0; i < sizes.Length; i++)
            {
                using (Bitmap b = RenderIconBitmap(sizes[i]))
                using (var ms = new MemoryStream())
                {
                    b.Save(ms, ImageFormat.Png);
                    pngBuffers[i] = ms.ToArray();
                }
            }

            using (var fs = new FileStream(icoPath, FileMode.Create, FileAccess.Write))
            using (var bw = new BinaryWriter(fs))
            {
                bw.Write((ushort)0);
                bw.Write((ushort)1);
                bw.Write((ushort)sizes.Length);

                int offset = 6 + 16 * sizes.Length;
                for (int i = 0; i < sizes.Length; i++)
                {
                    int s = sizes[i];
                    bw.Write((byte)(s >= 256 ? 0 : s));
                    bw.Write((byte)(s >= 256 ? 0 : s));
                    bw.Write((byte)0);
                    bw.Write((byte)0);
                    bw.Write((ushort)1);
                    bw.Write((ushort)32);
                    bw.Write((uint)pngBuffers[i].Length);
                    bw.Write((uint)offset);
                    offset += pngBuffers[i].Length;
                }

                for (int i = 0; i < sizes.Length; i++)
                {
                    bw.Write(pngBuffers[i]);
                }
            }
        }

        public static GraphicsPath CreateRoundedRectPath(RectangleF rect, float radius)
        {
            float d = Math.Min(radius * 2f, Math.Min(rect.Width, rect.Height));
            var path = new GraphicsPath();
            path.AddArc(rect.Left, rect.Top, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Top, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.Left, rect.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        public static GraphicsPath CreateFourPointStarPath(float cx, float cy, float outerR, float innerR)
        {
            var pts = new PointF[8];
            for (int i = 0; i < 8; i++)
            {
                double angle = i * Math.PI / 4.0 - Math.PI / 2.0;
                float r = (i % 2 == 0) ? outerR : innerR;
                pts[i] = new PointF(
                    cx + (float)(Math.Cos(angle) * r),
                    cy + (float)(Math.Sin(angle) * r)
                );
            }
            var path = new GraphicsPath();
            path.AddPolygon(pts);
            return path;
        }
    }

    public class QuickMemoAppContext : ApplicationContext
    {
        #region Win32 API

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;

            public int Width { get { return Right - Left; } }
            public int Height { get { return Bottom - Top; } }
            public Rectangle ToRectangle() { return new Rectangle(Left, Top, Width, Height); }
        }

        private const int HOTKEY_ID_TOGGLE = 9001;
        private const uint MOD_ALT = 0x0001;
        private const uint VK_SPACE = 0x20;
        private const int VK_LBUTTON = 0x01;

        private const int SW_HIDE = 0;
        private const int SW_SHOW = 5;
        private const int SW_RESTORE = 9;

        private static readonly IntPtr HWND_TOP = new IntPtr(0);
        private static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
        private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint SWP_SHOWWINDOW = 0x0040;

        #endregion

        private readonly string _appRoot;
        private readonly string _appUrl = "http://127.0.0.1:1420";
        private readonly string _cmdFilePath;
        private Process _nodeServerProcess;
        private NotifyIcon _trayIcon;
        private HotKeyMessageWindow _hotKeyWindow;
        private System.Windows.Forms.Timer _monitorTimer;
        private EdgePeekForm _edgePeekForm;

        private IntPtr _targetHwnd = IntPtr.Zero;
        private bool _hiddenToTray = false;
        private bool _hasShownCloseTip = false;
        private bool _wasWindowAlive = false;

        // 贴边与快捷键展开状态控制
        private const int MIN_WINDOW_WIDTH = 900;
        private const int MIN_WINDOW_HEIGHT = 620;
        private DockEdge _dockEdge = DockEdge.None;
        private bool _isCollapsedOutside = false;
        private bool _isPinnedTopMost = false;
        private bool _wasMouseDragging = false;
        private DateTime _lastHotKeyTime = DateTime.MinValue;
        private Rectangle _expandedBounds = new Rectangle(200, 120, 1060, 720);
        private const string RUN_REG_KEY = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RUN_VALUE_NAME = "QuickMemo";

        public QuickMemoAppContext(string appRoot, bool isAutoStartLaunch = false)
        {
            _appRoot = appRoot;
            _cmdFilePath = Path.Combine(_appRoot, ".window-cmd.json");
            if (File.Exists(_cmdFilePath))
            {
                try { File.Delete(_cmdFilePath); } catch { }
            }

            try
            {
                string iconDir = Path.Combine(_appRoot, "src-tauri", "icons");
                if (!Directory.Exists(iconDir)) Directory.CreateDirectory(iconDir);
                AppIconRenderer.SaveIconFiles(
                    Path.Combine(iconDir, "icon.png"),
                    Path.Combine(iconDir, "icon.ico")
                );
            }
            catch { }

            EnsureEmbeddedAppFilesExtracted();
            SyncAutoStartRegistryOnStartup();
            EnsureBackendRunning();
            SetupTrayIcon();
            SetupEdgePeekForm();
            SetupGlobalHotKey();

            if (isAutoStartLaunch && IsAutoStartSilentInConfig())
            {
                _hiddenToTray = true;
                _trayIcon.ShowBalloonTip(
                    2200,
                    "QuickMemo 已随开机在后台就绪",
                    "随时按 Alt + Space 即可呼出闪念收纳盒。",
                    ToolTipIcon.Info
                );
            }
            else
            {
                OpenOrActivateWindow();
            }

            _monitorTimer = new System.Windows.Forms.Timer { Interval = 90 };
            _monitorTimer.Tick += OnMonitorTick;
            _monitorTimer.Start();
        }

        private bool IsAutoStartEnabledInRegistry()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RUN_REG_KEY, false))
                {
                    if (key == null) return false;
                    object val = key.GetValue(RUN_VALUE_NAME);
                    return val != null && !string.IsNullOrEmpty(val.ToString());
                }
            }
            catch
            {
                return false;
            }
        }

        private bool IsAutoStartSilentInConfig()
        {
            try
            {
                string cfgPath = Path.Combine(_appRoot, ".quick-memo-config.json");
                if (File.Exists(cfgPath))
                {
                    string raw = File.ReadAllText(cfgPath);
                    if (Regex.IsMatch(raw, "\"autoStartSilent\"\\s*:\\s*false", RegexOptions.IgnoreCase))
                    {
                        return false;
                    }
                }
            }
            catch { }
            return true;
        }

        private void SyncAutoStartRegistryOnStartup()
        {
            try
            {
                string cfgPath = Path.Combine(_appRoot, ".quick-memo-config.json");
                if (File.Exists(cfgPath))
                {
                    string raw = File.ReadAllText(cfgPath);
                    if (Regex.IsMatch(raw, "\"autoStart\"\\s*:\\s*true", RegexOptions.IgnoreCase))
                    {
                        SetAutoStart(true, false);
                    }
                }
            }
            catch { }
        }

        private void SetAutoStart(bool enabled, bool updateConfigFile = true)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RUN_REG_KEY, true))
                {
                    if (key != null)
                    {
                        if (enabled)
                        {
                            bool silent = IsAutoStartSilentInConfig();
                            string exePath = Application.ExecutablePath;
                            string cmd = "\"" + exePath + "\"" + (silent ? " --autostart" : "");
                            key.SetValue(RUN_VALUE_NAME, cmd, RegistryValueKind.String);
                        }
                        else
                        {
                            if (key.GetValue(RUN_VALUE_NAME) != null)
                            {
                                key.DeleteValue(RUN_VALUE_NAME, false);
                            }
                        }
                    }
                }
            }
            catch { }

            if (updateConfigFile)
            {
                try
                {
                    string cfgPath = Path.Combine(_appRoot, ".quick-memo-config.json");
                    if (File.Exists(cfgPath))
                    {
                        string raw = File.ReadAllText(cfgPath);
                        string boolStr = enabled ? "true" : "false";
                        if (Regex.IsMatch(raw, "\"autoStart\"\\s*:\\s*(true|false)", RegexOptions.IgnoreCase))
                        {
                            raw = Regex.Replace(raw, "\"autoStart\"\\s*:\\s*(true|false)", "\"autoStart\": " + boolStr, RegexOptions.IgnoreCase);
                        }
                        else
                        {
                            raw = Regex.Replace(raw, "^\\s*\\{", "{\r\n  \"autoStart\": " + boolStr + ",");
                        }
                        File.WriteAllText(cfgPath, raw);
                    }
                }
                catch { }
            }
        }

        /// <summary>
        /// 单文件 EXE 自解压支持：如果用户只单独下载了 QuickMemo.exe 到任意空文件夹，
        /// 启动时自动将内嵌在 EXE 资源中的前端 dist/ 与后端 server/ 释放到当前目录，无需额外下载解压 zip。
        /// </summary>
        private void EnsureEmbeddedAppFilesExtracted()
        {
            string standaloneJs = Path.Combine(_appRoot, "server", "standalone.js");
            string distIndex = Path.Combine(_appRoot, "dist", "index.html");

            // 若当前目录下核心前后端文件已存在，不重复覆盖本地文件
            if (File.Exists(standaloneJs) && File.Exists(distIndex))
            {
                return;
            }

            try
            {
                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream resStream = asm.GetManifestResourceStream("QuickMemo.Payload.zip"))
                {
                    if (resStream == null) return;
                    using (var archive = new ZipArchive(resStream, ZipArchiveMode.Read))
                    {
                        foreach (ZipArchiveEntry entry in archive.Entries)
                        {
                            if (string.IsNullOrEmpty(entry.Name)) continue;
                            string relPath = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                            string destPath = Path.Combine(_appRoot, relPath);
                            string destDir = Path.GetDirectoryName(destPath);
                            if (!string.IsNullOrEmpty(destDir) && !Directory.Exists(destDir))
                            {
                                Directory.CreateDirectory(destDir);
                            }
                            using (Stream entryStream = entry.Open())
                            using (FileStream outStream = new FileStream(destPath, FileMode.Create, FileAccess.Write))
                            {
                                entryStream.CopyTo(outStream);
                            }
                        }
                    }
                }
            }
            catch { }
        }

        private bool IsPortOpen(int port)
        {
            try
            {
                using (var client = new TcpClient())
                {
                    var result = client.BeginConnect("127.0.0.1", port, null, null);
                    var success = result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(200));
                    if (!success) return false;
                    client.EndConnect(result);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private void EnsureBackendRunning()
        {
            if (IsPortOpen(1420)) return;

            string scriptPath = Path.Combine(_appRoot, "server", "standalone.js");
            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "\"" + scriptPath + "\"",
                WorkingDirectory = _appRoot,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            try
            {
                _nodeServerProcess = Process.Start(psi);
                for (int i = 0; i < 65; i++)
                {
                    if (IsPortOpen(1420)) break;
                    Thread.Sleep(80);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "启动本地服务失败，请确认已安装 Node.js：\n" + ex.Message,
                    "QuickMemo 启动错误",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        private void SetupTrayIcon()
        {
            Icon icon;
            try
            {
                icon = AppIconRenderer.CreateRuntimeIcon(32);
            }
            catch
            {
                icon = SystemIcons.Application;
            }

            var menu = new ContextMenuStrip();

            var openItem = new ToolStripMenuItem("✦ 显示 / 隐藏主窗口 (Alt+Space)");
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            openItem.Click += (s, e) => ToggleWindowByShortcut();

            var dockRightItem = new ToolStripMenuItem("⇥ 缩到桌面右侧边缘 (苹果磨砂悬浮条)");
            dockRightItem.Click += (s, e) => DockWindowToRightEdgeAndCollapse();

            var undockItem = new ToolStripMenuItem("🗔 恢复居中普通窗口");
            undockItem.Click += (s, e) => RestoreCenterNormalWindow();

            var vaultItem = new ToolStripMenuItem("📂 打开本地 Markdown 文件夹");
            vaultItem.Click += (s, e) => OpenVaultFolder();

            var autoStartItem = new ToolStripMenuItem("🚀 开机自动启动")
            {
                Checked = IsAutoStartEnabledInRegistry()
            };
            autoStartItem.Click += (s, e) =>
            {
                bool nextState = !IsAutoStartEnabledInRegistry();
                SetAutoStart(nextState, true);
                autoStartItem.Checked = nextState;
                _trayIcon.ShowBalloonTip(
                    2000,
                    "QuickMemo 开机自启设置",
                    nextState ? "已开启开机自动启动（登录 Windows 后自动后台就绪）" : "已关闭开机自动启动",
                    ToolTipIcon.Info
                );
            };

            menu.Opening += (s, e) =>
            {
                autoStartItem.Checked = IsAutoStartEnabledInRegistry();
            };

            var exitItem = new ToolStripMenuItem("❌ 彻底退出程序");
            exitItem.Click += (s, e) => ExitApplication();

            menu.Items.Add(openItem);
            menu.Items.Add(dockRightItem);
            menu.Items.Add(undockItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(autoStartItem);
            menu.Items.Add(vaultItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);

            _trayIcon = new NotifyIcon
            {
                Icon = icon,
                Text = "QuickMemo · 闪念收纳盒 (Alt+Space)",
                ContextMenuStrip = menu,
                Visible = true
            };

            _trayIcon.DoubleClick += (s, e) => OpenOrActivateWindow();
        }

        private void SetupEdgePeekForm()
        {
            _edgePeekForm = new EdgePeekForm();
            // 鼠标移到桌面侧边磨砂条上时展开（非快捷键展开，鼠标移入即激活）
            _edgePeekForm.MouseEnterTrigger += (s, e) => ExpandFromOutside(true, false);
            _edgePeekForm.ClickTrigger += (s, e) => ExpandFromOutside(true, true);
        }

        private void SetupGlobalHotKey()
        {
            _hotKeyWindow = new HotKeyMessageWindow(this);
            RegisterHotKey(_hotKeyWindow.Handle, HOTKEY_ID_TOGGLE, MOD_ALT, VK_SPACE);
        }

        /// <summary>
        /// 判断窗口是否为 QuickMemo 主窗口。
        /// 只看标题前缀会误伤 VS Code 等同为 Chromium/Electron 的窗口（例如打开了 “QuickMemo-xxx.txt” 时标题也以 QuickMemo 开头），
        /// 因此要求标题以完整应用名 “QuickMemo · ” 开头，并校验所属进程是 Edge / Tauri 应用本身。
        /// </summary>
        private static bool IsQuickMemoWindow(IntPtr hWnd)
        {
            var sb = new System.Text.StringBuilder(256);
            if (GetWindowText(hWnd, sb, sb.Capacity) <= 0) return false;
            string title = sb.ToString();
            if (!title.StartsWith("QuickMemo · ")) return false;

            var cls = new System.Text.StringBuilder(128);
            GetClassName(hWnd, cls, cls.Capacity);
            if (!cls.ToString().Contains("Chrome_WidgetWin")) return false;

            try
            {
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                string procName = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();
                return procName == "msedge" || procName.Contains("quick-memo") || procName.Contains("quickmemo");
            }
            catch
            {
                return false;
            }
        }

        private IntPtr FindQuickMemoWindow()
        {
            if (_targetHwnd != IntPtr.Zero && IsWindow(_targetHwnd) && IsQuickMemoWindow(_targetHwnd))
            {
                return _targetHwnd;
            }
            _targetHwnd = IntPtr.Zero;

            IntPtr found = IntPtr.Zero;
            EnumWindows((hWnd, lParam) =>
            {
                if (IsQuickMemoWindow(hWnd))
                {
                    found = hWnd;
                    return false;
                }
                return true;
            }, IntPtr.Zero);

            if (found != IntPtr.Zero)
            {
                _targetHwnd = found;
                _wasWindowAlive = true;
            }
            return found;
        }

        /// <summary>
        /// 使用 AttachThreadInput 将窗口平顺地置为前台焦点（不模拟 Alt 按键，避免触发浏览器系统菜单导致失焦缩回）
        /// </summary>
        private void ForceForeground(IntPtr hwnd)
        {
            try
            {
                if (IsIconic(hwnd))
                {
                    ShowWindow(hwnd, SW_RESTORE);
                }
                else
                {
                    ShowWindow(hwnd, SW_SHOW);
                }

                IntPtr fgHwnd = GetForegroundWindow();
                if (fgHwnd != hwnd)
                {
                    uint dummy;
                    uint fgThread = GetWindowThreadProcessId(fgHwnd, out dummy);
                    uint curThread = GetCurrentThreadId();
                    if (fgThread != curThread && fgThread != 0)
                    {
                        AttachThreadInput(curThread, fgThread, true);
                        BringWindowToTop(hwnd);
                        SetForegroundWindow(hwnd);
                        AttachThreadInput(curThread, fgThread, false);
                    }
                    else
                    {
                        BringWindowToTop(hwnd);
                        SetForegroundWindow(hwnd);
                    }
                }
            }
            catch { }
        }

        public void ToggleWindowByShortcut()
        {
            // 300ms 防抖，防止长按或按键回弹造成弹出又立刻缩回
            if ((DateTime.Now - _lastHotKeyTime).TotalMilliseconds < 300)
            {
                return;
            }
            _lastHotKeyTime = DateTime.Now;

            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd == IntPtr.Zero)
            {
                OpenOrActivateWindow();
                return;
            }

            if (_hiddenToTray || !IsWindowVisible(hwnd) || IsIconic(hwnd))
            {
                _hiddenToTray = false;
                if (_dockEdge != DockEdge.None)
                {
                    ExpandFromOutside(true, true);
                }
                else
                {
                    ForceForeground(hwnd);
                }
                return;
            }

            if (_isCollapsedOutside)
            {
                ExpandFromOutside(true, true);
                return;
            }

            IntPtr fg = GetForegroundWindow();
            if (fg == hwnd)
            {
                // 当前已在前台焦点：再按一次 Alt+Space 则收起
                if (_dockEdge != DockEdge.None)
                {
                    CollapseToOutside();
                }
                else
                {
                    HideWindowToTray();
                }
            }
            else
            {
                // 窗口虽然展开但被其它窗口挡在后面 -> 唤到前台并保持展开
                ForceForeground(hwnd);
            }
        }

        public void OpenOrActivateWindow()
        {
            EnsureBackendRunning();
            _hiddenToTray = false;

            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd != IntPtr.Zero)
            {
                if (_isCollapsedOutside)
                {
                    ExpandFromOutside(true, true);
                }
                else
                {
                    ForceForeground(hwnd);
                }
                return;
            }

            string profileDir = Path.Combine(_appRoot, ".webview-profile");
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "msedge.exe",
                    Arguments = "--app=\"" + _appUrl + "\" --user-data-dir=\"" + profileDir + "\" --window-size=1060,720",
                    UseShellExecute = true
                };
                Process.Start(psi);
            }
            catch
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = _appUrl,
                    UseShellExecute = true
                });
            }
        }

        public void HideWindowToTray()
        {
            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd != IntPtr.Zero && IsWindow(hwnd))
            {
                ShowWindow(hwnd, SW_HIDE);
                _hiddenToTray = true;
                _edgePeekForm.Hide();
            }
        }

        public void DockWindowToRightEdgeAndCollapse()
        {
            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd == IntPtr.Zero)
            {
                OpenOrActivateWindow();
                return;
            }

            _hiddenToTray = false;
            ShowWindow(hwnd, SW_SHOW);

            RECT r;
            if (GetWindowRect(hwnd, out r))
            {
                Screen scr = Screen.FromHandle(hwnd);
                int w = Math.Min(Math.Max(r.Width, MIN_WINDOW_WIDTH), 1080);
                int h = Math.Min(Math.Max(r.Height, MIN_WINDOW_HEIGHT), scr.WorkingArea.Height - 40);
                int x = scr.WorkingArea.Right - w;
                int y = Math.Max(scr.WorkingArea.Top + 20, Math.Min(r.Top, scr.WorkingArea.Bottom - h - 20));
                _expandedBounds = new Rectangle(x, y, w, h);
                _dockEdge = DockEdge.Right;
                CollapseToOutside();
            }
        }

        public void RestoreCenterNormalWindow()
        {
            _dockEdge = DockEdge.None;
            _isCollapsedOutside = false;
            _hiddenToTray = false;
            _edgePeekForm.Hide();

            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd == IntPtr.Zero)
            {
                OpenOrActivateWindow();
                return;
            }

            Screen scr = Screen.PrimaryScreen;
            int w = 1060;
            int h = 720;
            int x = scr.WorkingArea.Left + (scr.WorkingArea.Width - w) / 2;
            int y = scr.WorkingArea.Top + (scr.WorkingArea.Height - h) / 2;

            SetWindowPos(hwnd, _isPinnedTopMost ? new IntPtr(-1) : HWND_NOTOPMOST, x, y, w, h, SWP_SHOWWINDOW);
            ForceForeground(hwnd);
        }

        public void SetWindowPinnedTopMost(bool pin)
        {
            _isPinnedTopMost = pin;
            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd != IntPtr.Zero && IsWindow(hwnd))
            {
                SetWindowPos(hwnd, pin ? new IntPtr(-1) : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }

        private void CollapseToOutside()
        {
            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd == IntPtr.Zero || _dockEdge == DockEdge.None) return;

            Screen scr = Screen.FromRectangle(_expandedBounds);
            Rectangle work = scr.Bounds;
            int targetX = _expandedBounds.X;
            int targetY = _expandedBounds.Y;

            if (_dockEdge == DockEdge.Right)
            {
                targetX = work.Right + 20;
            }
            else if (_dockEdge == DockEdge.Left)
            {
                targetX = work.Left - _expandedBounds.Width - 20;
            }
            else if (_dockEdge == DockEdge.Top)
            {
                targetY = work.Top - _expandedBounds.Height - 20;
            }

            // 将主窗口移到屏幕外并隐藏，避免残留边框阴影
            SetWindowPos(hwnd, HWND_NOTOPMOST, targetX, targetY, _expandedBounds.Width, _expandedBounds.Height, SWP_NOACTIVATE);
            ShowWindow(hwnd, SW_HIDE);
            _isCollapsedOutside = true;

            // 在桌面底层显示苹果磨砂侧边小标签（只贴在桌面上，不压在其它软件窗口上面）
            _edgePeekForm.ShowAtDesktopEdge(_dockEdge, scr.WorkingArea, _expandedBounds);
        }

        private void ExpandFromOutside(bool activateFocus, bool byShortcut)
        {
            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd == IntPtr.Zero) return;

            _edgePeekForm.Hide();
            _isCollapsedOutside = false;

            Screen scr = Screen.FromRectangle(_expandedBounds);
            Rectangle work = scr.WorkingArea;
            int targetX = _expandedBounds.X;
            int targetY = _expandedBounds.Y;

            if (_dockEdge == DockEdge.Right)
            {
                targetX = work.Right - _expandedBounds.Width - 12;
            }
            else if (_dockEdge == DockEdge.Left)
            {
                targetX = work.Left + 12;
            }
            else if (_dockEdge == DockEdge.Top)
            {
                targetY = work.Top + 12;
            }

            _expandedBounds.X = targetX;
            _expandedBounds.Y = targetY;

            ShowWindow(hwnd, SW_SHOW);
            SetWindowPos(hwnd, _isPinnedTopMost ? new IntPtr(-1) : HWND_TOP, targetX, targetY, _expandedBounds.Width, _expandedBounds.Height, SWP_SHOWWINDOW);
            if (activateFocus)
            {
                ForceForeground(hwnd);
            }
        }

        private void OnMonitorTick(object sender, EventArgs e)
        {
            CheckWindowCommandFile();

            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd == IntPtr.Zero)
            {
                if (_wasWindowAlive)
                {
                    _wasWindowAlive = false;
                    _targetHwnd = IntPtr.Zero;
                    _isCollapsedOutside = false;
                    _edgePeekForm.Hide();

                    if (!_hasShownCloseTip)
                    {
                        _hasShownCloseTip = true;
                        _trayIcon.ShowBalloonTip(
                            2500,
                            "QuickMemo 仍在后台运行",
                            "按 Alt + Space 可随时呼出窗口，或右键托盘图标操作。",
                            ToolTipIcon.Info
                        );
                    }
                }
                return;
            }

            if (_hiddenToTray)
            {
                return;
            }

            // 如果当前已经缩在屏幕外面：保持侧边条在桌面底层，仅靠侧边条自身的鼠标事件或 Alt+Space 唤醒
            if (_isCollapsedOutside)
            {
                _edgePeekForm.SendToDesktopBottom();
                return;
            }

            if (!IsWindowVisible(hwnd) || IsIconic(hwnd) || IsZoomed(hwnd))
            {
                return;
            }

            bool isMouseDown = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
            if (isMouseDown)
            {
                _wasMouseDragging = true;
                return;
            }

            // 仅当用户刚刚用鼠标把窗口主动往屏幕右/左边缘外面推（超出屏幕边界 60px 以上）并松开鼠标时，才自动缩成侧边磨砂小标签！
            // 同时强制保障窗口最小宽度 (900px) 与最小高度 (620px)，防止界面被挤压变形！
            RECT curRect;
            if (GetWindowRect(hwnd, out curRect))
            {
                Rectangle winRect = curRect.ToRectangle();
                Screen currentScreen = Screen.FromRectangle(winRect);
                Rectangle screenBounds = currentScreen.WorkingArea;

                int clampedW = Math.Max(winRect.Width, MIN_WINDOW_WIDTH);
                int clampedH = Math.Max(winRect.Height, MIN_WINDOW_HEIGHT);

                if (_wasMouseDragging)
                {
                    _wasMouseDragging = false;

                    if (winRect.Right > screenBounds.Right + 60)
                    {
                        _dockEdge = DockEdge.Right;
                        _expandedBounds = new Rectangle(screenBounds.Right - clampedW - 12, Math.Max(screenBounds.Top + 20, winRect.Top), clampedW, clampedH);
                        CollapseToOutside();
                        return;
                    }
                    else if (winRect.Left < screenBounds.Left - 60)
                    {
                        _dockEdge = DockEdge.Left;
                        _expandedBounds = new Rectangle(screenBounds.Left + 12, Math.Max(screenBounds.Top + 20, winRect.Top), clampedW, clampedH);
                        CollapseToOutside();
                        return;
                    }
                }

                if (winRect.Width < MIN_WINDOW_WIDTH || winRect.Height < MIN_WINDOW_HEIGHT)
                {
                    SetWindowPos(
                        hwnd,
                        _isPinnedTopMost ? new IntPtr(-1) : HWND_NOTOPMOST,
                        winRect.Left,
                        winRect.Top,
                        clampedW,
                        clampedH,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW
                    );
                }
            }
        }

        private void CheckWindowCommandFile()
        {
            if (!File.Exists(_cmdFilePath)) return;
            try
            {
                string raw = File.ReadAllText(_cmdFilePath);
                File.Delete(_cmdFilePath);
                if (raw.Contains("\"hide\""))
                {
                    HideWindowToTray();
                }
                else if (raw.Contains("\"dock-right\""))
                {
                    DockWindowToRightEdgeAndCollapse();
                }
                else if (raw.Contains("\"restore\""))
                {
                    RestoreCenterNormalWindow();
                }
                else if (raw.Contains("\"pin-on\""))
                {
                    SetWindowPinnedTopMost(true);
                }
                else if (raw.Contains("\"pin-off\""))
                {
                    SetWindowPinnedTopMost(false);
                }
            }
            catch { }
        }

        private void OpenVaultFolder()
        {
            string vaultDir = Path.Combine(_appRoot, "vault");
            if (!Directory.Exists(vaultDir))
            {
                Directory.CreateDirectory(vaultDir);
            }
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = "\"" + vaultDir + "\"",
                UseShellExecute = true
            });
        }

        public void ExitApplication()
        {
            _monitorTimer.Stop();
            try
            {
                if (_hotKeyWindow != null)
                {
                    UnregisterHotKey(_hotKeyWindow.Handle, HOTKEY_ID_TOGGLE);
                    _hotKeyWindow.DestroyHandle();
                }
            }
            catch { }

            try
            {
                if (_edgePeekForm != null)
                {
                    _edgePeekForm.Close();
                }
            }
            catch { }

            try
            {
                if (_trayIcon != null)
                {
                    _trayIcon.Visible = false;
                    _trayIcon.Dispose();
                }
            }
            catch { }

            try
            {
                IntPtr hwnd = FindQuickMemoWindow();
                if (hwnd != IntPtr.Zero && _isCollapsedOutside)
                {
                    ExpandFromOutside(false, false);
                }
            }
            catch { }

            try
            {
                if (_nodeServerProcess != null && !_nodeServerProcess.HasExited)
                {
                    _nodeServerProcess.Kill();
                }
            }
            catch { }

            Application.Exit();
        }

        private class HotKeyMessageWindow : NativeWindow
        {
            private const int WM_HOTKEY = 0x0312;
            private readonly QuickMemoAppContext _ctx;

            public HotKeyMessageWindow(QuickMemoAppContext ctx)
            {
                _ctx = ctx;
                CreateHandle(new CreateParams());
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WM_HOTKEY)
                {
                    _ctx.ToggleWindowByShortcut();
                }
                base.WndProc(ref m);
            }
        }
    }

    /// <summary>
    /// 苹果透明磨砂毛玻璃侧边悬浮胶囊（置于桌面层级 HWND_BOTTOM，只在桌面露出时可见，不遮挡普通应用窗口）
    /// </summary>
    public class EdgePeekForm : Form
    {
        #region DWM & Z-Order Interop

        [DllImport("user32.dll")]
        private static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [StructLayout(LayoutKind.Sequential)]
        private struct AccentPolicy
        {
            public int AccentState;
            public int AccentFlags;
            public uint GradientColor;
            public int AnimationId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WindowCompositionAttributeData
        {
            public int Attribute;
            public IntPtr Data;
            public int SizeOfData;
        }

        private const int WCA_ACCENT_POLICY = 19;
        private const int ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;
        private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        private const int DWMWCP_ROUND = 2;

        private static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint SWP_SHOWWINDOW = 0x0040;

        #endregion

        public event EventHandler MouseEnterTrigger;
        public event EventHandler ClickTrigger;

        private DockEdge _currentEdge = DockEdge.Right;

        public EdgePeekForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = false; // 不置顶，保持在桌面低层级
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.Black;
            Width = 28;
            Height = 108;
            Cursor = Cursors.Hand;
            DoubleBuffered = true;

            MouseEnter += (s, e) =>
            {
                if (MouseEnterTrigger != null) MouseEnterTrigger(this, EventArgs.Empty);
            };
            Click += (s, e) =>
            {
                if (ClickTrigger != null) ClickTrigger(this, EventArgs.Empty);
            };
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                // WS_EX_TOOLWINDOW (0x80) | WS_EX_NOACTIVATE (0x08000000)
                cp.ExStyle |= 0x00000080 | 0x08000000;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            EnableAppleFrostedBlur();
            SendToDesktopBottom();
        }

        public void SendToDesktopBottom()
        {
            if (IsHandleCreated && Visible)
            {
                SetWindowPos(Handle, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }

        private void EnableAppleFrostedBlur()
        {
            try
            {
                int cornerPref = DWMWCP_ROUND;
                DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref cornerPref, sizeof(int));
            }
            catch { }

            try
            {
                var accent = new AccentPolicy
                {
                    AccentState = ACCENT_ENABLE_ACRYLICBLURBEHIND,
                    AccentFlags = 2,
                    GradientColor = 0x50F8FAFC
                };

                int size = Marshal.SizeOf(accent);
                IntPtr ptr = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(accent, ptr, false);
                    var data = new WindowCompositionAttributeData
                    {
                        Attribute = WCA_ACCENT_POLICY,
                        Data = ptr,
                        SizeOfData = size
                    };
                    SetWindowCompositionAttribute(Handle, ref data);
                }
                finally
                {
                    Marshal.FreeHGlobal(ptr);
                }
            }
            catch
            {
                Opacity = 0.86;
            }
        }

        public void ShowAtDesktopEdge(DockEdge edge, Rectangle workArea, Rectangle expandedBounds)
        {
            _currentEdge = edge;
            int x, y, w, h;
            if (edge == DockEdge.Top)
            {
                w = 108;
                h = 28;
                x = Math.Max(workArea.Left + 24, Math.Min(expandedBounds.Left + expandedBounds.Width / 2 - 54, workArea.Right - 132));
                y = workArea.Top + 4;
            }
            else if (edge == DockEdge.Left)
            {
                w = 28;
                h = 108;
                x = workArea.Left + 4;
                y = Math.Max(workArea.Top + 40, Math.Min(expandedBounds.Top + 90, workArea.Bottom - 130));
            }
            else
            {
                w = 28;
                h = 108;
                x = workArea.Right - w - 4;
                y = Math.Max(workArea.Top + 40, Math.Min(expandedBounds.Top + 90, workArea.Bottom - 130));
            }

            if (!Visible)
            {
                Show();
                EnableAppleFrostedBlur();
            }
            // 将侧边磨砂条放置在 Z-Order 最底层（紧贴桌面之上、所有普通应用窗口之下）
            SetWindowPos(Handle, HWND_BOTTOM, x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;

            RectangleF rect = new RectangleF(1f, 1f, Width - 2f, Height - 2f);
            float radius = Math.Min(Width, Height) * 0.46f;

            using (GraphicsPath pillPath = AppIconRenderer.CreateRoundedRectPath(rect, radius))
            {
                using (var glassBrush = new LinearGradientBrush(
                    rect,
                    Color.FromArgb(68, 255, 255, 255),
                    Color.FromArgb(32, 148, 163, 184),
                    LinearGradientMode.Vertical))
                {
                    g.FillPath(glassBrush, pillPath);
                }

                using (var borderBrush = new LinearGradientBrush(
                    rect,
                    Color.FromArgb(185, 255, 255, 255),
                    Color.FromArgb(75, 255, 255, 255),
                    LinearGradientMode.ForwardDiagonal))
                using (var borderPen = new Pen(borderBrush, 1.25f))
                {
                    g.DrawPath(borderPen, pillPath);
                }
            }

            if (_currentEdge == DockEdge.Top)
            {
                float badgeSize = 16f;
                float badgeX = 10f;
                float badgeY = (Height - badgeSize) / 2f;
                DrawMiniBadge(g, badgeX, badgeY, badgeSize);

                RectangleF barRect = new RectangleF(34f, (Height - 4.5f) / 2f, 58f, 4.5f);
                using (GraphicsPath barPath = AppIconRenderer.CreateRoundedRectPath(barRect, 2.25f))
                using (var barBrush = new SolidBrush(Color.FromArgb(215, 255, 255, 255)))
                {
                    g.FillPath(barBrush, barPath);
                }
            }
            else
            {
                float badgeSize = 17f;
                float badgeX = (Width - badgeSize) / 2f;
                float badgeY = 12f;
                DrawMiniBadge(g, badgeX, badgeY, badgeSize);

                RectangleF barRect = new RectangleF((Width - 4.5f) / 2f, 38f, 4.5f, 52f);
                using (GraphicsPath barPath = AppIconRenderer.CreateRoundedRectPath(barRect, 2.25f))
                using (var barBrush = new LinearGradientBrush(
                    barRect,
                    Color.FromArgb(230, 255, 255, 255),
                    Color.FromArgb(145, 226, 232, 240),
                    LinearGradientMode.Vertical))
                {
                    g.FillPath(barBrush, barPath);
                }
            }
        }

        private void DrawMiniBadge(Graphics g, float x, float y, float size)
        {
            RectangleF r = new RectangleF(x, y, size, size);
            using (var brush = new LinearGradientBrush(
                r,
                Color.FromArgb(235, 99, 102, 241),
                Color.FromArgb(235, 6, 182, 212),
                LinearGradientMode.ForwardDiagonal))
            {
                g.FillEllipse(brush, r);
            }

            float cx = x + size / 2f;
            float cy = y + size / 2f;
            float sr = size * 0.34f;
            using (GraphicsPath star = AppIconRenderer.CreateFourPointStarPath(cx, cy, sr, sr * 0.30f))
            using (var sb = new SolidBrush(Color.White))
            {
                g.FillPath(sb, star);
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            string appRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');

            if (args != null && args.Length > 0 && args[0] == "--gen-icons")
            {
                string iconDir = Path.Combine(appRoot, "src-tauri", "icons");
                if (!Directory.Exists(iconDir)) Directory.CreateDirectory(iconDir);
                AppIconRenderer.SaveIconFiles(
                    Path.Combine(iconDir, "icon.png"),
                    Path.Combine(iconDir, "icon.ico")
                );
                return;
            }

            bool createdNew;
            using (var mutex = new Mutex(true, "QuickMemo_Desktop_SingleInstance_Mutex", out createdNew))
            {
                if (!createdNew)
                {
                    try
                    {
                        string cmdFile = Path.Combine(appRoot, ".window-cmd.json");
                        File.WriteAllText(cmdFile, "{\"cmd\":\"restore\"}");
                    }
                    catch { }
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                bool isAutoStart = args != null && Array.Exists(args, a =>
                    string.Equals(a, "--autostart", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(a, "--silent", StringComparison.OrdinalIgnoreCase));
                Application.Run(new QuickMemoAppContext(appRoot, isAutoStart));
            }
        }
    }
}
