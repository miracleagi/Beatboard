<p align="center">
  <img src="assets/logo.png" width="360" alt="Beatboard logo"/>
</p>

# Beatboard — AI Media Node Editor

A node-graph editor for chaining AI image and video generation into visual workflows. Built as a macOS desktop app with Tauri + React, powered by the PixVerse CLI.

> 中文说明请见 [README.zh.md](README.zh.md)

[![Download](https://img.shields.io/github/v/release/miracleagi/Beatboard?label=Download&logo=apple&style=for-the-badge)](https://github.com/miracleagi/Beatboard/releases/latest/download/Beatboard_0.9.0_aarch64.dmg)
[![License: MIT NC](https://img.shields.io/badge/License-MIT%20NC-blue?style=for-the-badge)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/Platform-macOS%2012%2B-lightgrey?style=for-the-badge&logo=apple)](https://github.com/miracleagi/Beatboard/releases)

---

## Installation (macOS)

### Step 1 — Install Beatboard

Beatboard manages all runtime dependencies itself. It bundles ffmpeg and installs a private copy of the
PixVerse CLI together with a dedicated Node.js runtime inside Beatboard's application-data directory.

**End users do not need Terminal, Homebrew, Node.js/npm, a global PixVerse CLI, or any installation script.**

After opening Beatboard for the first time:

1. Click **⚙ Config**
2. Under **Managed runtimes**, click **Install PixVerse**
3. When it finishes, click **Sign in to PixVerse** and complete login in the browser

Only the in-app PixVerse runtime download requires internet access. The managed runtime is retained under
`~/Library/Application Support/com.beatboard.app/runtime/` across Beatboard.app upgrades.

---

### Step 2 — Open Beatboard

Double-click **`Beatboard.app`**, or drag it from the DMG into your Applications folder and launch it from there.

> If macOS says "cannot verify the developer", go to  
> **System Settings → Privacy & Security → Open Anyway**

---

## Node Types

### Input nodes
| Node | Description |
|------|-------------|
| **Prompt** | Text prompt input |
| **Asset** | Image / video / audio source — pick from local disk or the Library |

### Generation nodes
Each generator node picks a provider and a model in the Inspector. Every node type runs on PixVerse;
**Generate image** and **Generate video** can also run on [fal.ai](https://fal.ai) (FLUX, Nano Banana, Kling, Veo, Hailuo) —
add your fal.ai API key under **⚙ Config → Provider API keys** (stored in the macOS Keychain; runs are billed to your fal account).
The settings each one offers come from `src/providers/pixverse.json` and `src/providers/fal.json`.

| Node | Type (MCP) | Description |
|------|------------|-------------|
| **Generate image** | `image.generate` | Text-to-image or image-to-image |
| **Generate video** | `video.generate` | Text-to-video or image-to-video |
| **Transition** | `video.transition` | Transition video across 2–3 keyframes |
| **Reference to video** | `video.reference` | Generate from multiple image / video / audio references |
| **Motion control** | `video.motion_control` | Drive motion with a reference video |
| **Extend video** | `video.extend` | Extend an existing video |
| **Upscale video** | `video.upscale` | Upscale a video to higher resolution |
| **Modify video** | `video.modify` | Modify a video with a prompt and reference images |
| **Voice (TTS)** | `audio.speech` | Generate standalone text-to-speech audio |
| **Music** | `audio.music` | Generate music with custom, automatic, or no lyrics |
| **Template / effect** | `provider.template` | Run a PixVerse template/effect by template ID |

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

**Compare models:** select a generator node → **Compare with other models…** in the Inspector. Beatboard adds a copy per model (same inputs), feeds them all into a Pick node, and routes the Pick to whatever came after the original — run the Pick to see the results side by side. A variant that fails doesn't block the others.

**Spending:** before a run that submits more paid generations than your limit (default 3, **⚙ Config → Spending**), Beatboard asks first. PixVerse credits charged are shown per node after a run. If Beatboard quits while a fal.ai run is in flight, the node shows **Resume**, which collects the result without paying again.

Solid edges are required dependencies: every upstream node must have a usable result before its downstream node can run. Dashed edges are optional references and do not gate execution. **Run from here** automatically runs missing ancestors while reusing still-valid cached outputs.

**Shortcuts:**
- `Backspace / Delete` — remove selected node or edge
- Right-click a node — run / duplicate / delete
- Drag empty canvas — pan
- Click empty canvas — deselect

---

## Configuration

Click **⚙ Config** (top right) to open the settings panel:

- **Managed runtimes** — inspect bundled ffmpeg, install/update Beatboard's private PixVerse runtime, and sign in
- **Advanced runtime overrides** — optionally use a custom ffmpeg or PixVerse executable for debugging
- **Default output directory** — where the Output node saves files

---

## Connect an AI agent (MCP)

While the app is open, Beatboard runs a local [MCP](https://modelcontextprotocol.io) server, so AI coding
agents (Claude Code, Cursor, …) can build and run media pipelines on the canvas — live, while you watch.

```bash
# Claude Code
claude mcp add --transport http beatboard http://127.0.0.1:4923/mcp
```

Then ask your agent something like *"storyboard a 30-second product teaser: generate 4 stills,
animate each, stitch them together"* — the graph grows on the canvas in real time, and every
agent edit is undoable with ⌘Z.

**Tools exposed:** `describe_capabilities` · `list_projects` · `create_project` · `switch_project` · `delete_project` · `get_graph` · `add_node` · `connect_nodes` · `set_params` · `compare_node` · `run_node` · `get_node_result`

- The server listens on `127.0.0.1:4923` (override with the `BEATBOARD_MCP_PORT` env var), only while Beatboard is running, and never accepts remote connections.
- Generation nodes run through the PixVerse CLI managed privately by Beatboard and your PixVerse account — exactly as if you clicked Run.
- **Pick** nodes pause the run for a human choice; the agent is told to wait for you.

---

## Library

Click the **☆** button on any completed node to save its result to the Library.  
Library items can be reused across projects — drag them onto the canvas or pick them inside an Asset node's Inspector panel.

---

## Project Structure

```
Beatboard.app                    ← Desktop app (Tauri bundle)
dev.command                  ← Development mode launcher (requires Rust)
src/                         ← Frontend source (JSX, no build step needed)
  shared.jsx                 ← Design tokens, icons, shared components
  state.jsx                  ← State management, node templates, Executor interface
  task-model.jsx             ← Generator (task) nodes: provider catalog, params, legacy migration
  providers/                 ← Capability registry + provider manifests (JSON, also read by Rust)
  editor.jsx                 ← Canvas: drag, connect, runner
  editor-node.jsx            ← Individual node component
  editor-panels.jsx          ← Top bar, left palette, right Inspector
  editor-app.jsx             ← App root, autosave
  mcp-bridge.jsx             ← MCP ops → live graph (agent bridge)
  graph.jsx                  ← Edge paths, ports
  scenarios.jsx              ← Project templates
src-tauri/                   ← Rust backend
  src/main.rs                ← Tauri invoke handlers
  src/mcp.rs                 ← MCP server (agents drive the canvas)
  src/runtime.rs             ← Bundled ffmpeg + Beatboard-managed PixVerse runtime
  src/providers/             ← Provider trait, input resolution, cancellation, catalog validation
  src/providers/pixverse/    ← PixVerse provider: task → CLI argv, execution, legacy argv nodes
  src/providers/fal/         ← fal.ai provider: queue API, uploads, downloads
  src/providers/secrets.rs   ← Provider API keys (macOS Keychain)
  src/ffmpeg.rs              ← ffmpeg node execution
  src/thumbs.rs              ← Result parsing & thumbnail download
  src/storage.rs             ← Project file persistence
  src/utils.rs               ← Utility functions
  runtime/                   ← Pinned PixVerse npm lock (no node_modules committed)
web/                         ← Tauri static asset root (auto-synced from src/)
scripts/                     ← Developer-only reproducible release-sidecar build scripts
```

---

## Development

The commands in this section are only for contributors building Beatboard from source; installed Beatboard.app
users do not need them.

Requires the [Rust toolchain](https://rustup.rs/) and Tauri 1 CLI:

```bash
cargo install tauri-cli --version '^1' --locked
```

```bash
./dev.command
```

This syncs `src/` → `web/src/` and runs `cargo tauri dev` with hot reload.

### Release build

```bash
./scripts/build-bundled-ffmpeg.sh
cd src-tauri
cargo tauri build
```

Output: `src-tauri/target/release/bundle/macos/`

The release script builds an LGPL-only ffmpeg sidecar from the pinned official FFmpeg `n8.1.2`
commit, disables GPL/nonfree components, prefers Apple's VideoToolbox encoder, and falls back to the
LGPL MPEG-4 encoder. Build once on each target Mac architecture; generated files under
`src-tauri/binaries/` are intentionally not committed.

---

## Data Persistence

Project data is stored in the macOS app data directory (`~/Library/Application Support/com.beatboard.app/`).

Projects can be exported as `.beatboard.json` files via **`+` → Export** and re-imported at any time.

> **Upgrading from Atlas (0.9.0 or earlier)?** Beatboard was renamed from Atlas, which changes the app
> data directory. On first launch it imports your saved projects and moves the managed runtime across
> automatically — nothing to do by hand. Media generated under the old name stays in place and keeps
> rendering; once you have confirmed everything came over, the old
> `~/Library/Application Support/com.atlas.pipeline/` directory can be deleted.
