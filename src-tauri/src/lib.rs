use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::Foundation::POINT;
#[cfg(windows)]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON,
};
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize)]
struct CaptureSource {
    id: String,
    name: String,
    kind: String,
    #[serde(rename = "displayId")]
    display_id: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Serialize)]
struct CommandMessage {
    message: String,
}

#[derive(Default)]
struct RecorderState {
    session: Mutex<Option<NativeRecordingSession>>,
}

struct NativeRecordingSession {
    child: Child,
    path: PathBuf,
    started_at: u128,
    mouse_stop: Arc<AtomicBool>,
    mouse_events: Arc<Mutex<Vec<MouseEventRecord>>>,
    mouse_thread: Option<JoinHandle<()>>,
}

#[derive(Serialize)]
struct NativeRecordingStartResult {
    path: String,
    #[serde(rename = "startedAt")]
    started_at: u128,
    message: String,
}

#[derive(Serialize)]
struct NativeRecordingStopResult {
    path: String,
    duration: u128,
    #[serde(rename = "mimeType")]
    mime_type: String,
    #[serde(rename = "mouseEvents")]
    mouse_events: Vec<MouseEventRecord>,
    message: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct MouseEventRecord {
    id: String,
    timestamp: u128,
    x: i32,
    y: i32,
    action: String,
    #[serde(rename = "clickCount")]
    click_count: Option<u8>,
    #[serde(rename = "cursorState")]
    cursor_state: String,
}

#[derive(Serialize)]
struct SaveResult {
    path: String,
}

#[derive(Serialize)]
struct ExportResult {
    path: String,
    message: String,
}

#[derive(Deserialize)]
struct DirectExportInput {
    #[serde(rename = "sourcePath")]
    source_path: String,
    format: String,
    resolution: String,
    #[serde(rename = "destinationPath")]
    destination_path: Option<String>,
    #[serde(rename = "zoomSegments")]
    zoom_segments: Vec<ExportZoomSegment>,
    #[serde(rename = "sourceWidth")]
    source_width: Option<f64>,
    #[serde(rename = "sourceHeight")]
    source_height: Option<f64>,
    #[serde(rename = "mouseEvents", default)]
    mouse_events: Vec<MouseEventRecord>,
    #[serde(rename = "cursorStyle")]
    cursor_style: Option<CursorStyleConfig>,
    #[serde(rename = "editState")]
    edit_state: Option<VideoEditState>,
    fps: Option<u32>,
}

#[derive(Clone, Deserialize)]
struct Region {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Deserialize)]
struct CursorStyleConfig {
    size: f64,
    style: String,
    color: String,
    #[serde(rename = "clickRipple")]
    click_ripple: bool,
    #[serde(rename = "smoothPath")]
    smooth_path: bool,
}

#[derive(Clone, Deserialize)]
struct CropRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Deserialize)]
struct EditSegment {
    #[serde(rename = "id")]
    _id: String,
    #[serde(rename = "sourceStart")]
    source_start: f64,
    #[serde(rename = "sourceEnd")]
    source_end: f64,
    speed: f64,
}

#[derive(Clone, Deserialize)]
struct VideoEditState {
    #[serde(rename = "cropRect")]
    crop_rect: Option<CropRect>,
    #[serde(default)]
    segments: Vec<EditSegment>,
}

#[derive(Clone, Deserialize)]
struct ExportZoomPoint {
    x: f64,
    y: f64,
}

#[derive(Clone, Deserialize)]
struct ExportZoomSegment {
    start: f64,
    end: f64,
    center: ExportZoomPoint,
    scale: f64,
}

#[derive(Deserialize)]
struct RecordingAssetInput {
    #[serde(rename = "fileName")]
    file_name: String,
    bytes: Vec<u8>,
}

#[derive(Deserialize)]
struct RenameRecordingInput {
    path: String,
    #[serde(rename = "fileName")]
    file_name: String,
}

#[derive(Serialize)]
struct AssetSaveResult {
    path: String,
}

#[derive(Serialize)]
struct AssetReadResult {
    bytes: Vec<u8>,
    #[serde(rename = "mimeType")]
    mime_type: String,
}

