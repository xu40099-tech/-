# Screen Studio MVP

Windows-first screen recording editor built with Tauri, React, TypeScript, and Rust.

## What works now

- Desktop app scaffold with Tauri v2 and React.
- Full editor UI for recording, source selection, audio toggles, hotkeys, timeline, zooms, canvas styling, and export settings.
- Browser-based recording fallback using `getDisplayMedia` and `MediaRecorder`.
- Native Windows recording fallback using FFmpeg `gdigrab` when WebView screen capture is unavailable.
- Microphone + system-audio mixing path where the browser capture permission allows it.
- Mouse event recorder for movement, left/right click, double click, wheel, click time, and cursor state within the app session.
- Automatic click zoom generation with smart merge for close repeated clicks.
- Manual zoom creation, zoom deletion, timeline scrubber, edit markers for trim/split/delete/speed/volume.
- Visual styling controls for background, padding, corner radius, shadow, inner stroke, aspect ratios, portrait follow toggle, cursor scale, ripple, and path smoothing.
- Tauri command contracts for:
  - `list_capture_sources`
  - `start_recording`
  - `pause_recording`
  - `resume_recording`
  - `stop_recording`
  - `save_recording_asset`
  - `load_project`
  - `save_project`
  - `export_project`
- Recorded WebM assets are saved to disk from the Tauri app.
- FFmpeg export is wired for MP4 and GIF conversion from the saved recording.

## Current limits

- Native Windows fallback currently records the full desktop. Window and region-specific native capture are still next.
- Global low-level mouse hook is not wired yet. Mouse tracking works inside the running app.
- MP4/GIF export converts the saved recording. Rendering zoom/cursor/style layers into the exported video is the next native composition step.
- Installer bundling can time out while downloading WiX. The release `.exe` build is verified and does not depend on WiX.

## Run the React editor

```bash
npm install
npm run dev -- --host 127.0.0.1
```

Open:

```text
http://127.0.0.1:1420/
```

## Build the React editor

```bash
npm run build
```

## Run the Tauri app

Install Rust first:

```bash
rustup default stable
```

Then run:

```bash
npm run tauri dev
```

On Windows, the easiest path is:

```bash
npm run tauri:dev:win
```

That script loads the Visual Studio C++ build environment before starting Tauri.

## Build the Windows app

```bash
npm run tauri:build:win
```

The release executable is written to:

```text
src-tauri/target/release/screen-studio-mvp.exe
```

Installer bundling can be attempted with:

```bash
npm run tauri:bundle:win
```

Installer output is written under:

```text
src-tauri/target/release/bundle/
```

## Native implementation seams

- Replace `list_capture_sources` in `src-tauri/src/lib.rs` with real Windows display/window enumeration.
- Replace `start_recording` with a Windows.Graphics.Capture pipeline for screen/window/region capture.
- Add WASAPI loopback and microphone capture to the native recorder.
- Add a WH_MOUSE_LL hook for global mouse events and cursor handle sampling.
- Extend `export_project` from raw recording conversion to a full FFmpeg render graph that composites:
  - source recording
  - audio tracks
  - cursor layer
  - click ripple
  - zoom animation
  - background/padding/radius/shadow/stroke
  - aspect-ratio output framing

## Project data

Saved project JSON includes:

- recording config
- style config
- mouse events
- zoom segments
- timeline edits
- export config
- recording asset metadata
