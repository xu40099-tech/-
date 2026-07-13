import type { FrameRate, MouseEventRecord, RecordingConfig } from "./types";

export interface BrowserRecordingResult {
  blob: Blob;
  url: string;
  mimeType: string;
  duration: number;
}

const MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function supportedMimeType() {
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

async function mixStreams(
  displayStream: MediaStream,
  config: RecordingConfig,
) {
  const tracks: MediaStreamTrack[] = [...displayStream.getVideoTracks()];
  const audioTracks: MediaStreamTrack[] = [];

  if (config.systemAudioEnabled) {
    audioTracks.push(...displayStream.getAudioTracks());
  }

  if (config.microphoneEnabled) {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: config.microphoneDeviceId
        ? { deviceId: { exact: config.microphoneDeviceId } }
        : true,
      video: false,
    });
    audioTracks.push(...micStream.getAudioTracks());
  }

  if (audioTracks.length <= 1) {
    return new MediaStream([...tracks, ...audioTracks]);
  }

  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  for (const track of audioTracks) {
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    source.connect(destination);
  }

  return new MediaStream([...tracks, ...destination.stream.getAudioTracks()]);
}

export class BrowserRecorder {
  private mediaRecorder?: MediaRecorder;
  private chunks: BlobPart[] = [];
  private startedAt = 0;
  private pausedAt = 0;
  private pausedDuration = 0;
  private stream?: MediaStream;

  async start(config: RecordingConfig) {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: config.fps as FrameRate,
      },
      audio: config.systemAudioEnabled,
    });

    this.stream = await mixStreams(displayStream, config);
    this.chunks = [];
    this.startedAt = performance.now();
    this.pausedAt = 0;
    this.pausedDuration = 0;

    const mimeType = supportedMimeType();
    this.mediaRecorder = new MediaRecorder(
      this.stream,
      mimeType ? { mimeType } : undefined,
    );

    this.mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });

    this.mediaRecorder.start(250);
  }

  pause() {
    if (this.mediaRecorder?.state === "recording") {
      this.pausedAt = performance.now();
      this.mediaRecorder.pause();
    }
  }

  resume() {
    if (this.mediaRecorder?.state === "paused") {
      this.pausedDuration += performance.now() - this.pausedAt;
      this.pausedAt = 0;
      this.mediaRecorder.resume();
    }
  }

  async stop(): Promise<BrowserRecordingResult> {
    const recorder = this.mediaRecorder;
    if (!recorder) throw new Error("Recorder has not started.");

    const stopped = new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
    });

    recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    await stopped;

    const mimeType = recorder.mimeType || "video/webm";
    const blob = new Blob(this.chunks, { type: mimeType });
    const duration = performance.now() - this.startedAt - this.pausedDuration;

    return {
      blob,
      url: URL.createObjectURL(blob),
      mimeType,
      duration,
    };
  }
}

export function createMouseRecorder(
  onEvent: (event: MouseEventRecord) => void,
  getTime: () => number,
) {
  let lastClick = 0;
  let lastClickPosition = { x: 0, y: 0 };
  let lastMove = 0;

  const cursorState = (target: EventTarget | null): MouseEventRecord["cursorState"] => {
    if (!(target instanceof HTMLElement)) return "default";
    const cursor = getComputedStyle(target).cursor;
    if (cursor.includes("pointer")) return "pointer";
    if (cursor.includes("text")) return "text";
    if (cursor.includes("grab")) return "grab";
    if (cursor.includes("resize")) return "resize";
    return "default";
  };

  const record = (
    native: MouseEvent | WheelEvent,
    action: MouseEventRecord["action"],
    extra: Partial<MouseEventRecord> = {},
  ) => {
    onEvent({
      id: `mouse-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      timestamp: Math.round(getTime()),
      x: native.screenX,
      y: native.screenY,
      action,
      cursorState: cursorState(native.target),
      ...extra,
    });
  };

  const onMove = (event: MouseEvent) => {
    const now = performance.now();
    if (now - lastMove < 33) return;
    lastMove = now;
    record(event, "move");
  };

  const onDown = (event: MouseEvent) => {
    const now = performance.now();
    const sameArea =
      Math.hypot(event.screenX - lastClickPosition.x, event.screenY - lastClickPosition.y) < 8;
    const isDouble = now - lastClick < 360 && sameArea;

    lastClick = now;
    lastClickPosition = { x: event.screenX, y: event.screenY };

    if (isDouble) {
      record(event, "double_click", { clickCount: 2 });
      return;
    }

    record(event, event.button === 2 ? "right_down" : "left_down", {
      clickCount: 1,
    });
  };

  const onUp = (event: MouseEvent) => {
    record(event, event.button === 2 ? "right_up" : "left_up");
  };

  const onWheel = (event: WheelEvent) => {
    record(event, "wheel", { wheelDelta: event.deltaY });
  };

  window.addEventListener("mousemove", onMove, { passive: true });
  window.addEventListener("mousedown", onDown, { passive: true });
  window.addEventListener("mouseup", onUp, { passive: true });
  window.addEventListener("wheel", onWheel, { passive: true });

  return () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mousedown", onDown);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("wheel", onWheel);
  };
}