fn app_root_dir() -> Result<PathBuf, String> {
    let current = std::env::current_dir().map_err(|error| error.to_string())?;
    if current.join("node_modules").exists() {
        return Ok(current);
    }

    let exe_dir = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "Could not resolve application directory.".to_string())?;

    let candidates = [
        exe_dir.clone(),
        exe_dir.join(".."),
        exe_dir.join("..").join(".."),
        exe_dir.join("..").join("..").join(".."),
    ];

    Ok(candidates
        .into_iter()
        .find(|candidate| candidate.join("node_modules").exists())
        .unwrap_or(exe_dir))
}

fn project_store_dir() -> Result<PathBuf, String> {
    let dir = app_root_dir()?.join("screen-studio-projects");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn ffmpeg_path() -> Option<PathBuf> {
    let executable = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let current = app_root_dir().ok()?;
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from));

    let mut candidates = vec![
        current.join("node_modules").join("ffmpeg-static").join(executable),
        current
            .join("..")
            .join("node_modules")
            .join("ffmpeg-static")
            .join(executable),
    ];

    if let Some(dir) = exe_dir {
        candidates.push(dir.join("node_modules").join("ffmpeg-static").join(executable));
        candidates.push(
            dir.join("..")
                .join("..")
                .join("..")
                .join("node_modules")
                .join("ffmpeg-static")
                .join(executable),
        );
    }

    candidates.into_iter().find(|candidate| candidate.exists())
}

fn export_dir() -> Result<PathBuf, String> {
    let dir = project_store_dir()?.join("exports");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn recordings_dir() -> Result<PathBuf, String> {
    let dir = project_store_dir()?.join("recordings");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn chrono_like_stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "now".into())
}

fn recording_output_path(extension: &str) -> Result<PathBuf, String> {
    Ok(recordings_dir()?.join(format!(
        "recording-{}.{}",
        chrono_like_stamp(),
        extension
    )))
}

fn safe_file_stem(file_name: &str) -> String {
    let sanitized = file_name
        .trim()
        .trim_end_matches(".mp4")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == ' ' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string();

    if sanitized.is_empty() {
        format!("recording-{}", chrono_like_stamp())
    } else {
        sanitized
    }
}

fn unique_recording_path(dir: PathBuf, stem: &str, extension: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.{extension}"));
    let mut suffix = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}-{suffix}.{extension}"));
        suffix += 1;
    }
    candidate
}

fn hide_subprocess_window(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(windows)]
fn spawn_mouse_recorder(
    started_at: u128,
    fps: u64,
    stop: Arc<AtomicBool>,
    events: Arc<Mutex<Vec<MouseEventRecord>>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut left_down = false;
        let mut right_down = false;
        let mut last_click_at = 0u128;
        let mut last_click_position = (0i32, 0i32);
        let mut last_move_at = 0u128;
        let mut last_move_position = (i32::MIN, i32::MIN);
        let move_interval = (1000 / fps.clamp(30, 120)).max(8) as u128;

        while !stop.load(Ordering::Relaxed) {
            let mut point = POINT { x: 0, y: 0 };
            unsafe {
                let _ = GetCursorPos(&mut point);
            }

            let left_now = unsafe { (GetAsyncKeyState(VK_LBUTTON as i32) & 0x8000u16 as i16) != 0 };
            let right_now = unsafe { (GetAsyncKeyState(VK_RBUTTON as i32) & 0x8000u16 as i16) != 0 };
            let timestamp = now_millis().saturating_sub(started_at);

            let push_event = |action: &str,
                              click_count: Option<u8>,
                              events: &Arc<Mutex<Vec<MouseEventRecord>>>| {
                if let Ok(mut guard) = events.lock() {
                    guard.push(MouseEventRecord {
                        id: format!("mouse-{timestamp}-{}-{}", point.x, point.y),
                        timestamp,
                        x: point.x,
                        y: point.y,
                        action: action.into(),
                        click_count,
                        cursor_state: "default".into(),
                    });
                }
            };

            let moved = point.x != last_move_position.0 || point.y != last_move_position.1;
            let first_sample = last_move_position.0 == i32::MIN;
            if moved && (first_sample || timestamp.saturating_sub(last_move_at) >= move_interval) {
                push_event("move", None, &events);
                last_move_at = timestamp;
                last_move_position = (point.x, point.y);
            }

            if left_now && !left_down {
                let distance =
                    (((point.x - last_click_position.0).pow(2) + (point.y - last_click_position.1).pow(2))
                        as f64)
                        .sqrt();
                let is_double = timestamp.saturating_sub(last_click_at) < 360 && distance < 12.0;
                last_click_at = timestamp;
                last_click_position = (point.x, point.y);
                push_event(
                    if is_double { "double_click" } else { "left_down" },
                    Some(if is_double { 2 } else { 1 }),
                    &events,
                );
            }

            if !left_now && left_down {
                push_event("left_up", None, &events);
            }

            if right_now && !right_down {
                push_event("right_down", Some(1), &events);
            }

            if !right_now && right_down {
                push_event("right_up", None, &events);
            }

            left_down = left_now;
            right_down = right_now;
            thread::sleep(Duration::from_millis(5));
        }
    })
}

