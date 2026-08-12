import { useEffect, useState } from "react";
import type { PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Region } from "./types";
import "./RegionSelector.css";

const params = new URLSearchParams(window.location.search);
const monitorX = Number(params.get("x") ?? 0);
const monitorY = Number(params.get("y") ?? 0);
const scaleFactor = Number(params.get("scale") ?? 1);

export default function RegionSelector() {
  const [start, setStart] = useState<{ x: number; y: number }>();
  const [draft, setDraft] = useState<Region>();
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const cancel = async (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      try {
        await invoke("cancel_region_selection");
      } catch (reason) {
        setError(`无法关闭选区：${String(reason)}`);
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);

  function point(event: PointerEvent<HTMLDivElement>) {
    return {
      x: Math.round(event.clientX * scaleFactor),
      y: Math.round(event.clientY * scaleFactor),
    };
  }

  function rectangle(from: { x: number; y: number }, to: { x: number; y: number }): Region {
    return {
      x: Math.min(from.x, to.x),
      y: Math.min(from.y, to.y),
      width: Math.abs(to.x - from.x),
      height: Math.abs(to.y - from.y),
    };
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (isSubmitting) return;
    setError(undefined);
    const next = point(event);
    setStart(next);
    setDraft({ ...next, width: 1, height: 1 });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (start) setDraft(rectangle(start, point(event)));
  }

  async function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!start || isSubmitting) return;
    const selected = rectangle(start, point(event));
    if (selected.width < 160 || selected.height < 120) {
      setStart(undefined);
      setDraft(undefined);
      return;
    }
    setIsSubmitting(true);
    try {
      await invoke("complete_region_selection", {
        region: { ...selected, x: selected.x + monitorX, y: selected.y + monitorY },
      });
    } catch (reason) {
      setError(`无法保存选区：${String(reason)}`);
      setStart(undefined);
      setDraft(undefined);
      setIsSubmitting(false);
    }
  }

  return (
    <div className="selector" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <div className="selector-help">拖动鼠标选择录屏区域 · 按 Esc 取消</div>
      {error && <div className="selector-error">{error}</div>}
      {draft && (
        <div
          className="selector-box"
          style={{
            left: draft.x / scaleFactor,
            top: draft.y / scaleFactor,
            width: draft.width / scaleFactor,
            height: draft.height / scaleFactor,
          }}
        >
          <span>{draft.width} × {draft.height}</span>
        </div>
      )}
    </div>
  );
}
