use std::collections::HashMap;
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    LogicalSize, Manager, Size, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

#[derive(serde::Serialize)]
struct ScreenCaptureResult {
    name: String,
    mime: String,
    size: usize,
    data_url: String,
    note: String,
}

struct RecordingSession {
    child: Child,
    path: std::path::PathBuf,
    audio_child: Option<Child>,
    audio_path: Option<std::path::PathBuf>,
    audio_stop_path: Option<std::path::PathBuf>,
    audio_script_path: Option<std::path::PathBuf>,
    started_at: std::time::Instant,
    audio_status: String,
    last_error: String,
    capture_area: String,
}

static RECORDING_SESSIONS: OnceLock<Mutex<HashMap<String, RecordingSession>>> = OnceLock::new();

#[derive(Clone)]
struct WindowRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    source: String,
    process: String,
    title: String,
}

#[derive(Clone, Copy)]
struct DesktopBounds {
    left: i32,
    top: i32,
    width: i32,
    height: i32,
}

const MAIN_WINDOW_WIDTH: f64 = 240.0;
const MAIN_WINDOW_HEIGHT: f64 = 300.0;
const MAIN_WINDOW_MIN_WIDTH: f64 = 180.0;
const MAIN_WINDOW_MIN_HEIGHT: f64 = 220.0;

const SETTINGS_WINDOW_WIDTH: f64 = 680.0;
const SETTINGS_WINDOW_HEIGHT: f64 = 720.0;

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => show_main_window(app),
        }
    }
}

fn configure_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_size(Size::Logical(LogicalSize::new(
            MAIN_WINDOW_WIDTH,
            MAIN_WINDOW_HEIGHT,
        )));
        let _ = window.set_min_size(Some(Size::Logical(LogicalSize::new(
            MAIN_WINDOW_MIN_WIDTH,
            MAIN_WINDOW_MIN_HEIGHT,
        ))));
        let _ = window.set_resizable(false);
        let _ = window.set_always_on_top(true);
    }
}

fn show_settings_window_internal(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    let settings_window =
        WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
            .title("DeskMate 设置")
            .inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)
            .resizable(false)
            .always_on_top(true)
            .visible(true)
            .build()?;

    let win = settings_window.clone();
    settings_window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = win.hide();
        }
    });

    Ok(())
}

#[tauri::command]
fn show_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    show_settings_window_internal(&app).map_err(|err| err.to_string())
}

fn active_window_rect() -> Option<WindowRect> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinApi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
"@
[void][WinApi]::SetProcessDPIAware()

