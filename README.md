# Atlas — AI Media Node Editor

A node-graph editor for chaining AI image and video generation into visual workflows. Built as a macOS desktop app with Tauri + React, powered by the PixVerse CLI.

> 中文说明请见 [README.zh.md](README.zh.md)

[![Download](https://img.shields.io/github/v/release/miracleagi/media_cavas?label=Download&logo=apple&style=for-the-badge)](https://github.com/miracleagi/media_cavas/releases/latest/download/Atlas_0.9.0_aarch64.dmg)
[![License: MIT NC](https://img.shields.io/badge/License-MIT%20NC-blue?style=for-the-badge)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/Platform-macOS%2012%2B-lightgrey?style=for-the-badge&logo=apple)](https://github.com/miracleagi/media_cavas/releases)

---

## Installation (macOS)

### Step 1 — Install dependencies

Run the setup script to automatically install Node.js, ffmpeg, the PixVerse CLI, and log in to your PixVerse account:

```bash
bash Install-PixVerse.sh
```

> If you see "operation not permitted", grant execute permission first:
> ```bash
> chmod +x Install-PixVerse.sh && ./Install-PixVerse.sh
> ```

The script may prompt for your macOS password (required by Homebrew).

---

### Step 2 — Open Atlas

Double-click **`Atlas.app`**, or drag it from the DMG into your Applications folder and launch it from there.

> If macOS says "cannot verify the developer", go to  
> **System Settings → Privacy & Security → Open Anyway**

---

## Node Types

### Input nodes
| Node | Description |
|------|-------------|
| **Prompt** | Text prompt input |
| **Asset** | Image / video source — pick from local disk or the Library |

### PixVerse generation nodes
| Node | Description |
|------|-------------|
| **Image** | Text-to-image or image-to-image |
| **Video** | Text-to-video or image-to-video |
| **Transition** | Transition video between two images |
| **Reference** | Generate from multiple image / video references |
| **Motion Control** | Drive motion with a reference video |
| **Extend** | Extend an existing video |
| **Upscale** | Upscale a video to higher resolution |
| **Speech** | Add TTS audio to a video |

### Utility nodes
| Node | Description |
|------|-------------|
| **Pick** | Manually choose one result from multiple candidates |
| **ffmpeg** | Local video concatenation / editing |
| **Output** | Save results to a local directory |

---

## Basic Usage

1. Click **`+`** in the top bar to create a new project (templates available)
2. Drag nodes from the left palette onto the canvas
3. Drag from a right-side port to a compatible left-side port to connect nodes (type-checked, cycle-safe)
4. Right-click a node → **Run from here** to run from that node forward
5. Click **Run** (top right) to run the entire graph
6. Click **Stop** to abort a running graph

**Shortcuts:**
- `Backspace / Delete` — remove selected node or edge
- Right-click a node — run / duplicate / delete
- Drag empty canvas — pan
- Click empty canvas — deselect

---

## Configuration

Click **⚙ Config** (top right) to open the settings panel:

- **PixVerse CLI path** — auto-detected in most cases; fill in manually if installed in a non-standard location
- **ffmpeg path** — same as above
- **Default output directory** — where the Output node saves files

---

## Library

Click the **☆** button on any completed node to save its result to the Library.  
Library items can be reused across projects — drag them onto the canvas or pick them inside an Asset node's Inspector panel.

---

## Project Structure

```
Atlas.app                    ← Desktop app (Tauri bundle)
Install-PixVerse.sh              ← One-click dependency installer
dev.command                  ← Development mode launcher (requires Rust)
src/                         ← Frontend source (JSX, no build step needed)
  shared.jsx                 ← Design tokens, icons, shared components
  state.jsx                  ← State management, node templates, Executor interface
  editor.jsx                 ← Canvas: drag, connect, runner
  editor-node.jsx            ← Individual node component
  editor-panels.jsx          ← Top bar, left palette, right Inspector
  editor-app.jsx             ← App root, autosave
  graph.jsx                  ← Edge paths, ports
  scenarios.jsx              ← Project templates
src-tauri/                   ← Rust backend
  src/main.rs                ← Tauri invoke handlers
  src/pixverse.rs            ← PixVerse CLI argument resolution & execution
  src/ffmpeg.rs              ← ffmpeg node execution
  src/thumbs.rs              ← Result parsing & thumbnail download
  src/storage.rs             ← Project file persistence
  src/utils.rs               ← Utility functions
web/                         ← Tauri static asset root (auto-synced from src/)
```

---

## Development

Requires the [Rust toolchain](https://rustup.rs/).

```bash
./dev.command
```

This syncs `src/` → `web/src/` and runs `cargo tauri dev` with hot reload.

### Release build

```bash
cd src-tauri
cargo tauri build
```

Output: `src-tauri/target/release/bundle/macos/`

---

## Data Persistence

Project data is stored in the macOS app data directory (`~/Library/Application Support/com.atlas.app/`).

Projects can be exported as `.atlas.json` files via **`+` → Export** and re-imported at any time.
