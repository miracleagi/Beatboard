// Central state + storage + executor.
//
// Two interfaces are abstracted so a future Tauri / Electron wrapper can swap
// the implementation without touching anything else:
//   - Storage:  load/save full app state. localStorage now; FS later.
//   - Executor: run a single node. Mock with timers now; real API/subprocess later.
//
// One reducer owns everything. Persistence runs after every dispatch (debounced).

// ---------- NODE TEMPLATES ----------
// Nodes available in the palette. Only includes nodes with working Rust backends.
// To add a new provider: implement it in src-tauri/src/, then add a template here.
const NODE_TEMPLATES = [
  // ── Inputs ────────────────────────────────────────────────────────────────
  { kind: 'prompt', title: 'Prompt', group: 'Inputs',
    spawn: () => ({
      kind: 'prompt', title: 'Prompt', w: 196, badge: 'text',
      prompt: 'describe what to generate',
      ports: [{ kind: 'text', side: 'right', top: 52 }],
      footer: { left: 'edit me', right: '·' },
    }),
  },
  { kind: 'asset', title: 'Asset / Reference', group: 'Inputs',
    spawn: () => ({
      kind: 'asset', title: 'asset.png', w: 180, badge: 'asset',
      thumbs: [{ seed: `as${Math.random()}`, label: 'unnamed' }],
      ports: [{ kind: 'image', side: 'right', top: 36 }],
      footer: { left: 'dropped · just now', right: 'ready' },
    }),
  },

  // ── PixVerse ──────────────────────────────────────────────────────────────
  { kind: 'cli', title: 'PixVerse · image', group: 'PixVerse',
    spawn: () => ({
      kind: 'cli', title: 'PixVerse image', w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        args: ['create', 'image', '--prompt', '{prompt}', '--image', '{image}', '--model', 'qwen-image',
               '--quality', '1080p', '--aspect-ratio', '16:9', '--count', '1',
               '--timeout', '300', '--json'],
        fields: [{ k: 'mode', v: 'T2I/I2I' }, { k: 'model', v: 'qwen-image' },
                 { k: 'quality', v: '1080p' }, { k: 'ratio', v: '16:9' }],
      },
      ports: [
        { kind: 'image', side: 'left', top: 44, label: 'src' },
        { kind: 'text', side: 'left', top: 68, label: 'prompt' },
        { kind: 'image', side: 'right', top: 58 },
      ],
      footer: { left: 'pixverse create image', right: '— idle' },
    }),
  },
  { kind: 'cli', title: 'PixVerse · video', group: 'PixVerse',
    spawn: () => ({
      kind: 'cli', title: 'PixVerse video', w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        args: ['create', 'video', '--prompt', '{prompt}', '--image', '{image}',
               '--model', 'v6', '--duration', '5', '--quality', '720p',
               '--aspect-ratio', '16:9', '--count', '1', '--timeout', '600', '--json'],
        fields: [{ k: 'mode', v: 'T2V/I2V' }, { k: 'model', v: 'v6' },
                 { k: 'duration', v: '5s' }, { k: 'ratio', v: '16:9' }],
      },
      ports: [
        { kind: 'image', side: 'left', top: 44, label: 'src' },
        { kind: 'text', side: 'left', top: 68, label: 'prompt' },
        { kind: 'video', side: 'right', top: 58 },
      ],
      footer: { left: 'pixverse create video', right: '— idle' },
    }),
  },

  { kind: 'cli', title: 'PixVerse · transition', group: 'PixVerse',
    spawn: () => ({
      kind: 'cli', title: 'PixVerse transition', w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        // --images accepts multiple values (CLI variadic): pass both frames + optional prompt
        args: ['create', 'transition', '--images', '{from}', '{to}',
               '--prompt', '{prompt}',
               '--model', 'v6', '--quality', '720p',
               '--timeout', '600', '--json'],
        fields: [{ k: 'mode', v: 'transition' }, { k: 'model', v: 'v6' },
                 { k: 'quality', v: '720p' }],
      },
      ports: [
        { kind: 'image', side: 'left', top: 44, label: 'from' },
        { kind: 'image', side: 'left', top: 68, label: 'to' },
        { kind: 'text',  side: 'left', top: 92, label: 'prompt' },
        { kind: 'video', side: 'right', top: 68 },
      ],
      footer: { left: 'pixverse create transition', right: '— idle' },
    }),
  },
  { kind: 'cli', title: 'PixVerse · reference', group: 'PixVerse',
    spawn: () => ({
      kind: 'cli', title: 'PixVerse reference', w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        // {images} expands to ALL connected image deps (up to 7); {videos} for video refs
        args: ['create', 'reference',
               '--images', '{images}',
               '--videos', '{videos}',
               '--prompt', '{prompt}',
               '--model', 'v6', '--quality', '720p', '--aspect-ratio', '16:9',
               '--timeout', '600', '--json'],
        fields: [{ k: 'mode', v: 'reference' }, { k: 'model', v: 'v6' },
                 { k: 'quality', v: '720p' }, { k: 'ratio', v: '16:9' }],
      },
      ports: [
        { kind: 'image', side: 'left', top: 44,  label: 'img 1' },
        { kind: 'image', side: 'left', top: 68,  label: 'img 2' },
        { kind: 'image', side: 'left', top: 92,  label: 'img 3' },
        { kind: 'video', side: 'left', top: 116, label: 'vid ref' },
        { kind: 'text',  side: 'left', top: 140, label: 'prompt' },
        { kind: 'video', side: 'right', top: 92 },
      ],
      footer: { left: 'pixverse create reference', right: '— idle' },
    }),
  },
  { kind: 'cli', title: 'PixVerse · motion control', group: 'PixVerse',
    spawn: () => ({
      kind: 'cli', title: 'PixVerse motion control', w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        // --image = character image; --video = motion reference (no --aspect-ratio supported)
        args: ['create', 'motion-control', '--image', '{from}', '--video', '{to}',
               '--model', 'v5.6', '--quality', '720p',
               '--timeout', '600', '--json'],
        fields: [{ k: 'mode', v: 'motion-control' }, { k: 'model', v: 'v5.6' },
                 { k: 'quality', v: '720p' }],
      },
      ports: [
        { kind: 'image', side: 'left', top: 44, label: 'char' },
        { kind: 'video', side: 'left', top: 68, label: 'motion' },
        { kind: 'video', side: 'right', top: 58 },
      ],
      footer: { left: 'pixverse create motion-control', right: '— idle' },
    }),
  },
  { kind: 'cli', title: 'PixVerse · extend', group: 'PixVerse',
    spawn: () => ({
      kind: 'cli', title: 'PixVerse extend', w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        // --video accepts file path, URL, or video ID; {video_id} = cloud ID if available, else local path
        args: ['create', 'extend', '--video', '{video_id}',
               '--prompt', '{prompt}',
               '--model', 'v6', '--timeout', '600', '--json'],
        fields: [{ k: 'mode', v: 'extend' }, { k: 'model', v: 'v6' }],
      },
      ports: [
        { kind: 'video', side: 'left', top: 44, label: 'video' },
        { kind: 'text',  side: 'left', top: 68, label: 'prompt' },
        { kind: 'video', side: 'right', top: 58 },
      ],
      footer: { left: 'pixverse create extend', right: '— idle' },
    }),
  },
  { kind: 'cli', title: 'PixVerse · upscale', group: 'PixVerse',
    spawn: () => ({
      kind: 'cli', title: 'PixVerse upscale', w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        // --video accepts file path, URL, or video ID
        args: ['create', 'upscale', '--video', '{video_id}',
               '--quality', '1080p', '--timeout', '600', '--json'],
        fields: [{ k: 'mode', v: 'upscale' }, { k: 'quality', v: '1080p' }],
      },
      ports: [
        { kind: 'video', side: 'left', top: 52, label: 'video' },
        { kind: 'video', side: 'right', top: 52 },
      ],
      footer: { left: 'pixverse create upscale', right: '— idle' },
    }),
  },
  { kind: 'cli', title: 'PixVerse · speech', group: 'PixVerse',
    spawn: () => ({
      kind: 'cli', title: 'PixVerse speech', w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        // lip-sync TTS: --video = source, --tts-text = script text
        args: ['create', 'speech', '--video', '{video_id}',
               '--tts-text', '{prompt}',
               '--model', 'v5', '--timeout', '600', '--json'],
        fields: [{ k: 'mode', v: 'speech' }, { k: 'model', v: 'v5' }],
      },
      ports: [
        { kind: 'video', side: 'left', top: 44, label: 'video' },
        { kind: 'text',  side: 'left', top: 68, label: 'script' },
        { kind: 'video', side: 'right', top: 58 },
      ],
      footer: { left: 'pixverse create speech', right: '— idle' },
    }),
  },

  // ── Modifiers ─────────────────────────────────────────────────────────────
  { kind: 'select', title: 'Pick · manual', group: 'Modifiers',
    spawn: () => ({
      kind: 'select', title: 'Pick', w: 188, badge: 'manual',
      thumbs: [],
      ports: [
        { kind: 'image', side: 'left', top: 96, label: 'in' },
        { kind: 'image', side: 'right', top: 96, label: 'out' },
      ],
      footer: { left: 'pick #—', right: '★' },
    }),
  },

  // ── Compose ───────────────────────────────────────────────────────────────
  { kind: 'cli', title: 'ffmpeg · compose', group: 'Compose',
    spawn: () => ({
      kind: 'cli', title: 'ffmpeg · compose', w: 244, badge: 'cli · local',
      cli: {
        bin: 'ffmpeg', cmd: 'ffmpeg',
        args: ['connected videos', '-filter_complex concat', '-c:v libx264 -crf 18', '{out}.mp4'],
        fields: [{ k: 'in', v: 'multi' }, { k: 'mode', v: 'concat' },
                 { k: 'crf', v: '18' }, { k: 'fps', v: '24' }],
      },
      ports: [
        { kind: 'video', side: 'left', top: 60, label: 'clips' },
        { kind: 'file', side: 'left', top: 96, label: 'aud' },
        { kind: 'video', side: 'right', top: 72 },
      ],
      footer: { left: 'watches inputs', right: '— idle' },
    }),
  },

  // ── Outputs ───────────────────────────────────────────────────────────────
  { kind: 'output', title: 'Output', group: 'Outputs',
    spawn: () => ({
      kind: 'output', title: 'output.mp4', w: 196, badge: 'output',
      thumbs: [],
      ports: [{ kind: 'image', side: 'left', top: 60 }],
      footer: { left: '1920 × 1080', right: '— idle' },
    }),
  },
];