function Read-WindowInfo([IntPtr]$handle, [string]$source) {
  if ($handle -eq [IntPtr]::Zero -or -not [WinApi]::IsWindowVisible($handle)) { return $null }
  $r = New-Object RECT
  if (-not [WinApi]::GetWindowRect($handle, [ref]$r)) { return $null }
  $w = [Math]::Max(1, $r.Right - $r.Left)
  $h = [Math]::Max(1, $r.Bottom - $r.Top)
  if ($w -lt 400 -or $h -lt 300) { return $null }
  [uint32]$processId = 0
  [void][WinApi]::GetWindowThreadProcessId($handle, [ref]$processId)
  $process = ""
  try { $process = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch {}
  $titleBuilder = New-Object System.Text.StringBuilder 512
  [void][WinApi]::GetWindowText($handle, $titleBuilder, $titleBuilder.Capacity)
  $title = $titleBuilder.ToString()
  [pscustomobject]@{
    x = $r.Left
    y = $r.Top
    width = $w
    height = $h
    source = $source
    process = $process
    title = $title
    area = ($w * $h)
  }
}

$preferredProcessNames = @(
  "msedge", "chrome", "firefox", "brave", "opera", "vivaldi", "qqbrowser", "360chrome", "360se",
  "douyin", "抖音", "xiaohongshu", "rednote", "bilibili", "哔哩哔哩", "kuaishou", "快手"
)
$preferredTitlePattern = "抖音|小红书|哔哩|B站|快手|Douyin|TikTok|Xiaohongshu|RedNote|Bilibili|Kuaishou"
$excludedProcessNames = @(
  "deskmate", "wry", "tauri", "powershell", "pwsh", "cmd", "windowsterminal", "conhost",
  "shellexperiencehost", "searchhost", "startmenuexperiencehost", "applicationframehost"
)

function Is-ExcludedWindow($item) {
  if (-not $item) { return $true }
  $process = ""
  if ($item.process) { $process = $item.process.ToLowerInvariant() }
  if ($excludedProcessNames -contains $process) { return $true }
  if ($item.title -match "DeskMate|KOC Agent") { return $true }
  return $false
}

function Is-PreferredWindow($item) {
  if (Is-ExcludedWindow $item) { return $false }
  $process = ""
  if ($item.process) { $process = $item.process.ToLowerInvariant() }
  if ($preferredProcessNames -contains $process) { return $true }
  if ($item.title -match $preferredTitlePattern) { return $true }
  return $false
}

function Is-LargeWindow($item) {
  return ($item -and $item.width -ge 900 -and $item.height -ge 550)
}

function Clamp-ToVirtualScreen($item) {
  if (-not $item) { return $null }
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $left = [Math]::Max($item.x, $screen.Left)
  $top = [Math]::Max($item.y, $screen.Top)
  $right = [Math]::Min($item.x + $item.width, $screen.Left + $screen.Width)
  $bottom = [Math]::Min($item.y + $item.height, $screen.Top + $screen.Height)
  $item.x = $left
  $item.y = $top
  $item.width = [Math]::Max(1, $right - $left)
  $item.height = [Math]::Max(1, $bottom - $top)
  return $item
}

$foreground = Read-WindowInfo ([WinApi]::GetForegroundWindow()) "foreground_window"
if ((Is-LargeWindow $foreground) -and -not (Is-ExcludedWindow $foreground)) {
  $selected = $foreground
} else {
  $windows = New-Object System.Collections.Generic.List[object]
  $callback = [WinApi+EnumWindowsProc]{
    param([IntPtr]$handle, [IntPtr]$lparam)
    $item = Read-WindowInfo $handle "candidate_window"
    if ($item -and -not (Is-ExcludedWindow $item) -and (Is-LargeWindow $item)) {
      $windows.Add($item)
    }
    return $true
  }
  [void][WinApi]::EnumWindows($callback, [IntPtr]::Zero)
  $selected = $windows | Where-Object { Is-PreferredWindow $_ } | Sort-Object area -Descending | Select-Object -First 1
  if (-not $selected) {
    $selected = $windows | Sort-Object area -Descending | Select-Object -First 1
    if ($selected) { $selected.source = "largest_content_window" }
  } elseif ($selected) {
    $selected.source = "preferred_platform_window"
  }
}

if ($selected) {
  $selected = Clamp-ToVirtualScreen $selected
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  "{0}|{1}|{2}|{3}|{4}|{5}|{6}" -f $selected.x,$selected.y,$selected.width,$selected.height,$selected.source,$selected.process,($selected.title -replace "[\r\n|]", " ")
}
"#;
        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let raw = String::from_utf8_lossy(&output.stdout);
        let mut pieces = raw.trim().splitn(7, '|');
        let rect = WindowRect {
            x: pieces.next()?.trim().parse::<i32>().ok()?,
            y: pieces.next()?.trim().parse::<i32>().ok()?,
            width: pieces.next()?.trim().parse::<i32>().ok()?,
            height: pieces.next()?.trim().parse::<i32>().ok()?,
            source: pieces.next().unwrap_or("").trim().to_string(),
            process: pieces.next().unwrap_or("").trim().to_string(),
            title: pieces.next().unwrap_or("").trim().to_string(),
        };
        if rect.width < 400 || rect.height < 300 {
            return None;
        }
        Some(rect)
    }

    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[cfg(target_os = "windows")]
fn read_windows_virtual_screen_bounds(dpi_aware: bool) -> Option<DesktopBounds> {
    let dpi_line = if dpi_aware {
        r#"
Add-Type @"
using System.Runtime.InteropServices;
public class DpiApi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][DpiApi]::SetProcessDPIAware()
"#
    } else {
        ""
    };
    let script = format!(
        r#"
Add-Type -AssemblyName System.Windows.Forms
{dpi_line}
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
"{{0}}|{{1}}|{{2}}|{{3}}" -f $screen.Left,$screen.Top,$screen.Width,$screen.Height
"#
    );
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let mut pieces = raw.trim().split('|');
    Some(DesktopBounds {
        left: pieces.next()?.trim().parse::<i32>().ok()?,
        top: pieces.next()?.trim().parse::<i32>().ok()?,
        width: pieces.next()?.trim().parse::<i32>().ok()?,
        height: pieces.next()?.trim().parse::<i32>().ok()?,
    })
}

#[cfg(target_os = "windows")]
fn clamp_rect_for_copy_from_screen(rect: &WindowRect) -> Option<WindowRect> {
    let bounds = read_windows_virtual_screen_bounds(true)?;
    let left = rect.x.max(bounds.left);
    let top = rect.y.max(bounds.top);
    let right = (rect.x + rect.width).min(bounds.left + bounds.width);
    let bottom = (rect.y + rect.height).min(bounds.top + bounds.height);
    let width = right - left;
    let height = bottom - top;
    if width < 320 || height < 240 {
        return None;
    }
    Some(WindowRect {
        x: left,
        y: top,
        width,
        height,
        source: format!("{};copy_from_screen_dpi_aware", rect.source),
        process: rect.process.clone(),
        title: rect.title.clone(),
    })
}

