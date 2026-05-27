# Atlas — local AI media pipeline

A node-graph editor for chaining AI image / video generation through API
calls and local CLI tools. Designed to be wrapped as a Tauri / Electron
desktop app later; today it runs as a static HTML page.

## Run locally on Mac

1. Copy this whole folder anywhere on your Mac.
2. Double-click `run-atlas.command` — it starts a tiny localhost server and
   opens `Atlas.html` in your default browser.
3. Or run it manually:
   ```sh
   ./run-atlas.command
   ```

Everything is static. No build step, no install. The localhost helper is used
for two things:
- serving `src/*.jsx` because current Chrome blocks browser Babel from reading
  local files via `file://`
- running allowed local CLI nodes, currently PixVerse, through `pixverse`

The page loads React + Babel from `unpkg.com`. If you need fully offline, see
**Offline bundling** below.

## What's in the box

- **`Atlas.html`** — the editor (this is the one you use)
- **`run-atlas.command`** — starts the local helper and opens the editor
- **`atlas-helper.mjs`** — localhost helper that serves files and runs PixVerse CLI nodes
- **`atlas-bridge.js`** — browser-side executor bridge to the helper
- **`Atlas Design Study.html`** — the original four-direction exploration
  + component/state studies. Reference only; not the live tool.
- **`src/`** — the source files, loaded directly via `<script type="text/babel">`
- **`design-canvas.jsx`** / **`tweaks-panel.jsx`** — used only by the design study

The editor is in:
| File | What it owns |
| --- | --- |
| `src/shared.jsx`        | Design tokens, icon set, placeholder, button, pill |
| `src/graph.jsx`         | Edge paths, ports, CLI block, node preview (read-only Node for the design study) |
| `src/scenarios.jsx`     | Three reference graphs used as new-project templates |
| `src/state.jsx`         | Reducer, node templates, **Storage** and **Executor** interfaces |
| `src/editor-node.jsx`   | Editable Node — inline-editable prompt/CLI, drag, ports |
| `src/editor.jsx`        | Canvas with drag, connect, run, edges, context menu |
| `src/editor-panels.jsx` | Top bar (tabs), left palette, right inspector, config modal |
| `src/editor-app.jsx`    | App root, hydration, autosave, import/export |

## Current behaviour

- **Multi-project tabs** at the top. `+` opens new-from-template / blank /
  import. Tab name is inline-editable. `×` closes a tab (in-memory; the
  underlying record stays in localStorage until you start over).
- **Drag nodes** by the header. **Drag from any right-side port** to any
  compatible left-side port (type-checked, no cycles). Click an empty
  spot to deselect; drag empty canvas to pan.
- **Inline edit** prompts, CLI command + flags, node titles.
- **Right-click a node** for `Run from here · Duplicate · Delete`. The
  small chip toolbar above a selected node does the same.
- **Backspace / Delete** removes the selected node or edge.
- **Run graph** (top-right) walks the graph in topological order. Today
  PixVerse CLI nodes run through the local helper; non-PixVerse nodes use the
  browser mock executor. Progress is painted onto every node in real time.
- **Config** (top-right) opens a modal with API keys + local binary
  paths. Stored on this machine only (localStorage). Mask/reveal per
  field.
- **Export** downloads the active project as `<slug>.atlas.json`. The
  `+` menu can re-import any such file.

## Persistence

All state is stored at `localStorage["atlas.v1"]`. The format is:

```jsonc
{
  "config": { "apiKeys": { ... }, "binPaths": { ... }, "defaultModel": "..." },
  "projects": [
    { "id": "...", "name": "...", "color": "#...",
      "graph": { "nodes": [...], "edges": [...] },
      "runResults": { "<nodeId>": { "state": "done", "progress": 1 } },
      "modifiedAt": 1700000000000
    }
  ],
  "activeProjectId": "..."
}
```

Exported `.atlas.json` files wrap one project at a time:

```jsonc
{ "format": "atlas-graph-v1", "project": { ...same shape as above... } }
```

## Wiring up real execution (the part you'll need)

### PixVerse CLI image / video generation

This app now includes two executable PixVerse nodes in the left palette:

- `PixVerse · image` — runs text-to-image:
  ```sh
  pixverse create image --prompt "{prompt}" --model qwen-image --quality 1080p --aspect-ratio 16:9 --count 1 --timeout 300 --json
  ```
- `PixVerse · video` — runs text-to-video or image-to-video:
  ```sh
  pixverse create video --prompt "{prompt}" --image "{image}" --model v6 --duration 5 --quality 720p --aspect-ratio 16:9 --count 1 --timeout 600 --json
  ```
  If no upstream image is connected, the helper omits `--image` and the command
  becomes text-to-video.

Setup:

1. Install / update PixVerse CLI:
   ```sh
   npm install -g pixverse
   ```
2. Authenticate once:
   ```sh
   pixverse auth login
   ```
3. Start Atlas with:
   ```sh
   ./run-atlas.command
   ```
4. Build a graph:
   - drag `Prompt`
   - drag `PixVerse · image` or `PixVerse · video`
   - connect `Prompt` text output to the PixVerse node's `prompt` input
   - for image-to-video, connect an upstream image output into the video node's
     `src` input
   - click `Run graph`