// ---------- STORAGE ABSTRACTION ----------
// Replace `LocalStorage` with a Tauri / Electron file-system adapter later. The
// shape stays the same; the editor never touches the impl directly.
const LocalStorage = {
  KEY: 'atlas.v1',
  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { console.warn('storage load failed', e); return null; }
  },
  save(state) {
    try { localStorage.setItem(this.KEY, JSON.stringify(state)); }
    catch (e) { console.warn('storage save failed', e); }
  },
};

// Future-friendly: swap by overriding window.Storage before the app mounts.
const Storage = window.AtlasStorage || LocalStorage;

// ---------- EXECUTOR ABSTRACTION ----------
// Resolves a node into a result. Mock: just sleeps proportional to estimated
// duration, periodically reporting progress. Real impl (Tauri) will replace
// the body with API calls / subprocess.spawn.
function resultThumbs(result) {
  if (!result) return [];
  if (Array.isArray(result.thumbs)) return result.thumbs;
  const url = result.image_url || result.imageUrl || result.video_url || result.videoUrl ||
    result.url || result.src || result.path || result.output || result.file ||
    result.file_path || result.filePath || result.local_path || result.localPath;
  const isVideo = !!(result.video_url || result.videoUrl) || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(url || ''));
  return url ? [{ seed: url, url, label: isVideo ? 'video' : 'image', type: isVideo ? 'video' : 'image' }] : [];
}