#[cfg(target_os = "windows")]
fn valid_copy_from_screen_rect(rect: &WindowRect) -> Option<WindowRect> {
    if rect.width < 320 || rect.height < 240 {
        return None;
    }
    Some(WindowRect {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        source: format!("{};copy_from_screen_raw", rect.source),
        process: rect.process.clone(),
        title: rect.title.clone(),
    })
}

#[tauri::command]
fn capture_primary_screen() -> Result<ScreenCaptureResult, String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;

        let raw_rect = active_window_rect();
        let rect = raw_rect
            .as_ref()
            .and_then(clamp_rect_for_copy_from_screen)
            .or_else(|| raw_rect.as_ref().and_then(valid_copy_from_screen_rect));
        let rect_script = rect
            .as_ref()
            .map(|r| {
                format!(
                    "$bounds = New-Object System.Drawing.Rectangle {}, {}, {}, {}",
                    r.x, r.y, r.width, r.height
                )
            })
            .unwrap_or_else(|| {
                "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen".to_string()
            });
        let note = rect
            .as_ref()
            .map(|r| {
                format!(
                    "用户授权截图：已截取当前前台内容窗口区域 {}x{} @ {},{}；来源：{} / {} / {}。截图使用 DPI-aware CopyFromScreen 坐标，录屏使用 gdigrab 坐标，二者不混用。",
                    r.width, r.height, r.x, r.y, r.source, r.process, r.title
                )
            })
            .unwrap_or_else(|| {
                "用户授权截图：未能稳定定位前台内容窗口，已截取 Windows 虚拟桌面范围，避免只截主屏局部。".to_string()
            });

        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System.Runtime.InteropServices;
public class DpiApi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][DpiApi]::SetProcessDPIAware()
__BOUNDS__
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
$bytes = $stream.ToArray()
$graphics.Dispose()
$bitmap.Dispose()
$stream.Dispose()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Convert]::ToBase64String($bytes)
"#
        .replace("__BOUNDS__", &rect_script);

        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .output()
            .map_err(|err| format!("启动截图命令失败：{err}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "截图命令执行失败，未返回错误详情。".to_string()
            } else {
                format!("截图命令执行失败：{stderr}")
            });
        }

        let base64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if base64.is_empty() {
            return Err("截图结果为空，请确认当前系统允许桌面截图。".to_string());
        }

        let size = (base64.len() * 3) / 4;
        return Ok(ScreenCaptureResult {
            name: format!("screen-{}.png", chrono_like_timestamp()),
            mime: "image/png".to_string(),
            size,
            data_url: format!("data:image/png;base64,{base64}"),
            note,
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("当前版本的自动截图命令先支持 Windows，其他系统请继续使用“上传素材”。".to_string())
    }
}

fn recording_sessions() -> &'static Mutex<HashMap<String, RecordingSession>> {
    RECORDING_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[allow(dead_code)]
fn audio_candidates() -> Vec<String> {
    let mut candidates = std::env::var("DESKMATE_AUDIO_DEVICE")
        .ok()
        .filter(|item| !item.trim().is_empty())
        .map(|item| vec![item])
        .unwrap_or_else(|| {
            vec![
                "virtual-audio-capturer".to_string(),
                "CABLE Output (VB-Audio Virtual Cable)".to_string(),
                "麦克风 (ToDesk Virtual Audio)".to_string(),
                "Stereo Mix (Realtek(R) Audio)".to_string(),
                "立体声混音 (Realtek(R) Audio)".to_string(),
                "Stereo Mix".to_string(),
                "立体声混音".to_string(),
            ]
        });

    candidates.extend(list_dshow_audio_devices());
    let mut unique = Vec::new();
    for item in candidates {
        let name = item.trim();
        if !name.is_empty() && !unique.iter().any(|existing: &String| existing == name) {
            unique.push(name.to_string());
        }
    }
    unique.sort_by_key(|name| audio_device_rank(name));
    unique
}

#[allow(dead_code)]
fn audio_device_rank(name: &str) -> i32 {
    let lower = name.to_lowercase();
    if lower.contains("virtual")
        || lower.contains("cable")
        || lower.contains("stereo mix")
        || name.contains("立体声混音")
        || lower.contains("todesk")
    {
        0
    } else if lower.contains("microphone") || name.contains("麦克风") {
        1
    } else {
        2
    }
}

#[allow(dead_code)]
fn list_dshow_audio_devices() -> Vec<String> {
    let output = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
        ])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    text.lines()
        .filter_map(|line| {
            if !line.contains("(audio)") {
                return None;
            }
            let start = line.find('"')?;
            let rest = &line[start + 1..];
            let end = rest.find('"')?;
            Some(rest[..end].to_string())
        })
        .collect()
}

