import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Circle,
  Download,
  FolderOpen,
  Monitor,
  MousePointerClick,
  Save,
  Square,
  Video,
  ZoomIn,
} from "lucide-react";
import "./App.css";
import type {
  CaptureSource,
  CropRect,
  CursorStyleConfig,
  EditSegment,
  ExportConfig,
  ExportProjectResult,
  MouseEventRecord,
  NativeRecordingStartResult,
  NativeRecordingStopResult,
  RecordingAssetReadResult,
  RecordingConfig,
  Region,
  VideoEditState,
  ZoomSegment,
} from "./types";
import { activeZoomAt, createZoomForClick, formatTime, mergeSmartZooms } from "./zoom";

const fallbackSources: CaptureSource[] = [
  { id: "current-display", name: "当前显示器", kind: "screen", width: 1920, height: 1080 },
];

const defaultRecordingConfig: RecordingConfig = {
  sourceType: "screen",
  sourceId: "current-display",
  fps: 60,
  microphoneEnabled: false,
  systemAudioEnabled: false,
  hotkeys: {
    start: "Ctrl+Shift+R",
    pause: "Ctrl+Shift+P",
    resume: "Ctrl+Shift+P",
    stop: "Ctrl+Shift+S",
  },
};

const defaultExport: ExportConfig = {
  format: "mp4",
  resolution: "1080p",
  fps: 60,
};

const defaultCursorStyle: CursorStyleConfig = {
  size: 28,
  style: "arrow",
  color: "#ffffff",
  clickRipple: true,
  smoothPath: true,
};

const defaultEditState: VideoEditState = {
  segments: [],
};

async function safeInvoke<T>(command: string, args?: Record<string, unknown>) {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    console.warn(`Tauri command failed: ${command}`, error);
    return undefined;
  }
}

async function loadRecordingPreview(path: string, fallbackMimeType?: string) {
  const asset = await invoke<RecordingAssetReadResult>("read_recording_asset", { path });
  const blob = new Blob([Uint8Array.from(asset.bytes)], { type: fallbackMimeType ?? asset.mimeType });
  return URL.createObjectURL(blob);
}

function keyCombo(event: KeyboardEvent) {
  const keys = [];
  if (event.ctrlKey) keys.push("Ctrl");
  if (event.shiftKey) keys.push("Shift");
  if (event.altKey) keys.push("Alt");
  keys.push(event.key.toUpperCase());
  return keys.join("+");
}

function fileStemFromPath(path: string) {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  return fileName.replace(/\.[^.]+$/, "");
}