function sourceThumbs(dep) {
  if (dep.from?.kind === 'select' && Array.isArray(dep.from?.thumbs) && dep.from.thumbs.length) return dep.from.thumbs;
  const thumbs = resultThumbs(dep.result);
  return thumbs.length ? thumbs : (Array.isArray(dep.from?.thumbs) ? dep.from.thumbs : []);
}

function sourceOutputIndex(dep) {
  const ports = dep.from?.ports || [];
  let outputIndex = -1;
  let found = -1;
  ports.forEach((port, index) => {
    if (port.side !== 'right') return;
    outputIndex += 1;
    if (index === dep.edge?.from?.port) found = outputIndex;
  });
  return found;
}

function chosenThumb(thumbs, selectedIndex) {
  const idx = Number.isFinite(selectedIndex) ? selectedIndex : thumbs.findIndex(t => t.chosen);
  return thumbs[Math.max(0, idx)] || thumbs[0];
}

function upstreamThumbs(deps, options = {}) {
  const out = [];
  (deps || []).forEach(dep => {
    const thumbs = sourceThumbs(dep);
    if (!thumbs.length) return;
    if (dep.from?.kind === 'select') {
      const selectedIndex = dep.from.selectedIndex ?? dep.result?.selectedIndex;
      const picked = chosenThumb(thumbs, selectedIndex);
      if (picked) out.push({ ...picked, chosen: true });
      return;
    }
    if (options.forSelect && (dep.from?.kind === 'gen' || dep.from?.kind === 'motion' || dep.from?.kind === 'cli')) {
      out.push(...thumbs.map((thumb, i) => ({ ...thumb, sourceIndex: i })));
      return;
    }
    const outputIndex = sourceOutputIndex(dep);
    if (outputIndex >= 0 && thumbs[outputIndex]) out.push({ ...thumbs[outputIndex], sourceIndex: outputIndex });
    else out.push(...thumbs);
  });
  return out;
}