fn encode_file_to_base64(path: &std::path::Path) -> Result<String, String> {
    let script = format!(
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Convert]::ToBase64String([System.IO.File]::ReadAllBytes('{}'))",
        path.to_string_lossy().replace('\'', "''")
    );
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .output()
        .map_err(|err| format!("编码录屏文件失败：{err}"))?;
    if !output.status.success() {
        return Err(format!(
            "编码录屏文件失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let base64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if base64.is_empty() {
        return Err("编码录屏文件结果为空。".to_string());
    }
    Ok(base64)
}

fn read_child_stderr(child: &mut Child) -> String {
    let mut stderr = String::new();
    if let Some(mut stream) = child.stderr.take() {
        use std::io::Read;
        let _ = stream.read_to_string(&mut stderr);
    }
    stderr.chars().take(1200).collect()
}

fn wasapi_loopback_script() -> &'static str {
    r#"
Add-Type @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
public enum AudioClientShareMode { Shared = 0, Exclusive = 1 }
[Flags]
public enum AudioClientStreamFlags {
    None = 0,
    Loopback = 0x00020000
}
[Flags]
public enum AudioClientBufferFlags {
    None = 0,
    DataDiscontinuity = 0x1,
    Silent = 0x2,
    TimestampError = 0x4
}

[StructLayout(LayoutKind.Sequential, Pack = 2)]
public struct WaveFormatEx {
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject {}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(EDataFlow dataFlow, int dwStateMask, out object ppDevices);
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
    int GetDevice(string pwstrId, out IMMDevice ppDevice);
    int RegisterEndpointNotificationCallback(IntPtr pClient);
    int UnregisterEndpointNotificationCallback(IntPtr pClient);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
public interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out object ppProperties);
    int GetId(out IntPtr ppstrId);
    int GetState(out int pdwState);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2")]
public interface IAudioClient {
    int Initialize(AudioClientShareMode shareMode, AudioClientStreamFlags streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
    int GetBufferSize(out uint pNumBufferFrames);
    int GetStreamLatency(out long phnsLatency);
    int GetCurrentPadding(out uint pNumPaddingFrames);
    int IsFormatSupported(AudioClientShareMode shareMode, IntPtr pFormat, out IntPtr ppClosestMatch);
    int GetMixFormat(out IntPtr ppDeviceFormat);
    int GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr eventHandle);
    int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317")]
public interface IAudioCaptureClient {
    int GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out AudioClientBufferFlags pdwFlags, out long pu64DevicePosition, out long pu64QPCPosition);
    int ReleaseBuffer(uint NumFramesRead);
    int GetNextPacketSize(out uint pNumFramesInNextPacket);
}

public class LoopbackRecorder {
    const int CLSCTX_ALL = 23;
    static void Check(int hr, string name) {
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    }
    public static void Record(string wavPath, string stopPath) {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice device;
        Check(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eConsole, out device), "GetDefaultAudioEndpoint");
        Guid audioClientGuid = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        object audioClientObject;
        Check(device.Activate(ref audioClientGuid, CLSCTX_ALL, IntPtr.Zero, out audioClientObject), "Activate");
        IAudioClient audioClient = (IAudioClient)audioClientObject;
        IntPtr waveFormatPtr;
        Check(audioClient.GetMixFormat(out waveFormatPtr), "GetMixFormat");
        WaveFormatEx format = (WaveFormatEx)Marshal.PtrToStructure(waveFormatPtr, typeof(WaveFormatEx));
        Check(audioClient.Initialize(AudioClientShareMode.Shared, AudioClientStreamFlags.Loopback, 10000000, 0, waveFormatPtr, IntPtr.Zero), "Initialize");
        Guid captureGuid = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        object captureObject;
        Check(audioClient.GetService(ref captureGuid, out captureObject), "GetService");
        IAudioCaptureClient capture = (IAudioCaptureClient)captureObject;
        using (FileStream fs = new FileStream(wavPath, FileMode.Create, FileAccess.ReadWrite, FileShare.Read)) {
            WriteHeader(fs, format, 0);
            long dataBytes = 0;
            Check(audioClient.Start(), "Start");
            try {
                while (!File.Exists(stopPath)) {
                    uint packetFrames;
                    Check(capture.GetNextPacketSize(out packetFrames), "GetNextPacketSize");
                    if (packetFrames == 0) {
                        Thread.Sleep(10);
                        continue;
                    }
                    while (packetFrames > 0) {
                        IntPtr data;
                        uint frames;
                        AudioClientBufferFlags flags;
                        long devicePosition;
                        long qpcPosition;
                        Check(capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition), "GetBuffer");
                        int bytes = checked((int)(frames * format.nBlockAlign));
                        byte[] buffer = new byte[bytes];
                        if ((flags & AudioClientBufferFlags.Silent) == 0 && data != IntPtr.Zero) {
                            Marshal.Copy(data, buffer, 0, bytes);
                        }
                        fs.Write(buffer, 0, buffer.Length);
                        dataBytes += buffer.Length;
                        Check(capture.ReleaseBuffer(frames), "ReleaseBuffer");
                        Check(capture.GetNextPacketSize(out packetFrames), "GetNextPacketSize");
                    }
                }
            } finally {
                audioClient.Stop();
                fs.Seek(0, SeekOrigin.Begin);
                WriteHeader(fs, format, dataBytes);
            }
        }
        Marshal.FreeCoTaskMem(waveFormatPtr);
    }
    static void WriteHeader(Stream stream, WaveFormatEx format, long dataBytes) {
        BinaryWriter writer = new BinaryWriter(stream);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
        writer.Write((uint)(36 + dataBytes));
        writer.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));
        writer.Write(System.Text.Encoding.ASCII.GetBytes("fmt "));
        writer.Write((uint)16);
        ushort tag = format.wFormatTag == 0xFFFE ? (ushort)3 : format.wFormatTag;
        writer.Write(tag);
        writer.Write(format.nChannels);
        writer.Write(format.nSamplesPerSec);
        writer.Write(format.nAvgBytesPerSec);
        writer.Write(format.nBlockAlign);
        writer.Write(format.wBitsPerSample);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("data"));
        writer.Write((uint)dataBytes);
    }
}
"@
[LoopbackRecorder]::Record($args[0], $args[1])
"#
}