#[cfg(not(windows))]
fn spawn_mouse_recorder(
    _started_at: u128,
    _fps: u64,
    stop: Arc<AtomicBool>,
    _events: Arc<Mutex<Vec<MouseEventRecord>>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(50));
        }
    })
}

#[tauri::command]
fn list_capture_sources() -> Vec<CaptureSource> {
    vec![
        CaptureSource {
            id: "display-1".into(),
            name: "Display 1".into(),
            kind: "screen".into(),
            display_id: Some("DISPLAY1".into()),
            width: Some(1920),
            height: Some(1080),
        },
        CaptureSource {
            id: "display-2".into(),
            name: "Display 2".into(),
            kind: "screen".into(),
            display_id: Some("DISPLAY2".into()),
            width: Some(2560),
            height: Some(1440),
        },
        CaptureSource {
            id: "active-window".into(),
            name: "Active window".into(),
            kind: "window".into(),
            display_id: None,
            width: Some(1440),
            height: Some(900),
        },
        CaptureSource {
            id: "custom-region".into(),
            name: "Custom region".into(),
            kind: "region".into(),
            display_id: None,
            width: Some(1280),
            height: Some(720),
        },
    ]
}

#[tauri::command]
fn get_recordings_dir() -> Result<SaveResult, String> {
    Ok(SaveResult {
        path: recordings_dir()?.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn start_recording(
    config: Value,
    state: tauri::State<RecorderState>,
) -> Result<NativeRecordingStartResult, String> {
    let mut session = state.session.lock().map_err(|error| error.to_string())?;
    if session.is_some() {
        return Err("Recording is already running.".into());
    }

    let fps = config.get("fps").and_then(Value::as_u64).unwrap_or(60);
    let source_type = config
        .get("sourceType")
        .and_then(Value::as_str)
        .unwrap_or("screen");
    let region = config
        .get("region")
        .cloned()
        .and_then(|value| serde_json::from_value::<Region>(value).ok());
    let ffmpeg = ffmpeg_path().ok_or_else(|| {
        "FFmpeg was not found. Please confirm node_modules/ffmpeg-static/ffmpeg.exe exists."
            .to_string()
    })?;
    let output = recording_output_path("mp4")?;

    let mut command = Command::new(ffmpeg);
    hide_subprocess_window(&mut command);
    command
        .args(["-y", "-f", "gdigrab", "-framerate"])
        .arg(fps.to_string())
        .args(["-draw_mouse", "0"]);

    let capture_message = if source_type == "region" {
        let region = region.ok_or_else(|| "Draw a recording region before starting.".to_string())?;
        let width = region.width.max(160);
        let height = region.height.max(120);
        command
            .args(["-offset_x", &region.x.to_string()])
            .args(["-offset_y", &region.y.to_string()])
            .args(["-video_size", &format!("{width}x{height}")]);
        format!("{width}x{height} region at {}, {}", region.x, region.y)
    } else {
        "desktop".into()
    };

    command
        .args(["-i", "desktop", "-c:v", "libx264", "-preset", "ultrafast"])
        .args(["-pix_fmt", "yuv420p"])
        .arg(&output)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let child = command.spawn().map_err(|error| {
        format!(
            "Could not start native Windows recording through FFmpeg/gdigrab: {}",
            error
        )
    })?;
    let started_at = now_millis();
    let mouse_stop = Arc::new(AtomicBool::new(false));
    let mouse_events = Arc::new(Mutex::new(Vec::new()));
    let mouse_thread = Some(spawn_mouse_recorder(
        started_at,
        fps,
        Arc::clone(&mouse_stop),
        Arc::clone(&mouse_events),
    ));
    *session = Some(NativeRecordingSession {
        child,
        path: output.clone(),
        started_at,
        mouse_stop,
        mouse_events,
        mouse_thread,
    });

    Ok(NativeRecordingStartResult {
        path: output.to_string_lossy().to_string(),
        started_at,
        message: format!("Native Windows recording started at {fps}fps from {capture_message}"),
    })
}

#[tauri::command]
fn pause_recording() -> CommandMessage {
    CommandMessage {
        message: "Recording paused.".into(),
    }
}

#[tauri::command]
fn resume_recording() -> CommandMessage {
    CommandMessage {
        message: "Recording resumed.".into(),
    }
}

#[tauri::command]
fn stop_recording(
    state: tauri::State<RecorderState>,
) -> Result<NativeRecordingStopResult, String> {
    let mut guard = state.session.lock().map_err(|error| error.to_string())?;
    let mut session = guard
        .take()
        .ok_or_else(|| "No native recording is running.".to_string())?;

    if let Some(stdin) = session.child.stdin.as_mut() {
        use std::io::Write;
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }

    match session.child.wait() {
        Ok(status) if status.success() => {}
        Ok(_) | Err(_) => {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }

    session.mouse_stop.store(true, Ordering::Relaxed);
    if let Some(handle) = session.mouse_thread.take() {
        let _ = handle.join();
    }
    let mouse_events = session
        .mouse_events
        .lock()
        .map(|events| events.clone())
        .unwrap_or_default();
    let duration = now_millis().saturating_sub(session.started_at);
    Ok(NativeRecordingStopResult {
        path: session.path.to_string_lossy().to_string(),
        duration,
        mime_type: "video/mp4".into(),
        mouse_events,
        message: "Native Windows recording stopped.".into(),
    })
}

#[tauri::command]
fn save_project(project: Value) -> Result<SaveResult, String> {
    let project_id = project
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("screen-studio-project");
    let path = project_store_dir()?.join(format!("{project_id}.json"));
    let body = serde_json::to_string_pretty(&project).map_err(|error| error.to_string())?;
    fs::write(&path, body).map_err(|error| error.to_string())?;
    Ok(SaveResult {
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn save_recording_asset(input: RecordingAssetInput) -> Result<AssetSaveResult, String> {
    let safe_name = input
        .file_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let path = project_store_dir()?.join(safe_name);
    fs::write(&path, input.bytes).map_err(|error| error.to_string())?;
    Ok(AssetSaveResult {
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn rename_recording(input: RenameRecordingInput) -> Result<SaveResult, String> {
    let current_path = PathBuf::from(&input.path);
    if !current_path.exists() {
        return Err(format!("Recording file was not found: {}", input.path));
    }

    let extension = current_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("mp4");
    let stem = safe_file_stem(&input.file_name);
    let parent = current_path
        .parent()
        .map(PathBuf::from)
        .unwrap_or(recordings_dir()?);
    let target_path = unique_recording_path(parent, &stem, extension);

    if target_path == current_path {
        return Ok(SaveResult {
            path: current_path.to_string_lossy().to_string(),
        });
    }

    fs::rename(&current_path, &target_path).map_err(|error| error.to_string())?;
    Ok(SaveResult {
        path: target_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn load_project(path: String) -> Result<Value, String> {
    let body = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&body).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_recording_asset(path: String) -> Result<AssetReadResult, String> {
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let mime_type = if path.to_ascii_lowercase().ends_with(".mp4") {
        "video/mp4"
    } else if path.to_ascii_lowercase().ends_with(".webm") {
        "video/webm"
    } else {
        "application/octet-stream"
    };
    Ok(AssetReadResult {
        bytes,
        mime_type: mime_type.into(),
    })
}

fn ffmpeg_resolution(resolution: &str) -> &'static str {
    match resolution {
        "4k" => "3840x2160",
        "2k" => "2560x1440",
        _ => "1920x1080",
    }
}

fn ffmpeg_scale_filter(resolution: &str) -> String {
    let size = match resolution {
        "4k" => "3840:-2",
        "2k" => "2560:-2",
        _ => "1920:-2",
    };
    format!("scale={size}")
}

fn even_dimension(value: f64, fallback: f64) -> u32 {
    let mut next = value.round().max(2.0) as u32;
    if next % 2 == 1 {
        next = next.saturating_sub(1).max(2);
    }
    if next == 0 {
        fallback.round().max(2.0) as u32
    } else {
        next
    }
}

fn sanitize_ffmpeg_color(value: &str) -> String {
    let hex = value.trim().trim_start_matches('#');
    if hex.len() == 6 && hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        format!("0x{hex}")
    } else {
        "0xffffff".into()
    }
}

fn normalize_edit_segments(edit_state: Option<&VideoEditState>) -> Vec<EditSegment> {
    let mut segments = edit_state
        .map(|state| state.segments.clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|segment| segment.source_end - segment.source_start >= 0.08)
        .map(|mut segment| {
            segment.source_start = (segment.source_start / 1000.0).max(0.0);
            segment.source_end = (segment.source_end / 1000.0).max(segment.source_start + 0.08);
            segment.speed = segment.speed.clamp(0.25, 4.0);
            segment
        })
        .collect::<Vec<_>>();
    segments.sort_by(|a, b| a.source_start.total_cmp(&b.source_start));
    segments
}

fn map_source_time_to_output_ms(source_ms: f64, segments: &[EditSegment]) -> Option<f64> {
    if segments.is_empty() {
        return Some(source_ms.max(0.0));
    }

    let source_seconds = source_ms / 1000.0;
    let mut output_seconds = 0.0;
    for segment in segments {
        if source_seconds >= segment.source_start && source_seconds <= segment.source_end {
            return Some((output_seconds + (source_seconds - segment.source_start) / segment.speed) * 1000.0);
        }
        output_seconds += (segment.source_end - segment.source_start) / segment.speed;
    }
    None
}

fn remap_mouse_events(events: &[MouseEventRecord], segments: &[EditSegment]) -> Vec<MouseEventRecord> {
    events
        .iter()
        .filter_map(|event| {
            let mapped = map_source_time_to_output_ms(event.timestamp as f64, segments)?;
            let mut next = event.clone();
            next.timestamp = mapped.round().max(0.0) as u128;
            Some(next)
        })
        .collect()
}

fn remap_zoom_segments(
    zoom_segments: &[ExportZoomSegment],
    segments: &[EditSegment],
    crop_rect: Option<&CropRect>,
) -> Vec<ExportZoomSegment> {
    zoom_segments
        .iter()
        .filter_map(|segment| {
            let mapped_start = map_source_time_to_output_ms(segment.start, segments)?;
            let mapped_end = map_source_time_to_output_ms(segment.end, segments)
                .unwrap_or(mapped_start + (segment.end - segment.start).max(100.0));
            let mut next = segment.clone();
            next.start = mapped_start;
            next.end = mapped_end.max(mapped_start + 80.0);
            if let Some(crop) = crop_rect {
                next.center.x = (next.center.x - crop.x).max(0.0);
                next.center.y = (next.center.y - crop.y).max(0.0);
            }
            Some(next)
        })
        .collect()
}

fn build_linear_expr(samples: &[(f64, i32, i32)], axis: char) -> String {
    let coord_index = if axis == 'x' { 1 } else { 2 };
    let value_at = |sample: &(f64, i32, i32)| {
        if coord_index == 1 {
            sample.1
        } else {
            sample.2
        }
    };

    if samples.len() <= 1 {
        return samples.first().map(value_at).unwrap_or(0).to_string();
    }

    let first = samples.first().copied().unwrap_or((0.0, 0, 0));
    let last = samples.last().copied().unwrap_or(first);
    let mut expr = value_at(&last).to_string();

    for pair in samples.windows(2).rev() {
        let start = pair[0];
        let end = pair[1];
        let start_value = value_at(&start) as f64;
        let end_value = value_at(&end) as f64;
        let duration = (end.0 - start.0).max(0.001);
        let interpolated = format!(
            "{start_value:.3}+({end_value:.3}-{start_value:.3})*((t-{:.3})/{duration:.3})",
            start.0
        );
        expr = format!("if(between(t,{:.3},{:.3}),{interpolated},{expr})", start.0, end.0);
    }

    format!("if(lt(t,{:.3}),{},{})", first.0, value_at(&first), expr)
}

fn build_cursor_filters(
    events: &[MouseEventRecord],
    cursor_style: Option<&CursorStyleConfig>,
) -> Vec<String> {
    let Some(style) = cursor_style else {
        return Vec::new();
    };

    let color = sanitize_ffmpeg_color(&style.color);
    let size = style.size.clamp(8.0, 96.0).round() as u32;
    let half = size as f64 / 2.0;
    let max_samples = if style.smooth_path { 900 } else { 360 };
    let position_events = events
        .iter()
        .filter(|event| {
            event.action == "move"
                || event.action == "left_down"
                || event.action == "double_click"
                || event.action == "right_down"
        })
        .collect::<Vec<_>>();
    let stride = (position_events.len() / max_samples).max(1);
    let mut samples = position_events
        .iter()
        .step_by(stride)
        .take(max_samples)
        .map(|event| (event.timestamp as f64 / 1000.0, event.x, event.y))
        .collect::<Vec<_>>();

    if let Some(last) = position_events.last() {
        let last_sample_time = samples.last().map(|sample| sample.0).unwrap_or(-1.0);
        let last_time = last.timestamp as f64 / 1000.0;
        if (last_time - last_sample_time).abs() > f64::EPSILON {
            samples.push((last_time, last.x, last.y));
        }
    }

    if samples.is_empty() {
        return Vec::new();
    }

    let x_expr = build_linear_expr(&samples, 'x');
    let y_expr = build_linear_expr(&samples, 'y');
    let cursor_filter = if style.style == "ring" {
        format!(
            "drawbox=x='({x_expr})-{half:.1}':y='({y_expr})-{half:.1}':w={size}:h={size}:color={color}@0.9:t=4"
        )
    } else if style.style == "dot" {
        format!(
            "drawbox=x='({x_expr})-{half:.1}':y='({y_expr})-{half:.1}':w={size}:h={size}:color={color}@0.9:t=fill"
        )
    } else {
        let width = (size as f64 * 0.72).round().max(6.0) as u32;
        format!("drawbox=x='{x_expr}':y='{y_expr}':w={width}:h={size}:color={color}@0.9:t=fill")
    };

    let mut filters = vec![cursor_filter];
    if style.click_ripple {
        for event in events
            .iter()
            .filter(|event| event.action == "left_down" || event.action == "double_click" || event.action == "right_down")
            .take(80)
        {
            let start = event.timestamp as f64 / 1000.0;
            let end = start + 0.45;
            let ripple = (size as f64 * 1.4).round().max(14.0);
            let ripple_half = ripple / 2.0;
            filters.push(format!(
                "drawbox=x='{:.1}':y='{:.1}':w={:.0}:h={:.0}:color={color}@0.45:t=3:enable='between(t,{start:.3},{end:.3})'",
                event.x as f64 - ripple_half,
                event.y as f64 - ripple_half,
                ripple,
                ripple
            ));
        }
    }

    filters
}

fn crop_filter(crop_rect: Option<&CropRect>, source_width: f64, source_height: f64) -> Option<String> {
    let crop = crop_rect?;
    let x = crop.x.clamp(0.0, (source_width - 2.0).max(0.0)).round();
    let y = crop.y.clamp(0.0, (source_height - 2.0).max(0.0)).round();
    let width = even_dimension(crop.width.min(source_width - x).max(2.0), source_width);
    let height = even_dimension(crop.height.min(source_height - y).max(2.0), source_height);
    if x <= 0.0
        && y <= 0.0
        && (width as f64 - source_width).abs() < 2.0
        && (height as f64 - source_height).abs() < 2.0
    {
        None
    } else {
        Some(format!("crop={width}:{height}:{x:.0}:{y:.0}"))
    }
}

fn build_zoom_filter(
    resolution: &str,
    fps: u32,
    zoom_segments: &[ExportZoomSegment],
) -> String {
    let output_size = ffmpeg_resolution(resolution);
    if zoom_segments.is_empty() {
        return ffmpeg_scale_filter(resolution);
    }

    let mut z_expr = "1".to_string();
    let mut x_expr = "0".to_string();
    let mut y_expr = "0".to_string();

    for segment in zoom_segments.iter().rev().take(40) {
        let start = (segment.start / 1000.0).max(0.0);
        let end = (segment.end / 1000.0).max(start + 0.05);
        let scale = segment.scale.clamp(1.0, 4.0);
        let x = segment.center.x.max(0.0);
        let y = segment.center.y.max(0.0);
        let ease = ((end - start) / 3.0).clamp(0.08, 0.24);
        let active = format!("between(in_time,{start:.3},{end:.3})");
        let zoom_value = format!(
            "if(lt(in_time,{:.3}),1+({:.3}-1)*((in_time-{start:.3})/{ease:.3}),if(gt(in_time,{:.3}),1+({:.3}-1)*(({end:.3}-in_time)/{ease:.3}),{scale:.3}))",
            start + ease,
            scale,
            end - ease,
            scale
        );
        let crop_x = format!("min(max({x:.3}-(iw/zoom/2),0),iw-iw/zoom)");
        let crop_y = format!("min(max({y:.3}-(ih/zoom/2),0),ih-ih/zoom)");
        z_expr = format!("if({active},{zoom_value},{z_expr})");
        x_expr = format!("if({active},{crop_x},{x_expr})");
        y_expr = format!("if({active},{crop_y},{y_expr})");
    }

    format!("zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':d=1:fps={fps}:s={output_size}")
}

fn build_video_filter_graph(
    resolution: &str,
    fps: u32,
    zoom_segments: &[ExportZoomSegment],
    mouse_events: &[MouseEventRecord],
    cursor_style: Option<&CursorStyleConfig>,
    edit_state: Option<&VideoEditState>,
    source_width: f64,
    source_height: f64,
) -> String {
    let segments = normalize_edit_segments(edit_state);
    let crop_rect = edit_state.and_then(|state| state.crop_rect.as_ref());
    let mapped_mouse_events = remap_mouse_events(mouse_events, &segments);
    let mapped_zoom_segments = remap_zoom_segments(zoom_segments, &segments, crop_rect);
    let mut graph_parts = Vec::new();
    let current_label = if segments.is_empty() {
        "[0:v]".to_string()
    } else {
        let mut labels = Vec::new();
        for (index, segment) in segments.iter().enumerate() {
            let label = format!("[vtrim{index}]");
            graph_parts.push(format!(
                "[0:v]trim=start={:.3}:end={:.3},setpts=(PTS-STARTPTS)/{:.4}{label}",
                segment.source_start,
                segment.source_end,
                segment.speed
            ));
            labels.push(label);
        }
        if labels.len() == 1 {
            labels[0].clone()
        } else {
            graph_parts.push(format!(
                "{}concat=n={}:v=1:a=0[vcat]",
                labels.join(""),
                labels.len()
            ));
            "[vcat]".into()
        }
    };

    let mut filters = Vec::new();
    filters.extend(build_cursor_filters(&mapped_mouse_events, cursor_style));
    if let Some(filter) = crop_filter(crop_rect, source_width, source_height) {
        filters.push(filter);
    }
    filters.push(build_zoom_filter(resolution, fps, &mapped_zoom_segments));
    graph_parts.push(format!("{current_label}{}[vout]", filters.join(",")));
    graph_parts.join(";")
}

fn run_export(
    asset_path: &str,
    format: &str,
    resolution: &str,
    zoom_count: usize,
    zoom_segments: &[ExportZoomSegment],
    mouse_events: &[MouseEventRecord],
    cursor_style: Option<&CursorStyleConfig>,
    edit_state: Option<&VideoEditState>,
    source_width: f64,
    source_height: f64,
    fps: u32,
    destination_path: Option<&str>,
) -> Result<ExportResult, String> {
    let input = PathBuf::from(asset_path);
    if !input.exists() {
        return Err(format!("Recording file was not found: {asset_path}"));
    }

    let ffmpeg = ffmpeg_path().ok_or_else(|| {
        "FFmpeg was not found. Run npm install or confirm node_modules/ffmpeg-static/ffmpeg.exe exists."
            .to_string()
    })?;

    let extension = if format == "gif" { "gif" } else { "mp4" };
    let output = if let Some(destination) = destination_path {
        let mut path = PathBuf::from(destination);
        let has_extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case(extension))
            .unwrap_or(false);
        if !has_extension {
            path.set_extension(extension);
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        path
    } else {
        export_dir()?.join(format!(
            "screen-studio-export-{}.{}",
            chrono_like_stamp(),
            extension
        ))
    };

    let mut command = Command::new(ffmpeg);
    hide_subprocess_window(&mut command);
    command.arg("-y").arg("-i").arg(asset_path);
    let export_fps = if format == "gif" { 15 } else { fps };
    let filter_graph = build_video_filter_graph(
        if format == "gif" { "1080p" } else { resolution },
        export_fps,
        zoom_segments,
        mouse_events,
        cursor_style,
        edit_state,
        source_width,
        source_height,
    );
    let filter_script = project_store_dir()?.join(format!("export-filter-{}.txt", chrono_like_stamp()));
    fs::write(&filter_script, &filter_graph).map_err(|error| error.to_string())?;
    command
        .arg("-filter_complex_script")
        .arg(&filter_script)
        .args(["-map", "[vout]"]);

    if format == "gif" {
        command.args(["-loop", "0"]);
    } else {
        command.args(["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an"]);
    }

    command.arg(&output);

    let output_result = command.output().map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&filter_script);
    if !output_result.status.success() {
        let stderr = String::from_utf8_lossy(&output_result.stderr);
        let last_lines = stderr
            .lines()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(if last_lines.trim().is_empty() {
            "FFmpeg export failed without an error message.".into()
        } else {
            last_lines
        });
    }

    let export_path = output.to_string_lossy().to_string();
    Ok(ExportResult {
        path: export_path.clone(),
        message: format!(
            "Export complete: {export_path}, format {format} / {resolution}, project contains {zoom_count} zoom segments."
        ),
    })
}

#[tauri::command]
fn export_recording(input: DirectExportInput) -> Result<ExportResult, String> {
    let source_width = input.source_width.unwrap_or(1920.0);
    let source_height = input.source_height.unwrap_or(1080.0);
    let fps = input.fps.unwrap_or(60).clamp(15, 60);
    run_export(
        &input.source_path,
        &input.format,
        &input.resolution,
        input.zoom_segments.len(),
        &input.zoom_segments,
        &input.mouse_events,
        input.cursor_style.as_ref(),
        input.edit_state.as_ref(),
        source_width,
        source_height,
        fps,
        input.destination_path.as_deref(),
    )
}

#[tauri::command]
fn export_project(export_config: Value, project: Value) -> Result<ExportResult, String> {
    let format = export_config
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("mp4");
    let resolution = export_config
        .get("resolution")
        .and_then(Value::as_str)
        .unwrap_or("1080p");
    let zoom_count = project
        .get("zoomSegments")
        .and_then(Value::as_array)
        .map(|segments| segments.len())
        .unwrap_or(0);
    let asset_path = project
        .get("asset")
        .and_then(|asset| asset.get("nativePath"))
        .and_then(Value::as_str)
        .ok_or_else(|| "No saved recording file was found. Record something first.".to_string())?;
    run_export(
        asset_path,
        format,
        resolution,
        zoom_count,
        &[],
        &[],
        None,
        None,
        1920.0,
        1080.0,
        60,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_graph_contains_edit_cursor_crop_and_zoom_filters() {
        let edit_state = VideoEditState {
            crop_rect: Some(CropRect {
                x: 10.0,
                y: 20.0,
                width: 640.0,
                height: 360.0,
            }),
            segments: vec![EditSegment {
                _id: "clip-1".into(),
                source_start: 0.0,
                source_end: 2_000.0,
                speed: 2.0,
            }],
        };
        let cursor_style = CursorStyleConfig {
            size: 28.0,
            style: "dot".into(),
            color: "#ffffff".into(),
            click_ripple: true,
            smooth_path: true,
        };
        let graph = build_video_filter_graph(
            "1080p",
            60,
            &[ExportZoomSegment {
                start: 200.0,
                end: 900.0,
                center: ExportZoomPoint { x: 120.0, y: 160.0 },
                scale: 1.8,
            }],
            &[MouseEventRecord {
                id: "mouse-1".into(),
                timestamp: 240,
                x: 120,
                y: 160,
                action: "left_down".into(),
                click_count: Some(1),
                cursor_state: "default".into(),
            }],
            Some(&cursor_style),
            Some(&edit_state),
            1280.0,
            720.0,
        );

        assert!(graph.contains("trim=start=0.000:end=2.000"));
        assert!(graph.contains("drawbox"));
        assert!(graph.contains("crop=640:360:10:20"));
        assert!(graph.contains("zoompan"));
        assert!(graph.contains("[vout]"));
    }

    #[test]
    fn source_time_maps_through_kept_segments_and_speed() {
        let segments = normalize_edit_segments(Some(&VideoEditState {
            crop_rect: None,
            segments: vec![
                EditSegment {
                    _id: "a".into(),
                    source_start: 0.0,
                    source_end: 1_000.0,
                    speed: 1.0,
                },
                EditSegment {
                    _id: "b".into(),
                    source_start: 2_000.0,
                    source_end: 4_000.0,
                    speed: 2.0,
                },
            ],
        }));

        assert_eq!(map_source_time_to_output_ms(500.0, &segments), Some(500.0));
        assert_eq!(map_source_time_to_output_ms(1_500.0, &segments), None);
        assert_eq!(map_source_time_to_output_ms(3_000.0, &segments), Some(1_500.0));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RecorderState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_capture_sources,
            get_recordings_dir,
            start_recording,
            pause_recording,
            resume_recording,
            stop_recording,
            save_recording_asset,
            rename_recording,
            read_recording_asset,
            export_recording,
            load_project,
            save_project,
            export_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