function mockPassthroughResult(node, deps) {
  // Asset nodes expose their own thumbs as the result so downstream nodes
  // can reliably read dep.result.thumbs (in addition to dep.from.thumbs).
  if (node.kind === 'asset') {
    // Only pass through thumbs that have a real media source (path or non-seed url).
    const assetThumbs = (node.thumbs || []).filter(t => {
      if (!t) return false;
      const path = t.path || t.local_path || t.localPath || t.file || '';
      if (path && String(path).trim().startsWith('/')) return true;
      const url = t.url || t.src || '';
      return url && /^(https?:|atlasmedia:|asset:|data:|blob:)/i.test(String(url));
    });
    return assetThumbs.length
      ? { thumbs: assetThumbs.map((t, i) => ({ ...t, chosen: i === 0 })) }
      : null;
  }
  const thumbs = upstreamThumbs(deps, { forSelect: node.kind === 'select' });
  if (!thumbs.length) return null;
  if (node.kind === 'select') {
    const selectedIndex = Math.min(thumbs.length - 1, Math.max(0, node.selectedIndex ?? thumbs.findIndex(t => t.chosen) ?? 0));
    return { selectedIndex, thumbs: thumbs.map((thumb, i) => ({ ...thumb, chosen: i === selectedIndex })) };
  }
  if (node.kind === 'output') {
    return { thumbs: thumbs.slice(0, 4).map((t, i) => ({ ...t, chosen: i === 0 })) };
  }
  if (node.kind === 'cli') {
    const cmd = String(node.cli?.cmd || node.cli?.bin || '').trim().split(/\s+/)[0].split(/[\\/]/).pop();
    if (cmd === 'ffmpeg') {
      const videos = thumbs.filter(t => t.type === 'video' || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(t.url || t.path || t.seed || '')));
      const inputs = videos.length ? videos : thumbs;
      const seed = `ffmpeg-compose:${node.id || node.title || 'ff'}:${inputs.map(t => t.seed || t.url || t.path || t.id || t.label).join('|')}`;
      return {
        thumbs: [{
          seed,
          type: 'video',
          label: `compose · ${inputs.length} clips`,
          chosen: true,
          sources: inputs.map(t => ({ seed: t.seed, label: t.label, url: t.url, path: t.path, id: t.id })),
        }],
      };
    }
    return { thumbs: thumbs.slice(0, 4).map((t, i) => ({ ...t, label: node.title || t.label, chosen: i === 0 })) };
  }
  if (node.kind === 'motion') {
    const motionKey = `${node.id || node.title || 'motion'}:${node.motionPrompt || ''}:${thumbs[0].seed || thumbs[0].url || thumbs[0].id || ''}`;
    const motionLabel = node.motionPrompt
      ? `${node.title || 'video'} · ${String(node.motionPrompt).slice(0, 28)}`
      : (node.title || 'video');
    return { thumbs: [{ ...thumbs[0], seed: motionKey, type: 'video', label: motionLabel, chosen: true }] };
  }
  return null;
}

const MockExecutor = {
  estimateMs(node) {
    if (node.kind === 'prompt' || node.kind === 'asset' || node.kind === 'output') return 200;
    if (node.kind === 'select') return 600;
    if (node.kind === 'cli') return 1400;
    if (node.kind === 'motion') return 2400;
    if (node.kind === 'gen') return 1800;
    return 1000;
  },
  // Periodically calls onProgress(0..1). Returns Promise<{ ok, error? }>.
  async runNode(node, deps, ctx, onProgress) {
    const total = this.estimateMs(node);
    const tickEvery = 60;
    const ticks = Math.max(1, Math.floor(total / tickEvery));
    for (let i = 0; i <= ticks; i++) {
      const aborted = ctx.aborted || ctx.abortRef?.current?.aborted;
      if (aborted) return { ok: false, error: 'aborted' };
      onProgress(i / ticks);
      await new Promise(r => setTimeout(r, tickEvery));
    }
    // Random sprinkle of failure for cli without bin configured
    if (node.kind === 'cli' && node.cli && node.cli.bin && node.cli.bin.startsWith('~/') && Math.random() < 0.06) {
      return { ok: false, error: `ENOENT · ${node.cli.bin} not found. Set bin path in Config.` };
    }
    return { ok: true, ...(mockPassthroughResult(node, deps) || {}) };
  },
};

const Executor = window.AtlasExecutor || MockExecutor;

