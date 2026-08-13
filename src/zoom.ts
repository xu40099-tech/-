import type { MouseEventRecord, ZoomSegment } from "./types";

const MERGE_GAP_MS = 650;
const MERGE_DISTANCE = 90;

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function createZoomForClick(
  event: MouseEventRecord,
  scale: number,
  durationMs: number,
): ZoomSegment {
  const leadIn = 180;
  const start = Math.max(0, event.timestamp - leadIn);
  const end = event.timestamp + durationMs;

  return {
    id: `zoom-${event.id}`,
    start,
    end,
    center: { x: event.x, y: event.y },
    scale,
    easing: "smooth",
    sourceEventIds: [event.id],
    mode: "auto",
  };
}

export function mergeSmartZooms(segments: ZoomSegment[]) {
  return segments
    .slice()
    .sort((a, b) => a.start - b.start)
    .reduce<ZoomSegment[]>((merged, segment) => {
      const previous = merged[merged.length - 1];
      if (!previous) return [segment];

      const closeInTime = segment.start - previous.end < MERGE_GAP_MS;
      const closeInSpace = distance(previous.center, segment.center) < MERGE_DISTANCE;
      const bothAuto = previous.mode === "auto" && segment.mode === "auto";

      if (!bothAuto || !closeInTime || !closeInSpace) {
        merged.push(segment);
        return merged;
      }

      previous.end = Math.max(previous.end, segment.end);
      previous.center = {
        x: Math.round((previous.center.x + segment.center.x) / 2),
        y: Math.round((previous.center.y + segment.center.y) / 2),
      };
      previous.sourceEventIds = [
        ...previous.sourceEventIds,
        ...segment.sourceEventIds,
      ];
      previous.scale = Math.max(previous.scale, segment.scale);
      return merged;
    }, []);
}

export function activeZoomAt(
  segments: ZoomSegment[],
  timeMs: number,
): ZoomSegment | undefined {
  return segments.find((segment) => timeMs >= segment.start && timeMs <= segment.end);
}

export const ZOOM_EASE_MS = 360;
export const CLICK_RIPPLE_MS = 520;

export function smoothstep(progress: number) {
  const value = Math.min(1, Math.max(0, progress));
  return value * value * (3 - 2 * value);
}

export function zoomScaleAt(segment: ZoomSegment | undefined, timeMs: number) {
  if (!segment) return 1;
  const easeMs = Math.min(ZOOM_EASE_MS, Math.max(1, (segment.end - segment.start) / 2));
  if (timeMs < segment.start + easeMs) {
    return 1 + (segment.scale - 1) * smoothstep((timeMs - segment.start) / easeMs);
  }
  if (timeMs > segment.end - easeMs) {
    return 1 + (segment.scale - 1) * smoothstep((segment.end - timeMs) / easeMs);
  }
  return segment.scale;
}

export function formatTime(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
