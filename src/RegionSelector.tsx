import { useEffect, useState } from "react";
import type { PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Region } from "./types";
import "./RegionSelector.css";

interface SelectorConfig {
  x: number;
  y: number;
  width: number;
  height: number;
  scale_factor: number;
}

export default function RegionSelector() {
  const [start, setStart] = useState<{ x: number; y: number }>();
  const [draft, setDraft] = useState<Region>();
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [config, setConfig] = useState<SelectorConfig>();

  useEffect(() => {
    invoke<SelectorConfig>("get_region_selector_config")
      .then(setConfig)
      .catch((reason) => setError(`Could not load the selector: ${String(reason)}`));
  }, []);

  useEffect(() => {
    const cancel = async (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      try {
        await invoke("cancel_region_selection");
      } catch (reason) {
        setError(`Could not close the selector: ${String(reason)}`);
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);

  function point(event: PointerEvent<HTMLDivElement>) {
    const scale = config?.scale_factor ?? window.devicePixelRatio ?? 1;
    return { x: Math.round(event.clientX * scale), y: Math.round(event.clientY * scale) };
  }

  function rectangle(from: { x: number; y: number }, to: { x: number; y: number }): Region {
    return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (isSubmitting || !config) return;
    setError(undefined);
    const next = point(event);
    setStart(next);
    setDraft({ ...next, width: 1, height: 1 });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (start) setDraft(rectangle(start, point(event)));
  }

  async function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!start || isSubmitting || !config) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const selected = rectangle(start, point(event));
    if (selected.width < 160 || selected.height < 120) {
      setStart(undefined);
      setDraft(undefined);
      return;
    }
    setIsSubmitting(true);
    try {
      await invoke("complete_region_selection", { region: { ...selected, x: selected.x + config.x, y: selected.y + config.y } });
    } catch (reason) {
      setError(`Could not save the selected region: ${String(reason)}`);
      setStart(undefined);
      setDraft(undefined);
      setIsSubmitting(false);
    }
  }

  const scale = config?.scale_factor ?? 1;
  return (
    <div className="selector" tabIndex={0} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <div className="selector-help">Drag to select the recording area · Press Esc to cancel</div>
      {error && <div className="selector-error">{error}</div>}
      {draft && (
        <div className="selector-box" style={{ left: draft.x / scale, top: draft.y / scale, width: draft.width / scale, height: draft.height / scale }}>
          <span>{draft.width} × {draft.height}</span>
        </div>
      )}
    </div>
  );
}