// ---------- INITIAL STATE ----------
function makeDefaultProjects() {
  // Use the scenarios but strip baked execution states so they're fresh.
  const cleanGraph = (sc) => normalizeGraphPorts({
    nodes: sc.nodes.map(n => {
      const { state, progress, ...rest } = n;
      return rest;
    }),
    edges: sc.edges.map(e => ({ ...e })),
  });
  return [
    { id: 'p_film', name: 'Short Film', color: '#7fc8ff', outputDir: '', graph: cleanGraph(SCENARIO_ASSEMBLY), modifiedAt: Date.now(), runResults: {} },
    { id: 'p_img', name: 'Single Image', color: '#f4c47a', outputDir: '', graph: cleanGraph(SCENARIO_ITERATE), modifiedAt: Date.now(), runResults: {} },
    { id: 'p_vid', name: 'Image to Video', color: '#8ed4a8', outputDir: '', graph: cleanGraph(SCENARIO_BATCH), modifiedAt: Date.now(), runResults: {} },
  ];
}

function makeInitialState() {
  return {
    config: {
      apiKeys: {
        openai: '', google: '', piapi: '', replicate: '', fal: '',
      },
      binPaths: {
        ffmpeg: 'ffmpeg',
        'real-esrgan': '~/bin/realesrgan-ncnn-vulkan',
        rife: '~/bin/rife-ncnn-vulkan',
        pixverse: 'pixverse',
        sh: 'sh',
      },
      defaultModel: 'flux.1-dev',
    },
    projects: makeDefaultProjects(),
    activeProjectId: 'p_film',
    library: [],   // [{ id, projId, projName, projColor, nodeId, thumb, collectedAt }]
    ui: {
      // selection
      selectedNodeId: null,
      selectedEdgeIdx: null,
      // pan & zoom
      panX: 0, panY: 0, zoom: 1,
      // ephemeral overlays
      configOpen: false,
      paletteOpen: true,
      inspectorOpen: true,
      runState: null,        // { current: nodeId, t: 0..1, order: [], results: {} }
      contextMenu: null,     // { x, y, target: { kind: 'node'|'edge', id|idx } }
      toast: null,
    },
  };
}