fn spawn_wasapi_loopback_recorder(
    session_id: &str,
) -> Result<
    (
        Child,
        std::path::PathBuf,
        std::path::PathBuf,
        std::path::PathBuf,
    ),
    String,
> {
    use std::fs;

    let temp_dir = std::env::temp_dir();
    let audio_path = temp_dir.join(format!("{session_id}-system-audio.wav"));
    let stop_path = temp_dir.join(format!("{session_id}-system-audio.stop"));
    let script_path = temp_dir.join(format!("{session_id}-wasapi-loopback.ps1"));
    let _ = fs::remove_file(&audio_path);
    let _ = fs::remove_file(&stop_path);
    fs::write(&script_path, wasapi_loopback_script())
        .map_err(|err| format!("写入 WASAPI 录音脚本失败：{err}"))?;

    let child = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path.to_string_lossy(),
            &audio_path.to_string_lossy(),
            &stop_path.to_string_lossy(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("启动 WASAPI 系统音频录制失败：{err}"))?;
    Ok((child, audio_path, stop_path, script_path))
}

fn spawn_recording_process(
    output_string: &str,
    audio_device: Option<&str>,
    rect: Option<&WindowRect>,
) -> Result<(Child, String, String), String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-f".to_string(),
        "gdigrab".to_string(),
        "-framerate".to_string(),
        "15".to_string(),
    ];
    if let Some(r) = rect {
        args.extend([
            "-offset_x".to_string(),
            r.x.to_string(),
            "-offset_y".to_string(),
            r.y.to_string(),
            "-video_size".to_string(),
            format!("{}x{}", r.width, r.height),
        ]);
    }
    args.extend(["-i".to_string(), "desktop".to_string()]);
    if let Some(device) = audio_device {
        args.extend([
            "-f".to_string(),
            "dshow".to_string(),
            "-i".to_string(),
            format!("audio={device}"),
            "-map".to_string(),
            "0:v:0".to_string(),
            "-map".to_string(),
            "1:a:0".to_string(),
        ]);
    }
    args.extend([
        "-vf".to_string(),
        "scale=960:-2".to_string(),
        "-c:v".to_string(),
        "libx264".to_string(),
        "-preset".to_string(),
        "ultrafast".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
    ]);
    if audio_device.is_some() {
        args.extend([
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "128k".to_string(),
            "-shortest".to_string(),
        ]);
    }
    args.push(output_string.to_string());

    let child = Command::new("ffmpeg")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("启动录屏命令失败：{err}"))?;
    let audio_status = audio_device
        .map(|device| format!("audio_captured:{device}"))
        .unwrap_or_else(|| "audio_unavailable".to_string());
    Ok((child, audio_status, String::new()))
}