The helper only executes CLI nodes whose command is `pixverse`; other legacy
CLI nodes still run as mocks until a broader local command allowlist is added.
PixVerse results are stored in `runResults`, including the raw JSON under
`pixverse` and a normalized preview record under `thumbs`.

You can edit PixVerse parameters directly in the node's CLI args or through the
right inspector. Supported PixVerse image / video modes and parameters are
listed up front in the inspector:

```sh
# Image
T2I: --prompt
I2I: --prompt --image
I2I multi-image: --prompt --images
--model qwen-image
--model gpt-image-2.0
--quality 1080p
--aspect-ratio 16:9
--detail-level low|medium|high
--count 1
--seed 123
--idempotency-key key
--no-wait
--timeout 300

# Video
T2V: --prompt
I2V: --prompt --image
--model v6
--model seedance-2.0-standard
--model veo-3.1-lite
--duration 5
--quality 720p
--aspect-ratio 16:9
--count 1
--seed 123
--audio
--no-audio
--multi-shot
--no-multi-shot
--off-peak
--idempotency-key key
--no-wait
--timeout 600
```

Two interfaces live in `src/state.jsx`:

```js
const LocalStorage = {
  load() { ... },
  save(state) { ... },
};
const Storage = window.AtlasStorage || LocalStorage;

const MockExecutor = {
  estimateMs(node) { ... },
  async runNode(node, deps, ctx, onProgress) { ... },
};
const Executor = window.AtlasExecutor || MockExecutor;
```

To plug in a real executor **without touching the app**, define these
on `window` *before* the app's scripts load:

```html
<script>
  window.AtlasExecutor = {
    async runNode(node, deps, ctx, onProgress) {
      onProgress(0);
      if (node.kind === 'cli') {
        // future Tauri:
        //   const { invoke } = await import('@tauri-apps/api');
        //   return await invoke('run_cli', { bin: node.cli.bin, args: node.cli.args });
        // today: POST to your own localhost helper if you want to test
      }
      if (node.kind === 'gen' && node.provider === 'replicate') {
        const apiKey = ctx.config.apiKeys.replicate;
        // call Replicate REST, poll until done, return result
      }
      onProgress(1);
      return { ok: true };
    }
  };
</script>
<script type="text/babel" src="src/state.jsx"></script>
...
```

The `ctx` passed in already carries:
- `ctx.config` — the same config the user filled in the Config modal
  (API keys + bin paths)
- `ctx.abortRef.current.aborted` — set to `true` when the user hits Stop

Deps (`deps[i].edge`, `deps[i].from`) give you the upstream node so you
can pull its previous output, mount paths, etc.

Return shape:
```js
{ ok: true }                         // done, no further data
{ ok: true, thumbs: [{ seed, label, chosen }, ...] }  // results visible in node body
{ ok: false, error: 'human-readable message' }       // halts downstream
```

`onProgress(0..1)` should be called periodically — the UI paints a
shimmer + progress bar from it.

### Likely Tauri layout (target)

```
src-tauri/
  src/
    main.rs              # invoke handlers: run_cli, save_graph, load_graph
  Cargo.toml
src/
  shared.jsx, graph.jsx, state.jsx, ...   (this folder, unchanged)
Atlas.html               (loads src/* and a thin Tauri bridge)
```

A `tauri-bridge.js` script (loaded before `src/state.jsx`) would set:
```js
window.AtlasStorage = {
  async load()  { return JSON.parse(await invoke('load_graph')); },
  async save(s) { return invoke('save_graph', { state: JSON.stringify(s) }); },
};
window.AtlasExecutor = {
  async runNode(node, deps, ctx, onProgress) {
    if (node.kind === 'cli') return invoke('run_cli', { ... });
    if (node.kind === 'gen') return invoke('proxy_api', { ... });
    ...
  }
};
```

Everything else stays the same.

## Offline bundling

If you need a single self-contained file (no network):

1. Replace each `<script src="https://unpkg.com/...">` in `Atlas.html`
   with a downloaded local copy (`react.development.js`,
   `react-dom.development.js`, `babel.min.js`).
2. The `<script type="text/babel">` references are already local.

For production: precompile JSX with `npx babel src --out-dir build`
and load the plain JS — drops Babel's runtime overhead. Not needed
during design iteration.

## Known things-to-do

- Pan is implemented; zoom is not (use OS zoom for now).
- Asset upload still uses placeholder thumbnails. The drop target is
  there in spirit — wire it to a real `<input type="file">` when you
  hook up Tauri's `dialog.open`.
- The mock executor doesn't actually pipe outputs to downstream nodes.
  When a real executor returns `thumbs`, the editor will display them
  in the node body via `runResults`.
- Backspace inside a text input correctly *does not* delete the node —
  it edits text. Make sure focus is on the canvas (Esc) before pressing
  Delete to remove a node.

## Aesthetic notes

- Inter for UI · JetBrains Mono for everything technical (seeds,
  commands, port labels, prompt text). The mono is load-bearing — it
  signals "this is data, not chrome".
- One accent color (cool blue `#7fc8ff`). Amber for in-progress, green
  for complete, soft red for errors. No gradients except the app mark.
- Ports are typed and colored: image · video · text · file · number ·
  asset. Connections inherit their source port's color.
- Nodes are always 8px-radius cards on a 24px dot grid background.