// ---------- REDUCER ----------
function appReducer(state, action) {
  switch (action.type) {
    case 'HYDRATE':
      return action.state
        ? { ...action.state, library: action.state.library || [], projects: action.state.projects.map(p => ({ ...p, outputDir: p.outputDir || '', graph: normalizeGraphPorts(p.graph) })) }
        : state;
    case 'LIBRARY_ADD': {
      const { item } = action;
      if ((state.library || []).some(x => x.id === item.id)) return state;
      return { ...state, library: [item, ...(state.library || [])] };
    }
    case 'LIBRARY_REMOVE':
      return { ...state, library: (state.library || []).filter(x => x.id !== action.id) };
    case 'SET_CONFIG':
      return { ...state, config: { ...state.config, ...action.patch } };
    case 'SET_API_KEY':
      return { ...state, config: { ...state.config, apiKeys: { ...state.config.apiKeys, [action.key]: action.value } } };
    case 'SET_BIN_PATH':
      return { ...state, config: { ...state.config, binPaths: { ...state.config.binPaths, [action.key]: action.value } } };
    case 'NEW_PROJECT': {
      const id = `p_${Date.now().toString(36)}`;
      const next = { id, name: action.name || 'Untitled', color: action.color || '#7fc8ff',
        graph: normalizeGraphPorts(action.graph || { nodes: [], edges: [] }),
        outputDir: action.outputDir || '',
        modifiedAt: Date.now(), runResults: {} };
      return { ...state, projects: [...state.projects, next], activeProjectId: id,
        ui: { ...state.ui, selectedNodeId: null, runState: null }
      };
    }
    case 'IMPORT_PROJECT': {
      const id = `p_${Date.now().toString(36)}`;
      const imported = action.project;
      const next = {
        id,
        name: imported.name || 'Imported',
        color: imported.color || '#9aa9c2',
        outputDir: imported.outputDir || '',
        graph: normalizeGraphPorts(imported.graph || { nodes: [], edges: [] }),
        modifiedAt: Date.now(),
        runResults: imported.runResults || {},
      };
      return { ...state, projects: [...state.projects, next], activeProjectId: id };
    }
    case 'CLOSE_PROJECT': {
      const idx = state.projects.findIndex(p => p.id === action.id);
      if (idx === -1) return state;
      const remaining = state.projects.filter(p => p.id !== action.id);
      if (remaining.length === 0) {
        const blank = { id: `p_${Date.now().toString(36)}`, name: 'Untitled', color: '#7fc8ff',
          outputDir: '',
          graph: { nodes: [], edges: [] }, modifiedAt: Date.now(), runResults: {} };
        return { ...state, projects: [blank], activeProjectId: blank.id };
      }
      const newActive = state.activeProjectId === action.id
        ? remaining[Math.max(0, idx - 1)].id
        : state.activeProjectId;
      return { ...state, projects: remaining, activeProjectId: newActive };
    }
    case 'SWITCH_PROJECT':
      return { ...state, activeProjectId: action.id,
        ui: { ...state.ui, selectedNodeId: null, runState: null, contextMenu: null } };
    case 'RENAME_PROJECT':
      return { ...state, projects: state.projects.map(p =>
        p.id === action.id ? { ...p, name: action.name, modifiedAt: Date.now() } : p) };
    case 'SET_PROJECT_OUTPUT_DIR': {
      const targetProjectId = action.projectId || state.activeProjectId;
      return {
        ...state,
        projects: state.projects.map(p =>
          p.id === targetProjectId ? { ...p, outputDir: action.value || '', modifiedAt: Date.now() } : p),
      };
    }

    case 'UNDO_GRAPH': {
      // Restore a previous graph snapshot (used by Cmd+Z undo).
      return {
        ...state,
        projects: state.projects.map(p =>
          p.id === action.projectId
            ? { ...p, graph: normalizeGraphPorts(action.graph), modifiedAt: Date.now() }
            : p),
        ui: { ...state.ui, selectedNodeId: null, selectedEdgeIdx: null },
      };
    }

    case 'PATCH_GRAPH': {
      // Replace the active project's graph with a patched version.
      // Also clear any stale runResults for newly added nodes so that recycled
      // node IDs don't inherit results from a previously deleted node.
      return {
        ...state,
        projects: state.projects.map(p => {
          if (p.id !== state.activeProjectId) return p;
          const oldIds = new Set((p.graph?.nodes || []).map(n => n.id));
          const newGraph = normalizeGraphPorts(action.fn(p.graph));
          const addedIds = (newGraph.nodes || []).map(n => n.id).filter(id => !oldIds.has(id));
          const runResults = addedIds.length
            ? Object.fromEntries(Object.entries(p.runResults || {}).filter(([id]) => !addedIds.includes(id)))
            : (p.runResults || {});
          return { ...p, graph: newGraph, runResults, modifiedAt: Date.now() };
        }),
      };
    }
    case 'SET_RUN_RESULT': {
      const targetProjectId = action.projectId || state.activeProjectId;
      return {
        ...state,
        projects: state.projects.map(p =>
          p.id === targetProjectId
            ? { ...p, runResults: { ...p.runResults, [action.nodeId]: action.result } }
            : p),
      };
    }
    case 'CLEAR_RUN_RESULTS': {
      const targetProjectId = action.projectId || state.activeProjectId;
      return {
        ...state,
        projects: state.projects.map(p => {
          if (p.id !== targetProjectId) return p;
          // Clear persisted results AND wipe any run-generated thumbs that were
          // cached directly onto graph nodes (cli/gen/motion nodes when the user
          // clicks a thumbnail, select nodes when picking, output nodes).
          // Only 'asset' and 'prompt' nodes keep their thumbs — those are
          // permanent inputs, not outputs of a run.
          const cleanedNodes = p.graph.nodes.map(n => {
            if (n.kind === 'asset' || n.kind === 'prompt') return n;
            const cleared = { ...n, thumbs: [] };
            if (n.kind === 'select') cleared.selectedIndex = undefined;
            return cleared;
          });
          return {
            ...p,
            runResults: {},
            graph: { ...p.graph, nodes: cleanedNodes },
          };
        }),
      };
    }

    case 'UI_PATCH':
      return { ...state, ui: { ...state.ui, ...action.patch } };
    default:
      return state;
  }
}

// ---------- HELPERS ----------
function nodeById(graph, id) {
  return graph.nodes.find(n => n.id === id);
}

function nodeDisplayWidth(node) {
  const minByKind = {
    select: 188,
    output: 196,
    prompt: 196,
  };
  return Math.max(node?.w || 0, minByKind[node?.kind] || 0);
}

function isPixVerseCliNode(node) {
  const cmd = String(node?.cli?.cmd || node?.cli?.bin || '').trim().split(/\s+/)[0].split(/[\\/]/).pop();
  return node?.kind === 'cli' && cmd === 'pixverse';
}

function isFfmpegCliNode(node) {
  const cmd = String(node?.cli?.cmd || node?.cli?.bin || '').trim().split(/\s+/)[0].split(/[\\/]/).pop();
  return node?.kind === 'cli' && cmd === 'ffmpeg';
}