fn mux_video_with_audio(
    video_path: &std::path::Path,
    audio_path: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let muxed_path = std::env::temp_dir().join(format!("{}-muxed.mp4", chrono_like_timestamp()));
    let output = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            &video_path.to_string_lossy(),
            "-i",
            &audio_path.to_string_lossy(),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-shortest",
            &muxed_path.to_string_lossy(),
        ])
        .output()
        .map_err(|err| format!("合成系统音频失败：{err}"))?;
    if !output.status.success() {
        return Err(format!(
            "合成系统音频失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(muxed_path)
}

#[tauri::command]
fn start_current_video_recording() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use std::{fs, thread, time::Duration};

        let session_id = format!("rec-{}", chrono_like_timestamp());
        let output_path = std::env::temp_dir().join(format!("{session_id}.mp4"));
        let output_string = output_path.to_string_lossy().to_string();
        let mut last_error = String::new();
        let rect = active_window_rect();
        let capture_area = rect
            .as_ref()
            .map(|r| {
                format!(
                    "当前平台/前台内容窗口区域 {}x{} @ {},{}；来源：{} / {} / {}",
                    r.width, r.height, r.x, r.y, r.source, r.process, r.title
                )
            })
            .unwrap_or_else(|| "全屏桌面区域（未能识别合适的平台/内容窗口）".to_string());

        let (mut child, audio_status, _) =
            spawn_recording_process(&output_string, None, rect.as_ref())?;
        thread::sleep(Duration::from_millis(700));
        match child.try_wait() {
            Ok(None) => {}
            Ok(Some(_)) => {
                let stderr = read_child_stderr(&mut child);
                let _ = fs::remove_file(&output_path);
                return Err(format!(
                    "启动无音频录屏失败：{}{}",
                    stderr,
                    if last_error.is_empty() {
                        String::new()
                    } else {
                        format!("；此前音频录制失败：{last_error}")
                    }
                ));
            }
            Err(err) => {
                let _ = fs::remove_file(&output_path);
                return Err(format!(
                    "检查无音频录屏进程失败：{err}{}",
                    if last_error.is_empty() {
                        String::new()
                    } else {
                        format!("；此前音频录制失败：{last_error}")
                    }
                ));
            }
        }
        let mut audio_child = None;
        let mut audio_path = None;
        let mut audio_stop_path = None;
        let mut audio_script_path = None;
        let mut audio_status = audio_status;
        match spawn_wasapi_loopback_recorder(&session_id) {
            Ok((mut recorder, wav_path, stop_path, script_path)) => {
                thread::sleep(Duration::from_millis(500));
                match recorder.try_wait() {
                    Ok(None) => {
                        audio_status = "system_audio_captured:wasapi_loopback".to_string();
                        audio_child = Some(recorder);
                        audio_path = Some(wav_path);
                        audio_stop_path = Some(stop_path);
                        audio_script_path = Some(script_path);
                    }
                    Ok(Some(_)) => {
                        let stderr = read_child_stderr(&mut recorder);
                        last_error = if last_error.is_empty() {
                            format!("WASAPI 系统音频录制启动后退出：{stderr}")
                        } else {
                            format!("{last_error}；WASAPI 系统音频录制启动后退出：{stderr}")
                        };
                    }
                    Err(err) => {
                        last_error = if last_error.is_empty() {
                            format!("检查 WASAPI 系统音频录制失败：{err}")
                        } else {
                            format!("{last_error}；检查 WASAPI 系统音频录制失败：{err}")
                        };
                    }
                }
            }
            Err(err) => {
                last_error = if last_error.is_empty() {
                    err
                } else {
                    format!("{last_error}；{err}")
                };
            }
        }
        recording_sessions()
            .lock()
            .map_err(|_| "录屏会话锁定失败。".to_string())?
            .insert(
                session_id.clone(),
                RecordingSession {
                    child,
                    path: output_path,
                    audio_child,
                    audio_path,
                    audio_stop_path,
                    audio_script_path,
                    started_at: std::time::Instant::now(),
                    audio_status,
                    last_error,
                    capture_area,
                },
            );
        Ok(session_id)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(
            "当前版本的手动录屏先支持 Windows；其他系统请使用“上传素材”手动选择视频文件。"
                .to_string(),
        )
    }
}

