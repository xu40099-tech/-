export type CaptureSourceType = "screen";
export type FrameRate = 30 | 60;
export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "4:5";
export type ExportFormat = "mp4" | "gif";
export type ExportResolution = "1080p" | "2k" | "4k";

export interface CaptureSource {
  id: string;
  name: string;
  kind: CaptureSourceType;
  displayId?: string;
  width?: number;
  height?: number;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CursorStyle = "arrow" | "dot" | "ring";

export interface CursorStyleConfig {
  size: number;
  style: CursorStyle;
  color: string;
  clickRipple: boolean;
  smoothPath: boolean;
  rippleSize: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EditSegment {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  speed: number;
}

export interface VideoEditState {
  cropRect?: CropRect;
  segments: EditSegment[];
}

export interface RecordingConfig {
  sourceType: CaptureSourceType;
  sourceId: string;
  captureBounds?: Region;
  fps: FrameRate;
  microphoneEnabled: boolean;
  microphoneDeviceId?: string;
  systemAudioEnabled: boolean;
  hotkeys: {
    start: string;
    pause: string;
    resume: string;
    stop: string;
  };
}

export type MouseAction =
  | "move"
  | "left_down"
  | "left_up"
  | "right_down"
  | "right_up"
  | "double_click"
  | "wheel";

export interface MouseEventRecord {
  id: string;
  timestamp: number;
  x: number;
  y: number;
  action: MouseAction;
  wheelDelta?: number;
  clickCount?: number;
  cursorState: "default" | "pointer" | "text" | "grab" | "resize";
}

export interface ZoomSegment {
  id: string;
  start: number;
  end: number;
  center: {
    x: number;
    y: number;
  };
  scale: number;
  easing: "smooth" | "linear";
  sourceEventIds: string[];
  mode: "auto" | "manual";
}

export interface BackgroundConfig {
  type: "solid" | "gradient" | "image";
  value: string;
}

export interface StyleConfig {
  background: BackgroundConfig;
  padding: number;
  radius: number;
  shadow: number;
  stroke: number;
  aspectRatio: AspectRatio;
  portraitFollowMode: boolean;
  cursorScale: number;
  clickRipple: boolean;
  smoothCursorPath: boolean;
}

export interface TimelineEdit {
  id: string;
  type: "trim" | "split" | "delete" | "speed" | "volume";
  start: number;
  end?: number;
  value?: number;
}

export interface ExportConfig {
  format: ExportFormat;
  resolution: ExportResolution;
  fps: FrameRate;
  destination?: string;
}

export interface RecordingAsset {
  id: string;
  url?: string;
  mimeType?: string;
  duration: number;
  createdAt: string;
  nativePath?: string;
  exportPath?: string;
}

export interface NativeRecordingStartResult {
  path: string;
  startedAt: number;
  message: string;
  captureBounds: Region;
}

export interface NativeRecordingStopResult {
  path: string;
  duration: number;
  mimeType: string;
  mouseEvents: MouseEventRecord[];
  message: string;
  captureBounds: Region;
}

export interface ExportProjectResult {
  path: string;
  message: string;
}

export interface RecordingAssetReadResult {
  bytes: number[];
  mimeType: string;
}

export interface StudioProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  recordingConfig: RecordingConfig;
  style: StyleConfig;
  mouseEvents: MouseEventRecord[];
  zoomSegments: ZoomSegment[];
  edits: TimelineEdit[];
  editState?: VideoEditState;
  cursorStyle?: CursorStyleConfig;
  exportConfig: ExportConfig;
  asset?: RecordingAsset;
}