function singleOutputPort(node, kind) {
  const firstRight = (node.ports || []).find(p => p.side === 'right');
  const label = firstRight?.label && firstRight.label.startsWith('·') ? undefined : firstRight?.label;
  return {
    kind,
    side: 'right',
    top: firstRight?.top || (kind === 'video' ? 58 : 60),
    ...(label ? { label } : {}),
  };
}

function normalizedNodePorts(node) {
  if (!node) return [];
  if (node.kind === 'select') {
    return [
      { kind: 'image', side: 'left', top: 96, label: 'in' },
      { kind: 'image', side: 'right', top: 96, label: 'out' },
    ];
  }
  if (node.kind === 'gen') {
    const left = (node.ports || []).filter(p => p.side === 'left');
    return [...left, singleOutputPort(node, 'image')];
  }
  if (node.kind === 'motion') {
    const left = (node.ports || []).filter(p => p.side === 'left');
    return [...left, singleOutputPort(node, 'video')];
  }
  if (isPixVerseCliNode(node)) {
    const args = node.cli?.args || [];
    // args[1] is the subcommand (image, video, transition, reference, …)
    // Everything except 'image' produces video output.
    const VIDEO_SUBS = ['video','transition','reference','motion-control','extend','upscale','speech'];
    const sub = args[1] || 'image';
    const outKind = VIDEO_SUBS.includes(sub) ? 'video' : 'image';
    const left = (node.ports || []).filter(p => p.side === 'left');
    return [...left, singleOutputPort(node, outKind)];
  }
  if (isFfmpegCliNode(node)) {
    return [
      { kind: 'video', side: 'left', top: 60, label: 'clips' },
      { kind: 'file', side: 'left', top: 96, label: 'aud' },
      { kind: 'video', side: 'right', top: 72 },
    ];
  }
  if (node.kind === 'output') {
    // Always normalize output port to 'image' — portKindsCompatible allows
    // any media type (image/video/file) to connect regardless of port kind.
    return [{ kind: 'image', side: 'left', top: 60 }];
  }
  return node.ports || [];
}

function firstPortIndex(ports, side) {
  const idx = (ports || []).findIndex(p => p.side === side);
  return idx >= 0 ? idx : 0;
}