function pathJoin(dir: string, fileName: string) {
  const separator = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${separator}${fileName}`;
}

function safeExportName(name: string, fallback: string) {
  const stem = name
    .trim()
    .replace(/\.[^.]+$/, "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[ .]+$/, "");
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem);
  return stem && !reserved ? stem : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function createFullSegment(durationMs: number): EditSegment {
  return {
    id: `segment-${Date.now()}`,
    sourceStart: 0,
    sourceEnd: Math.max(1_000, durationMs),
    speed: 1,
  };
}

function normalizeMouseEvents(events: MouseEventRecord[], region?: Region) {
  if (!region) return events;
  return events.map((event) => ({
    ...event,
    x: event.x - region.x,
    y: event.y - region.y,
  }));
}

function isMousePositionEvent(event: MouseEventRecord) {
  return event.action === "move" || event.action.endsWith("_down") || event.action === "double_click";
}

function findMouseAt(events: MouseEventRecord[], timeMs: number) {
  let previous: MouseEventRecord | undefined;
  let next: MouseEventRecord | undefined;

  for (const event of events) {
    if (!isMousePositionEvent(event)) continue;
    if (event.timestamp <= timeMs) {
      previous = event;
      continue;
    }
    next = event;
    break;
  }

  if (!previous) return next;
  if (!next) return previous;

  const span = Math.max(1, next.timestamp - previous.timestamp);
  const progress = clamp((timeMs - previous.timestamp) / span, 0, 1);
  const eased = progress * progress * (3 - 2 * progress);

  return {
    ...previous,
    timestamp: timeMs,
    x: previous.x + (next.x - previous.x) * eased,
    y: previous.y + (next.y - previous.y) * eased,
  };
}

function activeClickAt(events: MouseEventRecord[], timeMs: number) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      (event.action === "left_down" || event.action === "double_click" || event.action === "right_down") &&
      timeMs >= event.timestamp &&
      timeMs <= event.timestamp + 520
    ) {
      return event;
    }
  }
  return undefined;
}

function sortedSegments(editState: VideoEditState, durationMs: number) {
  const segments = editState.segments.length ? editState.segments : [createFullSegment(durationMs)];
  return segments
    .filter((segment) => segment.sourceEnd - segment.sourceStart >= 80)
    .slice()
    .sort((a, b) => a.sourceStart - b.sourceStart);
}

function App() {
  const [sources, setSources] = useState<CaptureSource[]>(fallbackSources);
  const [recordingConfig, setRecordingConfig] = useState(defaultRecordingConfig);
  const [exportConfig, setExportConfig] = useState(defaultExport);
  const [cursorStyle, setCursorStyle] = useState<CursorStyleConfig>(defaultCursorStyle);
  const [editState, setEditState] = useState<VideoEditState>(defaultEditState);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string>();
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(0);
  const [status, setStatus] = useState("准备录制");
  const [recordingState, setRecordingState] = useState<"idle" | "recording" | "ready">("idle");
  const [recordingUrl, setRecordingUrl] = useState<string>();
  const [recordingNativePath, setRecordingNativePath] = useState<string>();
  const [recordingName, setRecordingName] = useState("");
  const [recordingsDir, setRecordingsDir] = useState<string>();
  const [exportFileName, setExportFileName] = useState("");
  const [exportDestinationPath, setExportDestinationPath] = useState<string>();
  const [exportPath, setExportPath] = useState<string>();
  const [isExporting, setIsExporting] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [mouseEvents, setMouseEvents] = useState<MouseEventRecord[]>([]);
  const [zoomSegments, setZoomSegments] = useState<ZoomSegment[]>([]);
  const [autoZoomEnabled, setAutoZoomEnabled] = useState(true);
  const [zoomScale, setZoomScale] = useState(1.8);
  const [zoomDuration, setZoomDuration] = useState(1_400);

  const startedAtRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  const selectedSource = sources.find((source) => source.id === recordingConfig.sourceId) ?? sources[0];
  const captureWidth = recordingConfig.captureBounds?.width ?? selectedSource?.width ?? 1920;
  const captureHeight = recordingConfig.captureBounds?.height ?? selectedSource?.height ?? 1080;
  const activeZoom = autoZoomEnabled ? activeZoomAt(zoomSegments, currentTime) : undefined;
  const visibleSegments = useMemo(() => sortedSegments(editState, duration), [duration, editState]);
  const selectedSegment = visibleSegments.find((segment) => segment.id === selectedSegmentId) ?? visibleSegments[0];
  const currentMouse = findMouseAt(mouseEvents, currentTime);
  const currentClick = activeClickAt(mouseEvents, currentTime);

  useEffect(() => {
    safeInvoke<CaptureSource[]>("list_capture_sources").then((nativeSources) => {
      if (nativeSources?.length) setSources(nativeSources);
    });
    safeInvoke<{ path: string }>("get_recordings_dir").then((result) => {
      if (result?.path) setRecordingsDir(result.path);
    });
  }, []);

  useEffect(() => {
    if (recordingState !== "recording") return;

    const timer = window.setInterval(() => {
      setCurrentTime(performance.now() - startedAtRef.current);
    }, 200);

    return () => window.clearInterval(timer);
  }, [recordingState]);

  useEffect(() => {
    if (!recordingUrl || recordingState !== "ready") return;

    let frame = 0;
    const syncPreviewTime = () => {
      const video = videoRef.current;
      if (video && !video.paused && !video.ended) {
        setCurrentTime(video.currentTime * 1000);
      }
      frame = window.requestAnimationFrame(syncPreviewTime);
    };

    frame = window.requestAnimationFrame(syncPreviewTime);
    return () => window.cancelAnimationFrame(frame);
  }, [recordingState, recordingUrl]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const combo = keyCombo(event);
      if (combo === recordingConfig.hotkeys.start.toUpperCase()) {
        event.preventDefault();
        void startRecording();
      }
      if (combo === recordingConfig.hotkeys.stop.toUpperCase()) {
        event.preventDefault();
        void stopRecording();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function updateRecordingConfig(patch: Partial<RecordingConfig>) {
    setRecordingConfig((current) => ({ ...current, ...patch }));
  }

  function buildZooms(events: MouseEventRecord[]) {
    const clickEvents = events.filter((event) => event.action === "left_down" || event.action === "double_click");
    return mergeSmartZooms(clickEvents.map((event) => createZoomForClick(event, zoomScale, zoomDuration)));
  }

  function resetEditing(nextDuration = duration) {
    const fullSegment = createFullSegment(nextDuration);
    setEditState({ segments: [fullSegment] });
    setSelectedSegmentId(fullSegment.id);
    setSelectionStart(0);
    setSelectionEnd(Math.max(1_000, nextDuration));
  }

  async function startRecording() {
    if (recordingState === "recording") return;

    setStatus("正在开始录制……");
    setRecordingUrl(undefined);
    setRecordingName("");
    setExportFileName("");
    setExportDestinationPath(undefined);
    setExportPath(undefined);
    setCurrentTime(0);
    setDuration(0);
    setMouseEvents([]);
    setZoomSegments([]);
    setEditState(defaultEditState);

    try {
      const native = await invoke<NativeRecordingStartResult>("start_recording", {
        config: recordingConfig,
      });
      startedAtRef.current = performance.now();
      updateRecordingConfig({ sourceType: "screen", sourceId: "current-display", captureBounds: native.captureBounds });
      setSources([{ id: "current-display", name: "当前显示器", kind: "screen", width: native.captureBounds.width, height: native.captureBounds.height }]);
      setRecordingNativePath(native.path);
      setRecordingState("recording");
      setStatus(`${native.message}，正在跟踪鼠标移动和点击。`);
    } catch (error) {
      setStatus(`无法开始录制：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function stopRecording() {
    if (recordingState !== "recording") return;

    setStatus("正在停止录制并加载预览……");

    try {
      const result = await invoke<NativeRecordingStopResult>("stop_recording");
      const previewUrl = await loadRecordingPreview(result.path, result.mimeType);
      updateRecordingConfig({ captureBounds: result.captureBounds });
      const normalizedEvents = normalizeMouseEvents(result.mouseEvents ?? [], result.captureBounds);
      const zooms = buildZooms(normalizedEvents);
      const nextDuration = Math.max(Number(result.duration), 1_000);
      const fullSegment = createFullSegment(nextDuration);
      setRecordingUrl(previewUrl);
      setRecordingNativePath(result.path);
      setRecordingName(fileStemFromPath(result.path));
      setExportFileName(`${fileStemFromPath(result.path)}-export`);
      setDuration(nextDuration);
      setCurrentTime(0);
      setMouseEvents(normalizedEvents);
      setZoomSegments(zooms);
      setEditState({ segments: [fullSegment] });
      setSelectedSegmentId(fullSegment.id);
      setSelectionStart(0);
      setSelectionEnd(nextDuration);
      setRecordingState("ready");
      setStatus(`录制已自动保存：${result.path}。已创建 ${zooms.length} 个点击缩放片段。`);
    } catch (error) {
      setStatus(`停止录制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function exportRecording() {
    if (isExporting) return;

    if (!recordingNativePath) {
      setStatus("请先完成录制，再进行导出。");
      return;
    }

    let destinationPath = exportDestinationPath;
    if (!destinationPath) {
      destinationPath = await chooseExportPath();
      if (!destinationPath) {
        setStatus("已取消导出，请选择保存位置后重试。");
        return;
      }
    }

    setIsExporting(true);
    setStatus(`正在导出 ${exportConfig.format.toUpperCase()} ${exportConfig.resolution}……`);

    try {
      const result = await invoke<ExportProjectResult>("export_recording", {
        input: {
          sourcePath: recordingNativePath,
          format: exportConfig.format,
          resolution: exportConfig.resolution,
          destinationPath,
          zoomSegments: autoZoomEnabled ? zoomSegments : [],
          sourceWidth: captureWidth,
          sourceHeight: captureHeight,
          fps: recordingConfig.fps,
          mouseEvents,
          cursorStyle,
          editState: {
            ...editState,
            segments: visibleSegments,
          },
        },
      });
      setExportPath(result.path);
      setStatus(`导出完成：${result.path}`);
    } catch (error) {
      setStatus(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsExporting(false);
    }
  }

  async function renameRecording() {
    if (isRenaming || !recordingNativePath) return;

    const nextName = recordingName.trim();
    if (!nextName) {
      setStatus("请先输入录制名称。");
      return;
    }

    setIsRenaming(true);
    setStatus("正在保存录制名称……");

    try {
      const result = await invoke<{ path: string }>("rename_recording", {
        input: {
          path: recordingNativePath,
          fileName: nextName,
        },
      });
      const previewUrl = await loadRecordingPreview(result.path, "video/mp4");
      setRecordingUrl(previewUrl);
      setRecordingNativePath(result.path);
      setRecordingName(fileStemFromPath(result.path));
      setExportFileName(`${fileStemFromPath(result.path)}-export`);
      setExportDestinationPath(undefined);
      setExportPath(undefined);
      setStatus(`录制已重命名：${result.path}`);
    } catch (error) {
      setStatus(`重命名失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsRenaming(false);
    }
  }

  function regenerateZooms(nextScale = zoomScale, nextDuration = zoomDuration) {
    const clickEvents = mouseEvents.filter((event) => event.action === "left_down" || event.action === "double_click");
    setZoomSegments(mergeSmartZooms(clickEvents.map((event) => createZoomForClick(event, nextScale, nextDuration))));
  }

  async function chooseExportPath() {
    const extension = exportConfig.format === "gif" ? "gif" : "mp4";
    const fallbackName = recordingNativePath ? `${fileStemFromPath(recordingNativePath)}-export` : "screen-recording";
    const fileName = `${safeExportName(exportFileName, fallbackName)}.${extension}`;
    const defaultPath = recordingsDir ? pathJoin(recordingsDir, fileName) : fileName;
    const selected = await save({
      title: "保存导出的录制文件",
      defaultPath,
      filters: [
        {
          name: exportConfig.format.toUpperCase(),
          extensions: [extension],
        },
      ],
    });

    if (!selected) return undefined;
    setExportDestinationPath(selected);
    setExportFileName(fileStemFromPath(selected));
    return selected;
  }

  function updateCrop(patch: Partial<CropRect>) {
    const current = editState.cropRect ?? { x: 0, y: 0, width: captureWidth, height: captureHeight };
    const next = {
      ...current,
      ...patch,
    };
    next.x = clamp(Math.round(next.x), 0, Math.max(0, captureWidth - 32));
    next.y = clamp(Math.round(next.y), 0, Math.max(0, captureHeight - 32));
    next.width = clamp(Math.round(next.width), 32, captureWidth - next.x);
    next.height = clamp(Math.round(next.height), 32, captureHeight - next.y);
    setEditState((state) => ({ ...state, cropRect: next }));
  }

  function deleteSelection() {
    const start = Math.min(selectionStart, selectionEnd);
    const end = Math.max(selectionStart, selectionEnd);
    if (end - start < 80) return;
    const nextSegments = visibleSegments.flatMap((segment) => {
      if (end <= segment.sourceStart || start >= segment.sourceEnd) return [segment];
      const pieces: EditSegment[] = [];
      if (start > segment.sourceStart) {
        pieces.push({ ...segment, id: `${segment.id}-a-${Date.now()}`, sourceEnd: start });
      }
      if (end < segment.sourceEnd) {
        pieces.push({ ...segment, id: `${segment.id}-b-${Date.now()}`, sourceStart: end });
      }
      return pieces;
    });
    setEditState((state) => ({ ...state, segments: nextSegments }));
    setSelectedSegmentId(nextSegments[0]?.id);
    setStatus(`已从编辑中删除 ${formatTime(start)} - ${formatTime(end)}。`);
  }

  function trimSelectedToSelection() {
    if (!selectedSegment) return;
    const start = Math.min(selectionStart, selectionEnd);
    const end = Math.max(selectionStart, selectionEnd);
    if (end - start < 80) return;
    setEditState((state) => ({
      ...state,
      segments: visibleSegments.map((segment) =>
        segment.id === selectedSegment.id
          ? {
              ...segment,
              sourceStart: clamp(start, segment.sourceStart, segment.sourceEnd - 80),
              sourceEnd: clamp(end, segment.sourceStart + 80, segment.sourceEnd),
            }
          : segment,
      ),
    }));
    setStatus(`已将所选片段裁剪为 ${formatTime(start)} - ${formatTime(end)}。`);
  }

  function splitAtPlayhead() {
    if (!selectedSegment) return;
    const point = currentTime;
    if (point <= selectedSegment.sourceStart + 80 || point >= selectedSegment.sourceEnd - 80) return;
    const left = { ...selectedSegment, id: `${selectedSegment.id}-left-${Date.now()}`, sourceEnd: point };
    const right = { ...selectedSegment, id: `${selectedSegment.id}-right-${Date.now()}`, sourceStart: point };
    setEditState((state) => ({
      ...state,
      segments: visibleSegments.flatMap((segment) => (segment.id === selectedSegment.id ? [left, right] : [segment])),
    }));
    setSelectedSegmentId(right.id);
    setStatus(`已在 ${formatTime(point)} 分割片段。`);
  }

  function updateSelectedSpeed(speed: number) {
    if (!selectedSegment) return;
    setEditState((state) => ({
      ...state,
      segments: visibleSegments.map((segment) => (segment.id === selectedSegment.id ? { ...segment, speed } : segment)),
    }));
  }

  const elapsed = recordingState === "recording" ? currentTime : duration;
  const zoomOriginX = activeZoom ? clamp((activeZoom.center.x / captureWidth) * 100, 0, 100) : 50;
  const zoomOriginY = activeZoom ? clamp((activeZoom.center.y / captureHeight) * 100, 0, 100) : 50;
  const cursorLeft = currentMouse ? clamp((currentMouse.x / captureWidth) * 100, 0, 100) : 50;
  const cursorTop = currentMouse ? clamp((currentMouse.y / captureHeight) * 100, 0, 100) : 50;
  const clickLeft = currentClick ? clamp((currentClick.x / captureWidth) * 100, 0, 100) : 50;
  const clickTop = currentClick ? clamp((currentClick.y / captureHeight) * 100, 0, 100) : 50;
  const crop = editState.cropRect;

  return (
    <main className="record-shell">
      <header className="record-topbar">
        <div className="app-title">
          <div className="app-mark">
            <Video size={20} />
          </div>
          <div>
            <p>屏幕录制工作室</p>
            <h1>支持点击自动缩放的屏幕录制工具</h1>
          </div>
        </div>
        <div className={`record-status ${recordingState}`}>{status}</div>
      </header>

      <section className="record-layout">
        <aside className="record-controls">
          <div className="control-group">
            <h2>录制来源</h2>
            <p className="small-note">自动录制软件窗口所在的当前显示器</p>
          </div>

          <div className="control-group">
            <h2>帧率</h2>
            <div className="segmented">
              {[30, 60].map((fps) => (
                <button
                  key={fps}
                  className={recordingConfig.fps === fps ? "selected" : ""}
                  onClick={() => updateRecordingConfig({ fps: fps as 30 | 60 })}
                >
                  {fps}fps
                </button>
              ))}
            </div>
          </div>

          <div className="control-group">
            <h2>自动缩放</h2>
            <label className="check-row">
              <input
                type="checkbox"
                checked={autoZoomEnabled}
                onChange={(event) => setAutoZoomEnabled(event.target.checked)}
              />
              自动放大点击位置
            </label>
            <label>
              缩放倍数 {zoomScale.toFixed(2)}x
              <input
                type="range"
                min="1"
                max="3"
                step="0.05"
                value={zoomScale}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setZoomScale(value);
                  regenerateZooms(value, zoomDuration);
                }}
              />
            </label>
            <label>
              持续时间 {Math.round(zoomDuration)} 毫秒
              <input
                type="range"
                min="600"
                max="3000"
                step="100"
                value={zoomDuration}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setZoomDuration(value);
                  regenerateZooms(zoomScale, value);
                }}
              />
            </label>
          </div>

          <div className="control-group">
            <h2>鼠标</h2>
            <label>
              大小 {cursorStyle.size} 像素
              <input
                type="range"
                min="12"
                max="80"
                step="2"
                value={cursorStyle.size}
                onChange={(event) => setCursorStyle((current) => ({ ...current, size: Number(event.target.value) }))}
              />
            </label>
            <label>
              样式
              <select
                value={cursorStyle.style}
                onChange={(event) =>
                  setCursorStyle((current) => ({ ...current, style: event.target.value as CursorStyleConfig["style"] }))
                }
              >
                <option value="arrow">箭头</option>
                <option value="dot">圆点</option>
                <option value="ring">圆环</option>
              </select>
            </label>
            <label>
              颜色
              <input
                type="color"
                value={cursorStyle.color}
                onChange={(event) => setCursorStyle((current) => ({ ...current, color: event.target.value }))}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={cursorStyle.clickRipple}
                onChange={(event) => setCursorStyle((current) => ({ ...current, clickRipple: event.target.checked }))}
              />
              点击波纹
            </label>
          </div>

          <div className="control-group">
            <h2>快捷键</h2>
            <div className="shortcut-list">
              <span>开始：{recordingConfig.hotkeys.start}</span>
              <span>停止：{recordingConfig.hotkeys.stop}</span>
            </div>
          </div>

          <div className="record-actions">
            {recordingState === "recording" ? (
              <button className="stop-button" onClick={stopRecording}>
                <Square size={18} />
                停止录制
              </button>
            ) : (
              <button className="start-button" onClick={startRecording}>
                <Circle size={18} fill="currentColor" />
                开始录制
              </button>
            )}
          </div>
        </aside>

        <section className="record-preview-card">
          <div className="preview-header">
            <div>
              <strong>
                {selectedSource?.name ?? "当前显示器"}
              </strong>
              <span>{recordingState === "recording" ? "录制中" : recordingUrl ? "预览" : "等待录制"}</span>
            </div>
            <div className="preview-metrics">
              <span>
                <MousePointerClick size={14} />
                {mouseEvents.filter((event) => event.action === "left_down" || event.action === "double_click").length}
              </span>
              <span>
                <ZoomIn size={14} />
                {zoomSegments.length}
              </span>
              <div className="timer">{formatTime(elapsed)}</div>
            </div>
          </div>

          <div className="video-frame">
            {recordingUrl ? (
              <div
                className="zoom-stage"
                style={{
                  transform: `scale(${activeZoom ? activeZoom.scale : 1})`,
                  transformOrigin: `${zoomOriginX}% ${zoomOriginY}%`,
                }}
              >
                <video
                  ref={videoRef}
                  src={recordingUrl}
                  controls
                  onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime * 1000)}
                  onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime * 1000)}
                />
                {currentMouse && (
                  <div
                    className={`custom-cursor ${cursorStyle.style}`}
                    style={{
                      left: `${cursorLeft}%`,
                      top: `${cursorTop}%`,
                      width: `${cursorStyle.size}px`,
                      height: `${cursorStyle.size}px`,
                      color: cursorStyle.color,
                    }}
                  />
                )}
                {currentClick && cursorStyle.clickRipple && (
                  <div
                    className="click-ripple"
                    style={{
                      left: `${clickLeft}%`,
                      top: `${clickTop}%`,
                      width: `${cursorStyle.size * 2.5}px`,
                      height: `${cursorStyle.size * 2.5}px`,
                      borderColor: cursorStyle.color,
                    }}
                  />
                )}
                {crop && (
                  <div
                    className="crop-preview"
                    style={{
                      left: `${(crop.x / captureWidth) * 100}%`,
                      top: `${(crop.y / captureHeight) * 100}%`,
                      width: `${(crop.width / captureWidth) * 100}%`,
                      height: `${(crop.height / captureHeight) * 100}%`,
                    }}
                  />
                )}
              </div>
            ) : recordingState === "recording" ? (
              <div className="empty-recording live">
                <Circle size={42} fill="currentColor" />
                <strong>正在录制</strong>
                <span>点击屏幕任意位置，停止后预览会自动放大每次点击。</span>
              </div>
            ) : (
              <div className="empty-recording">
                <Monitor size={54} />
                <strong>准备录制</strong>
                <span>设置帧率后即可开始录制当前显示器。</span>
              </div>
            )}
          </div>

          <div className="editor-panel">
            <div className="editor-head">
              <h2>基础编辑</h2>
              <button onClick={() => resetEditing()} disabled={!duration}>
                重置编辑
              </button>
            </div>
            <div className="timeline-range">
              <label>
                选择起点 {formatTime(selectionStart)}
                <input
                  type="range"
                  min="0"
                  max={Math.max(1, duration)}
                  step="100"
                  value={selectionStart}
                  disabled={!duration}
                  onChange={(event) => setSelectionStart(Number(event.target.value))}
                />
              </label>
              <label>
                选择终点 {formatTime(selectionEnd)}
                <input
                  type="range"
                  min="0"
                  max={Math.max(1, duration)}
                  step="100"
                  value={selectionEnd}
                  disabled={!duration}
                  onChange={(event) => setSelectionEnd(Number(event.target.value))}
                />
              </label>
            </div>
            <div className="edit-actions">
              <button onClick={trimSelectedToSelection} disabled={!selectedSegment}>
                裁剪所选片段
              </button>
              <button onClick={splitAtPlayhead} disabled={!selectedSegment}>
                在播放位置分割
              </button>
              <button onClick={deleteSelection} disabled={!selectedSegment}>
                删除所选范围
              </button>
            </div>
            <div className="segment-list">
              {visibleSegments.map((segment, index) => (
                <button
                  key={segment.id}
                  className={segment.id === selectedSegment?.id ? "segment-chip selected" : "segment-chip"}
                  onClick={() => setSelectedSegmentId(segment.id)}
                >
                  片段 {index + 1}：{formatTime(segment.sourceStart)} - {formatTime(segment.sourceEnd)} /{" "}
                  {segment.speed.toFixed(1)}x
                </button>
              ))}
            </div>
            <label className="speed-control">
              所选片段速度 {selectedSegment?.speed.toFixed(1) ?? "1.0"}x
              <input
                type="range"
                min="0.25"
                max="4"
                step="0.25"
                value={selectedSegment?.speed ?? 1}
                disabled={!selectedSegment}
                onChange={(event) => updateSelectedSpeed(Number(event.target.value))}
              />
            </label>
            <div className="crop-controls">
              <h2>裁剪画面</h2>
              <div className="crop-grid">
                <label>
                  X
                  <input
                    type="number"
                    value={crop?.x ?? 0}
                    disabled={!duration}
                    onChange={(event) => updateCrop({ x: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Y
                  <input
                    type="number"
                    value={crop?.y ?? 0}
                    disabled={!duration}
                    onChange={(event) => updateCrop({ y: Number(event.target.value) })}
                  />
                </label>
                <label>
                  W
                  <input
                    type="number"
                    value={crop?.width ?? captureWidth}
                    disabled={!duration}
                    onChange={(event) => updateCrop({ width: Number(event.target.value) })}
                  />
                </label>
                <label>
                  H
                  <input
                    type="number"
                    value={crop?.height ?? captureHeight}
                    disabled={!duration}
                    onChange={(event) => updateCrop({ height: Number(event.target.value) })}
                  />
                </label>
              </div>
              <div className="edit-actions">
                <button
                  onClick={() => setEditState((state) => ({ ...state, cropRect: { x: 0, y: 0, width: captureWidth, height: captureHeight } }))}
                  disabled={!duration}
                >
                  完整画面
                </button>
                <button onClick={() => setEditState((state) => ({ ...state, cropRect: undefined }))} disabled={!duration}>
                  清除裁剪
                </button>
              </div>
            </div>
          </div>
        </section>

        <aside className="export-panel">
          <div className="control-group">
            <h2>导出</h2>
            <div className="segmented">
              {(["mp4", "gif"] as const).map((format) => (
                <button
                  key={format}
                  className={exportConfig.format === format ? "selected" : ""}
                  onClick={() => {
                    setExportConfig((current) => ({ ...current, format }));
                    setExportDestinationPath(undefined);
                  }}
                >
                  {format.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="resolution-grid">
              {(["1080p", "2k", "4k"] as const).map((resolution) => (
                <button
                  key={resolution}
                  className={exportConfig.resolution === resolution ? "selected" : ""}
                  onClick={() => setExportConfig((current) => ({ ...current, resolution }))}
                >
                  {resolution}
                </button>
              ))}
            </div>
            <label>
              导出名称
              <input
                value={exportFileName}
                placeholder="输入导出文件名"
                disabled={recordingState !== "ready" || isExporting}
                onChange={(event) => {
                  setExportFileName(event.target.value);
                  setExportDestinationPath(undefined);
                }}
              />
            </label>
            <button
              className="location-button"
              onClick={() => void chooseExportPath()}
              disabled={recordingState !== "ready" || !recordingNativePath || isExporting}
            >
              <FolderOpen size={16} />
              选择保存位置
            </button>
            {exportDestinationPath && <p className="destination-path">{exportDestinationPath}</p>}
            <button
              className="export-button"
              onClick={exportRecording}
              disabled={recordingState !== "ready" || !recordingNativePath || isExporting}
            >
              <Download size={18} />
              {isExporting ? "正在导出" : "导出文件"}
            </button>
          </div>

          <div className="file-info">
            <h2>自动保存</h2>
            <p>{recordingsDir ? `文件夹：${recordingsDir}` : "正在准备录制文件夹……"}</p>
            <h2>录制名称</h2>
            <input
              value={recordingName}
              placeholder="为本次录制命名"
              disabled={!recordingNativePath || recordingState === "recording" || isRenaming}
              onChange={(event) => setRecordingName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void renameRecording();
              }}
            />
            <button
              className="rename-button"
              onClick={renameRecording}
              disabled={!recordingNativePath || recordingState !== "ready" || isRenaming}
            >
              <Save size={16} />
              {isRenaming ? "正在保存名称" : "保存名称"}
            </button>
            <h2>最新录制</h2>
            <p>{recordingNativePath ?? "暂无录制"}</p>
            {exportPath && <p>导出文件：{exportPath}</p>}
          </div>
        </aside>
      </section>
    </main>
  );
}

export default App;