#[tauri::command]
fn stop_current_video_recording(session_id: String) -> Result<ScreenCaptureResult, String> {
    #[cfg(target_os = "windows")]
    {
        use std::{fs, thread, time::Duration};

        let mut session = recording_sessions()
            .lock()
            .map_err(|_| "录屏会话锁定失败。".to_string())?
            .remove(&session_id)
            .ok_or_else(|| "没有找到正在录制的视频会话。".to_string())?;

        if let Some(stdin) = session.child.stdin.as_mut() {
            let _ = stdin.write_all(b"q\n");
        }
        let status = session.child.wait().ok();
        let stderr = read_child_stderr(&mut session.child);
        if !stderr.trim().is_empty() {
            if session.last_error.trim().is_empty() {
                session.last_error = stderr;
            } else {
                session.last_error = format!("{}；停止录制输出：{}", session.last_error, stderr);
            }
        }
        if let Some(stop_path) = session.audio_stop_path.as_ref() {
            let _ = fs::write(stop_path, b"stop");
        }
        if let Some(audio_child) = session.audio_child.as_mut() {
            for _ in 0..60 {
                match audio_child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            if let Ok(None) = audio_child.try_wait() {
                let _ = audio_child.kill();
                let _ = audio_child.wait();
            }
            let audio_stderr = read_child_stderr(audio_child);
            if !audio_stderr.trim().is_empty() {
                session.last_error = if session.last_error.trim().is_empty() {
                    audio_stderr
                } else {
                    format!("{}；系统音频录制输出：{}", session.last_error, audio_stderr)
                };
            }
        }
        let duration = session.started_at.elapsed().as_secs().max(1);
        if !session.path.exists() {
            return Err(format!(
                "录屏进程结束但没有生成视频文件。退出状态：{}；采集区域：{}；音频状态：{}；ffmpeg 输出：{}",
                status
                    .map(|item| item.to_string())
                    .unwrap_or_else(|| "未知".to_string()),
                session.capture_area,
                session.audio_status,
                if session.last_error.trim().is_empty() {
                    "无详细输出".to_string()
                } else {
                    session.last_error.clone()
                }
            ));
        }
        let video_bytes =
            fs::read(&session.path).map_err(|err| format!("读取录屏文件失败：{err}"))?;
        if video_bytes.len() < 1024 {
            let _ = fs::remove_file(&session.path);
            return Err(format!(
                "录屏文件过小，无法分析。采集区域：{}；音频状态：{}；ffmpeg 输出：{}",
                session.capture_area,
                session.audio_status,
                if session.last_error.trim().is_empty() {
                    "无详细输出".to_string()
                } else {
                    session.last_error.clone()
                }
            ));
        }
        let mut final_path = session.path.clone();
        if let Some(audio_path) = session.audio_path.as_ref() {
            if audio_path.exists()
                && audio_path
                    .metadata()
                    .map(|item| item.len() > 44)
                    .unwrap_or(false)
            {
                match mux_video_with_audio(&session.path, audio_path) {
                    Ok(path) => {
                        final_path = path;
                    }
                    Err(err) => {
                        session.last_error = if session.last_error.trim().is_empty() {
                            err
                        } else {
                            format!("{}；{}", session.last_error, err)
                        };
                    }
                }
            } else if session.audio_status.contains("wasapi_loopback") {
                session.last_error = if session.last_error.trim().is_empty() {
                    "WASAPI 系统音频文件为空，已保留无音频视频。".to_string()
                } else {
                    format!(
                        "{}；WASAPI 系统音频文件为空，已保留无音频视频。",
                        session.last_error
                    )
                };
            }
        }
        let bytes = fs::read(&final_path).map_err(|err| format!("读取录屏文件失败：{err}"))?;
        let base64 = encode_file_to_base64(&final_path)?;
        if final_path != session.path {
            let _ = fs::remove_file(&final_path);
        }
        let _ = fs::remove_file(&session.path);
        if let Some(path) = session.audio_path.as_ref() {
            let _ = fs::remove_file(path);
        }
        if let Some(path) = session.audio_stop_path.as_ref() {
            let _ = fs::remove_file(path);
        }
        if let Some(path) = session.audio_script_path.as_ref() {
            let _ = fs::remove_file(path);
        }
        Ok(ScreenCaptureResult {
            name: format!("current-video-recording-{}.mp4", chrono_like_timestamp()),
            mime: "video/mp4".to_string(),
            size: bytes.len(),
            data_url: format!("data:video/mp4;base64,{base64}"),
            note: format!("用户手动控制范围录制的当前视频窗口片段，采集区域：{}；时长约 {duration} 秒。音频采集状态：{}。{}", session.capture_area, session.audio_status, session.last_error),
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = session_id;
        Err(
            "当前版本的手动录屏先支持 Windows；其他系统请使用“上传素材”手动选择视频文件。"
                .to_string(),
        )
    }
}

#[tauri::command]
fn record_primary_screen(seconds: Option<u64>) -> Result<ScreenCaptureResult, String> {
    #[cfg(target_os = "windows")]
    {
        use std::{fs, process::Command};

        let duration = seconds.unwrap_or(15).clamp(5, 30);
        let output_path = std::env::temp_dir().join(format!(
            "deskmate-current-video-{}.mp4",
            chrono_like_timestamp()
        ));
        let output_string = output_path.to_string_lossy().to_string();
        let duration_string = duration.to_string();
        let audio_candidates = std::env::var("DESKMATE_AUDIO_DEVICE")
            .ok()
            .filter(|item| !item.trim().is_empty())
            .map(|item| vec![item])
            .unwrap_or_else(|| {
                vec![
                    "virtual-audio-capturer".to_string(),
                    "Stereo Mix (Realtek(R) Audio)".to_string(),
                    "立体声混音 (Realtek(R) Audio)".to_string(),
                    "Stereo Mix".to_string(),
                    "立体声混音".to_string(),
                ]
            });
        let mut audio_status = "audio_unavailable".to_string();
        let mut last_error = String::new();

        for audio_device in &audio_candidates {
            let audio_input = format!("audio={audio_device}");
            let output = Command::new("ffmpeg")
                .args([
                    "-y",
                    "-f",
                    "gdigrab",
                    "-framerate",
                    "15",
                    "-i",
                    "desktop",
                    "-f",
                    "dshow",
                    "-i",
                    &audio_input,
                    "-t",
                    &duration_string,
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                    "-vf",
                    "scale=960:-2",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    "-shortest",
                    &output_string,
                ])
                .output()
                .map_err(|err| format!("启动录屏命令失败：{err}"))?;

            if output.status.success() {
                audio_status = format!("audio_captured:{audio_device}");
                break;
            }

            last_error = String::from_utf8_lossy(&output.stderr)
                .trim()
                .to_string()
                .chars()
                .take(500)
                .collect();
            let _ = fs::remove_file(&output_path);
        }

        if !output_path.exists() {
            let output = Command::new("ffmpeg")
                .args([
                    "-y",
                    "-f",
                    "gdigrab",
                    "-framerate",
                    "15",
                    "-t",
                    &duration_string,
                    "-i",
                    "desktop",
                    "-vf",
                    "scale=960:-2",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-pix_fmt",
                    "yuv420p",
                    &output_string,
                ])
                .output()
                .map_err(|err| format!("启动录屏命令失败：{err}"))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let _ = fs::remove_file(&output_path);
                return Err(if stderr.is_empty() {
                    "录屏命令执行失败，未返回错误详情。请确认已安装 ffmpeg 并允许屏幕录制。"
                        .to_string()
                } else {
                    format!("录屏命令执行失败：{stderr}")
                });
            }
        }

        let bytes = fs::read(&output_path).map_err(|err| format!("读取录屏文件失败：{err}"))?;
        let _ = fs::remove_file(&output_path);
        if bytes.is_empty() {
            return Err("录屏结果为空，请确认当前屏幕可被采集。".to_string());
        }

        let temp_base64 = std::env::temp_dir().join(format!(
            "deskmate-current-video-{}.b64",
            chrono_like_timestamp()
        ));
        let raw_path = std::env::temp_dir().join(format!(
            "deskmate-current-video-{}.raw.mp4",
            chrono_like_timestamp()
        ));
        let temp_base64_string = temp_base64.to_string_lossy().to_string();
        let raw_path_string = raw_path.to_string_lossy().to_string();
        fs::write(&raw_path, &bytes).map_err(|err| format!("写入临时录屏文件失败：{err}"))?;
        let cert_output = Command::new("certutil")
            .args(["-encode", &raw_path_string, &temp_base64_string])
            .output()
            .map_err(|err| format!("编码录屏文件失败：{err}"))?;
        let _ = fs::remove_file(&raw_path);
        if !cert_output.status.success() {
            let _ = fs::remove_file(&temp_base64);
            return Err("编码录屏文件失败。".to_string());
        }
        let base64 = fs::read_to_string(&temp_base64)
            .map_err(|err| format!("读取编码录屏失败：{err}"))?
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>();
        let _ = fs::remove_file(&temp_base64);

        return Ok(ScreenCaptureResult {
            name: format!("current-video-recording-{}.mp4", chrono_like_timestamp()),
            mime: "video/mp4".to_string(),
            size: bytes.len(),
            data_url: format!("data:video/mp4;base64,{base64}"),
            note: format!("用户授权录制的当前屏幕视频片段，时长约 {duration} 秒，用于分析完整片段节奏、字幕和画面连续性。音频采集状态：{audio_status}。{last_error}"),
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(
            "当前版本的自动录屏命令先支持 Windows；其他系统请使用“上传素材”手动选择视频文件。"
                .to_string(),
        )
    }
}

fn chrono_like_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    seconds.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            show_settings_window,
            capture_primary_screen,
            start_current_video_recording,
            stop_current_video_recording,
            record_primary_screen
        ])
        .setup(|app| {
            configure_main_window(app.handle());

            let toggle_item =
                MenuItem::with_id(app, "toggle", "显示 / 隐藏桌宠", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "打开设置", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_item, &settings_item, &quit_item])?;

            // 托盘图标显式绑定到应用默认图标。
            // 默认图标来自 tauri.conf.json 的 bundle.icon，
            // 也就是你用 `npx tauri icon app-icon.png` 生成出来的那些图标文件。
            let tray_icon = app.default_window_icon().cloned();

            let mut tray_builder = TrayIconBuilder::new()
                .tooltip("DeskMate")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_main_window(app),
                    "settings" => {
                        let _ = show_settings_window_internal(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => {
                        toggle_main_window(tray.app_handle());
                    }
                    TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => {
                        show_main_window(tray.app_handle());
                    }
                    _ => {}
                });

            if let Some(icon) = tray_icon {
                tray_builder = tray_builder.icon(icon);
            }

            let _tray = tray_builder.build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let win = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running DeskMate");
}