function normalizeGraphPorts(graph) {
  if (!graph) return graph;
  const oldById = Object.fromEntries((graph.nodes || []).map(n => [n.id, n]));
  const nodes = (graph.nodes || []).map(node => ({ ...node, ports: normalizedNodePorts(node) }));
  const nextById = Object.fromEntries(nodes.map(n => [n.id, n]));
  const seen = new Set();
  const edges = [];
  (graph.edges || []).forEach(edge => {
    const oldFrom = oldById[edge.from?.node];
    const oldTo = oldById[edge.to?.node];
    const nextFrom = nextById[edge.from?.node];
    const nextTo = nextById[edge.to?.node];
    if (!nextFrom || !nextTo) return;
    let fromPort = edge.from.port;
    let toPort = edge.to.port;
    if (oldFrom?.kind === 'gen' || oldFrom?.kind === 'motion' || oldFrom?.kind === 'select' || isPixVerseCliNode(oldFrom)) {
      fromPort = firstPortIndex(nextFrom.ports, 'right');
    }
    if (isFfmpegCliNode(oldFrom)) {
      fromPort = firstPortIndex(nextFrom.ports, 'right');
    }
    if (oldTo?.kind === 'select') {
      toPort = firstPortIndex(nextTo.ports, 'left');
    }
    if (isFfmpegCliNode(oldTo)) {
      const oldPort = oldTo.ports?.[edge.to.port];
      if (oldPort?.kind === 'file') {
        toPort = nextTo.ports.findIndex(p => p.side === 'left' && p.kind === 'file');
      } else {
        toPort = nextTo.ports.findIndex(p => p.side === 'left' && p.kind === 'video');
      }
      if (toPort < 0) toPort = firstPortIndex(nextTo.ports, 'left');
    }
    if (!nextFrom.ports?.[fromPort] || !nextTo.ports?.[toPort]) return;
    const key = `${edge.from.node}:${fromPort}->${edge.to.node}:${toPort}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      ...edge,
      from: { ...edge.from, port: fromPort },
      to: { ...edge.to, port: toPort },
    });
  });
  return { ...graph, nodes, edges };
}

// Topological order (Kahn). Cycles are flagged as remaining unscheduled.
function topoOrder(graph) {
  const indeg = {};
  graph.nodes.forEach(n => { indeg[n.id] = 0; });
  graph.edges.forEach(e => {
    if (indeg[e.to.node] != null) indeg[e.to.node] += 1;
  });
  const out = [];
  const q = graph.nodes.filter(n => indeg[n.id] === 0).map(n => n.id);
  while (q.length) {
    const id = q.shift();
    out.push(id);
    graph.edges.filter(e => e.from.node === id).forEach(e => {
      indeg[e.to.node] -= 1;
      if (indeg[e.to.node] === 0) q.push(e.to.node);
    });
  }
  return out;
}

// All nodes reachable from a starting node, including the start.
function downstreamNodeIds(graph, startNodeId, opts = {}) {
  const includeDashed = opts.includeDashed !== false;
  const seen = new Set();
  const q = [startNodeId];
  while (q.length) {
    const id = q.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    graph.edges
      .filter(e => e.from.node === id && (includeDashed || !e.dashed))
      .forEach(e => q.push(e.to.node));
  }
  return seen;
}

function defaultRunNodeIds(graph) {
  const incomingAny = new Set(graph.edges.map(e => e.to.node));
  let roots = graph.nodes.filter(n => !incomingAny.has(n.id)).map(n => n.id);
  if (roots.length === 0) {
    const incomingSolid = new Set(graph.edges.filter(e => !e.dashed).map(e => e.to.node));
    roots = graph.nodes.filter(n => !incomingSolid.has(n.id)).map(n => n.id);
  }
  const seen = new Set();
  roots.forEach(id => downstreamNodeIds(graph, id, { includeDashed: false }).forEach(nodeId => seen.add(nodeId)));
  return seen;
}

function runOrderNodeIds(graph, startNodeId) {
  const allOrder = topoOrder(graph);
  const included = startNodeId
    ? downstreamNodeIds(graph, startNodeId, { includeDashed: false })
    : defaultRunNodeIds(graph);
  return allOrder.filter(id => included.has(id));
}

function activeDepsForRun(graph, nodeId, startNodeId) {
  return graph.edges.filter(e =>
    e.to.node === nodeId &&
    (
      !e.dashed ||
      (startNodeId && e.to.node === startNodeId) ||
      nodeById(graph, e.from.node)?.kind === 'prompt'
    )
  );
}

// Validate a potential edge: type match + no duplicate + no cycle
// Port kinds that are mutually compatible (media types can flow into each other)
const MEDIA_KINDS = new Set(['image', 'video', 'file', 'asset']);
function portKindsCompatible(a, b) {
  if (a === b) return true;
  if (MEDIA_KINDS.has(a) && MEDIA_KINDS.has(b)) return true; // image↔video, image↔file, etc.
  return false;
}

function canConnect(graph, from, to) {
  if (from.node === to.node) return { ok: false, reason: 'same node' };
  const fromN = nodeById(graph, from.node);
  const toN = nodeById(graph, to.node);
  if (!fromN || !toN) return { ok: false, reason: 'missing node' };
  const fromP = fromN.ports[from.port];
  const toP = toN.ports[to.port];
  if (!fromP || !toP) return { ok: false, reason: 'missing port' };
  if (fromP.side !== 'right' || toP.side !== 'left') return { ok: false, reason: 'wrong side' };
  if (!portKindsCompatible(fromP.kind, toP.kind)) return { ok: false, reason: `type ${fromP.kind} → ${toP.kind}` };
  const dup = graph.edges.find(e =>
    e.from.node === from.node && e.from.port === from.port &&
    e.to.node === to.node && e.to.port === to.port);
  if (dup) return { ok: false, reason: 'duplicate' };
  // cycle check: after adding, check we can still topo-sort all nodes
  const probe = { ...graph, edges: [...graph.edges, { from, to }] };
  const order = topoOrder(probe);
  if (order.length < graph.nodes.length) return { ok: false, reason: 'cycle' };
  return { ok: true };
}

// Make unique node id
function makeNodeId(graph, prefix) {
  let n = 1;
  while (graph.nodes.find(x => x.id === `${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

// ---------- PROVIDER COVERAGE (for status pills in UI) ----------
const PROVIDER_LABEL = {
  openai: 'OpenAI', google: 'Google', piapi: 'PiAPI',
  replicate: 'Replicate', fal: 'fal.ai', pixverse: 'PixVerse', local: 'Local',
};

Object.assign(window, {
  NODE_TEMPLATES, Storage, Executor,
  makeInitialState, appReducer,
  nodeById, nodeDisplayWidth, normalizeGraphPorts, topoOrder, downstreamNodeIds, defaultRunNodeIds, runOrderNodeIds, activeDepsForRun, canConnect, makeNodeId,
  PROVIDER_LABEL,
  // Thumb helpers — exported so editor.jsx can reuse without duplicating
  resultThumbs, sourceThumbs, upstreamThumbs,
});
