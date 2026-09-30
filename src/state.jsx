// Central state + storage + executor.
//
// Two interfaces are abstracted so a future Tauri / Electron wrapper can swap
// the implementation without touching anything else:
//   - Storage:  load/save full app state. localStorage now; FS later.
//   - Executor: run a single node. Mock with timers now; real API/subprocess later.
//
// One reducer owns everything. Persistence runs after every dispatch (debounced).

// ---------- NODE TEMPLATES ----------
// Static palette nodes. Generator nodes come from the provider catalog
// (src/providers/*.json) — see paletteTemplates().
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
        args: ['connected videos', '-filter_complex concat', '-c:v h264_videotoolbox (mpeg4 fallback)', '{out}.mp4'],
        fields: [{ k: 'in', v: 'multi' }, { k: 'mode', v: 'concat' },
                 { k: 'codec', v: 'VideoToolbox / MPEG-4' }, { k: 'fps', v: '24' }],
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

// One palette entry per capability, grouped by output (Image / Video / …).
function generatorTemplates() {
  return capabilityIds().map(capability => {
    const info = capabilityInfo(capability);
    return {
      kind: 'task', capability, title: info.title, group: info.group,
      spawn: () => spawnTaskNode(capability),
    };
  });
}

// Full palette: inputs, generators, then the static tail (pick, compose, output).
function paletteTemplates() {
  const inputs = NODE_TEMPLATES.filter(t => t.group === 'Inputs');
  const rest = NODE_TEMPLATES.filter(t => t.group !== 'Inputs');
  return [...inputs, ...generatorTemplates(), ...rest];
}

// A copy of `obj` without `keys`, plus `extra`. Use this instead of
// `const { a, ...rest } = obj`: every src/*.jsx file is compiled by in-page
// Babel into the same global scope, and object rest compiles to a top-level
// `var _excluded = [...]` that the next file overwrites.
function withoutKeys(obj, keys, extra) {
  const out = { ...(obj || {}) };
  keys.forEach(key => { delete out[key]; });
  return extra ? { ...out, ...extra } : out;
}

// ---------- STORAGE ABSTRACTION ----------
// Replace `LocalStorage` with a Tauri / Electron file-system adapter later. The
// shape stays the same; the editor never touches the impl directly.
const LocalStorage = {
  KEY: 'beatboard.v1',
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
    result.audio_url || result.audioUrl ||
    result.url || result.src || result.path || result.output || result.file ||
    result.file_path || result.filePath || result.local_path || result.localPath;
  const isVideo = !!(result.video_url || result.videoUrl) || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(url || ''));
  const isAudio = !!(result.audio_url || result.audioUrl) || /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(String(url || ''));
  const type = isAudio ? 'audio' : isVideo ? 'video' : 'image';
  return url ? [{ seed: url, url, label: type, type }] : [];
}

function sourceThumbs(dep) {
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

// The candidate a Pick produced: its explicit selectedIndex, else the thumb
// flagged `chosen`, else the first. Reads the run result before the node:
// mid-run, dep.from is the graph as it was when the run started and may still
// carry the previous run's selection. Mirrors picked_index in
// src-tauri/src/providers/inputs.rs.
function pickedThumb(dep) {
  const fromResult = resultThumbs(dep.result);
  const holder = fromResult.length ? dep.result : dep.from;
  const thumbs = fromResult.length ? fromResult : (Array.isArray(dep.from?.thumbs) ? dep.from.thumbs : []);
  if (!thumbs.length) return null;
  const selected = holder?.selectedIndex;
  const idx = Number.isInteger(selected) && selected >= 0 && selected < thumbs.length
    ? selected
    : thumbs.findIndex(t => t.chosen);
  return thumbs[Math.max(0, idx)];
}

function upstreamThumbs(deps, options = {}) {
  const out = [];
  (deps || []).forEach(dep => {
    if (dep.from?.kind === 'select') {
      const picked = pickedThumb(dep);
      if (picked) out.push({ ...picked, chosen: true });
      return;
    }
    const thumbs = sourceThumbs(dep);
    if (!thumbs.length) return;
    if (options.forSelect && (dep.from?.kind === 'gen' || dep.from?.kind === 'motion' || dep.from?.kind === 'cli' || dep.from?.kind === 'task')) {
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
  if (node.kind === 'task') {
    const kind = taskOutputKind(node);
    return { thumbs: thumbs.slice(0, 4).map((t, i) => ({ ...t, type: kind === 'asset' ? t.type : kind, label: node.title || t.label, chosen: i === 0 })) };
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
    if (node.kind === 'cli' || node.kind === 'task') return 1400;
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
    nodes: sc.nodes.map(n => withoutKeys(n, ['state', 'progress'])),
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
      // Optional custom executables; empty = Beatboard's bundled/managed runtime.
      binPaths: { ffmpeg: '', pixverse: '' },
      // Ask before a run that submits more paid generations than this
      // (0 = always ask, null = never).
      paidRunLimit: DEFAULT_PAID_RUN_LIMIT,
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
      errorModal: null,      // { errors: [{ nodeId, title, error }] } — run-failure dialog
    },
  };
}

// Saved configs from before P1 carry unused API keys, a default model and
// prototype binary paths; keep only the runtime overrides that still apply.
function cleanConfig(config) {
  const binPaths = (config && config.binPaths) || {};
  const limit = config && 'paidRunLimit' in config ? config.paidRunLimit : DEFAULT_PAID_RUN_LIMIT;
  return {
    binPaths: { ffmpeg: binPaths.ffmpeg || '', pixverse: binPaths.pixverse || '' },
    paidRunLimit: limit === null || (Number.isInteger(limit) && limit >= 0) ? limit : DEFAULT_PAID_RUN_LIMIT,
    ...(typeof config?.comfyuiUrl === 'string' && config.comfyuiUrl.trim() ? { comfyuiUrl: config.comfyuiUrl.trim() } : {}),
  };
}

const DEFAULT_PAID_RUN_LIMIT = 3;

// Results saved mid-run (Beatboard quit while a run was active): nodes whose
// provider job was recorded become `interrupted` and can be resumed; the rest
// simply never ran.
const IN_FLIGHT_STATES = new Set(['running', 'queued', 'waiting_dependencies', 'waiting_user']);
function settleInterruptedResults(runResults) {
  const out = {};
  Object.entries(runResults || {}).forEach(([id, r]) => {
    if (!r || !IN_FLIGHT_STATES.has(r.state)) { out[id] = r; return; }
    if (r.job) {
      out[id] = { state: 'interrupted', progress: 0, job: r.job, error: 'Beatboard closed while this was running — resume to collect the result' };
    }
  });
  return out;
}

// Paid generations a run will submit: every generator (task) node in the run
// order, grouped by provider, with how many outputs each asks for.
function paidRunSummary(graph, order) {
  const byProvider = {};
  let total = 0;
  (order || []).forEach(id => {
    const node = nodeById(graph, id);
    // Local providers (ComfyUI) cost nothing per run.
    if (node?.kind !== 'task' || providerManifest(node.provider)?.local) return;
    const entry = byProvider[node.provider] || (byProvider[node.provider] = { runs: 0, outputs: 0, nodes: [] });
    entry.runs += 1;
    entry.outputs += Number(node.params?.count) > 0 ? Number(node.params.count) : 1;
    entry.nodes.push(id);
    total += 1;
  });
  return { total, byProvider };
}

function needsPaidRunConfirmation(summary, limit) {
  return limit !== null && limit !== undefined && summary.total > 0 && summary.total > limit;
}

// Spend the providers reported for a project's last results, by unit.
function reportedSpend(runResults) {
  const totals = {};
  Object.values(runResults || {}).forEach(r => {
    const cost = r && r.cost;
    if (cost && Number.isFinite(cost.amount)) totals[cost.unit] = (totals[cost.unit] || 0) + cost.amount;
  });
  return totals;
}

// ---------- REDUCER ----------
function appReducer(state, action) {
  switch (action.type) {
    case 'HYDRATE':
      return action.state
        ? {
          ...action.state,
          config: cleanConfig(action.state.config),
          library: action.state.library || [],
          projects: action.state.projects.map(p => ({
            ...p,
            outputDir: p.outputDir || '',
            graph: normalizeGraphPorts(p.graph),
            runResults: settleInterruptedResults(p.runResults),
          })),
        }
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
            ? { ...p, graph: normalizeGraphPorts(action.graph), runResults: {}, modifiedAt: Date.now() }
            : p),
        ui: { ...state.ui, selectedNodeId: null, selectedEdgeIdx: null },
      };
    }

    case 'PATCH_GRAPH': {
      // Replace the active project's graph with a patched version. Execution-
      // relevant node/edge changes invalidate that node and every solid-edge
      // descendant, while layout/title-only changes preserve cached outputs.
      return {
        ...state,
        projects: state.projects.map(p => {
          if (p.id !== state.activeProjectId) return p;
          const newGraph = normalizeGraphPorts(action.fn(p.graph));
          if (action.preserveResults) {
            return { ...p, graph: newGraph, runResults: p.runResults || {}, modifiedAt: Date.now() };
          }
          const invalidIds = executionInvalidationIds(p.graph, newGraph);
          const graph = clearInvalidatedGraphOutputs(newGraph, invalidIds);
          const runResults = invalidateGraphRunResults(newGraph, p.runResults || {}, invalidIds);
          return { ...p, graph, runResults, modifiedAt: Date.now() };
        }),
      };
    }
    case 'CLEAR_RUN_RESULTS_FOR_NODES': {
      const targetProjectId = action.projectId || state.activeProjectId;
      const ids = new Set(action.nodeIds || []);
      return {
        ...state,
        projects: state.projects.map(p => {
          if (p.id !== targetProjectId || ids.size === 0) return p;
          const runResults = Object.fromEntries(
            Object.entries(p.runResults || {}).filter(([id]) => !ids.has(id))
          );
          const nodes = p.graph.nodes.map(n =>
            ids.has(n.id) && n.kind !== 'asset' && n.kind !== 'prompt'
              ? { ...n, thumbs: [], ...(n.kind === 'select' ? { selectedIndex: undefined } : {}) }
              : n
          );
          return { ...p, runResults, graph: { ...p.graph, nodes } };
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
// Id prefix for new nodes of a kind (generator task nodes read as "gen").
function nodeIdPrefix(kind) {
  return kind === 'task' ? 'gen' : String(kind || 'node').slice(0, 3);
}

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

function pixVerseCliSubcommand(node) {
  return isPixVerseCliNode(node) ? (node.cli?.args?.[1] || 'image') : '';
}

function isLegacyPixVerseSpeechNode(node) {
  return pixVerseCliSubcommand(node) === 'speech';
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
    // args[1] is the subcommand (image, video, transition, reference, …).
    const VIDEO_SUBS = ['video','transition','reference','motion-control','extend','upscale','modify'];
    const AUDIO_SUBS = ['voice','music'];
    const sub = args[1] || 'image';
    const outKind = AUDIO_SUBS.includes(sub) ? 'audio' : VIDEO_SUBS.includes(sub) ? 'video' : sub === 'template' ? 'asset' : 'image';
    const left = (node.ports || []).filter(p => p.side === 'left');
    return [...left, singleOutputPort(node, outKind)];
  }
  if (node.kind === 'task') {
    const left = (node.ports || []).filter(p => p.side === 'left');
    return [...left, singleOutputPort(node, taskOutputKind(node))];
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
  const nodes = (graph.nodes || []).map(node => {
    let migrated = node;
    if (isLegacyPixVerseSpeechNode(node)) {
      migrated = {
        ...node,
        title: 'PixVerse voice · migrated',
        migrationNote: 'PixVerse CLI removed create speech; this node now generates standalone TTS audio.',
        footer: { ...(node.footer || {}), left: 'pixverse create voice · migrated' },
        cli: {
          ...(node.cli || {}),
          args: ['create', 'voice', '--text', '{prompt}', '--model', 'speech-2.8-hd',
                 '--language', 'auto', '--speed', '1', '--timeout', '300', '--json'],
          fields: [{ k: 'mode', v: 'voice' }, { k: 'model', v: 'speech-2.8-hd' },
                   { k: 'migration', v: 'speech → voice' }],
        },
        ports: [
          { kind: 'text', side: 'left', top: 52, label: 'text' },
          { kind: 'audio', side: 'right', top: 52 },
        ],
      };
    }
    if (isFfmpegCliNode(node) && node.cli) {
      const args = (node.cli.args || []).map(arg =>
        String(arg).includes('libx264')
          ? '-c:v h264_videotoolbox (mpeg4 fallback)'
          : arg
      );
      const fields = (node.cli.fields || []).map(field =>
        field.k === 'crf' ? { k: 'codec', v: 'VideoToolbox / MPEG-4' } : field
      );
      migrated = { ...node, cli: { ...node.cli, args, fields } };
    }
    // Legacy PixVerse argv nodes become provider-neutral task nodes. Port
    // order is preserved, so existing edges stay valid.
    migrated = migrateLegacyPixVerseNode(migrated);
    return { ...migrated, ports: normalizedNodePorts(migrated) };
  });
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
    if (oldFrom?.kind === 'gen' || oldFrom?.kind === 'motion' || oldFrom?.kind === 'select' || oldFrom?.kind === 'task' || isPixVerseCliNode(oldFrom)) {
      fromPort = firstPortIndex(nextFrom.ports, 'right');
    }
    if (isFfmpegCliNode(oldFrom)) {
      fromPort = firstPortIndex(nextFrom.ports, 'right');
    }
    if (oldTo?.kind === 'select') {
      toPort = firstPortIndex(nextTo.ports, 'left');
    }
    if (isLegacyPixVerseSpeechNode(oldTo)) {
      const oldPort = oldTo.ports?.[edge.to.port];
      // Preserve the script/prompt connection. The old source-video input has
      // no equivalent because CLI 1.2+ removed lip-sync speech entirely.
      if (oldPort?.kind !== 'text' && oldPort?.label !== 'script') return;
      toPort = nextTo.ports.findIndex(p => p.side === 'left' && p.kind === 'text');
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

function executionNodeSignature(node) {
  if (!node) return '';
  const executionFields = withoutKeys(node, ['x', 'y', 'w', 'title', 'badge', 'footer', 'state', 'progress']);
  // Generated previews are cached output, not node configuration. Asset
  // thumbs are user inputs and therefore must participate in invalidation.
  if (node.kind !== 'asset') delete executionFields.thumbs;
  return JSON.stringify(executionFields);
}

function edgeExecutionKey(edge) {
  return `${edge.from?.node}:${edge.from?.port}->${edge.to?.node}:${edge.to?.port}:${edge.dashed ? 'optional' : 'required'}`;
}

function executionInvalidationIds(oldGraph, newGraph) {
  const invalid = new Set();
  const oldNodes = new Map((oldGraph?.nodes || []).map(node => [node.id, node]));
  const newNodes = new Map((newGraph?.nodes || []).map(node => [node.id, node]));

  newNodes.forEach((node, id) => {
    const oldNode = oldNodes.get(id);
    if (!oldNode || executionNodeSignature(oldNode) !== executionNodeSignature(node)) invalid.add(id);
  });
  oldNodes.forEach((_, id) => {
    if (!newNodes.has(id)) invalid.add(id);
  });

  const oldEdges = new Map((oldGraph?.edges || []).map(edge => [edgeExecutionKey(edge), edge]));
  const newEdges = new Map((newGraph?.edges || []).map(edge => [edgeExecutionKey(edge), edge]));
  oldEdges.forEach((edge, key) => {
    if (!newEdges.has(key) && edge.to?.node) invalid.add(edge.to.node);
  });
  newEdges.forEach((edge, key) => {
    if (!oldEdges.has(key) && edge.to?.node) invalid.add(edge.to.node);
  });

  // A changed input can make every previously cached downstream result stale.
  [...invalid].forEach(id => {
    if (oldNodes.has(id)) downstreamNodeIds(oldGraph, id, { includeDashed: true }).forEach(x => invalid.add(x));
    if (newNodes.has(id)) downstreamNodeIds(newGraph, id, { includeDashed: true }).forEach(x => invalid.add(x));
  });

  return invalid;
}

function clearInvalidatedGraphOutputs(graph, invalidIds) {
  if (!invalidIds?.size) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map(node => {
      if (!invalidIds.has(node.id) || node.kind === 'asset' || node.kind === 'prompt') return node;
      return {
        ...node,
        thumbs: [],
        ...(node.kind === 'select' ? { selectedIndex: undefined } : {}),
      };
    }),
  };
}

function invalidateGraphRunResults(graph, runResults, invalidIds) {
  const nodeIds = new Set((graph?.nodes || []).map(node => node.id));
  return Object.fromEntries(
    Object.entries(runResults || {}).filter(([id]) => nodeIds.has(id) && !invalidIds.has(id))
  );
}

function thumbHasUsableSource(thumb) {
  if (!thumb) return false;
  if (typeof thumb === 'string') {
    const value = thumb.trim();
    return !!value && (value.startsWith('/') || /^(https?:|data:|blob:|asset:|atlasmedia:)/i.test(value));
  }
  const value = thumb.path || thumb.local_path || thumb.localPath || thumb.file_path || thumb.filePath ||
    thumb.file || thumb.output || thumb.url || thumb.src || thumb.image_url || thumb.imageUrl ||
    thumb.video_url || thumb.videoUrl || thumb.audio_url || thumb.audioUrl || '';
  const source = String(value || '').trim();
  return !!source && (source.startsWith('/') || /^(https?:|data:|blob:|asset:|atlasmedia:)/i.test(source));
}

function usableResultThumbs(result) {
  return resultThumbs(result).filter(thumbHasUsableSource);
}

// A node is ready for downstream use only after it produced a concrete value.
// Prompt and Asset nodes are special roots: their edited text/local media is
// already a usable value even before a run result exists.
function nodeHasUsableOutput(node, result) {
  if (!node) return false;
  if (result?.state && result.state !== 'done') return false;
  if (node.kind === 'prompt') return !!String(node.prompt || '').trim();
  if (node.kind === 'asset') {
    return usableResultThumbs(result).length > 0 || (node.thumbs || []).some(thumbHasUsableSource);
  }
  return result?.state === 'done' && usableResultThumbs(result).length > 0;
}

function dependencyReadiness(graph, nodeId, resultForNode) {
  const dependencies = activeDepsForRun(graph, nodeId).map(edge => {
    const source = nodeById(graph, edge.from.node);
    const result = source && typeof resultForNode === 'function' ? resultForNode(source.id) : undefined;
    const ready = nodeHasUsableOutput(source, result);
    const state = result?.state || (ready ? 'done' : 'idle');
    const reason = !source ? 'missing_node'
      : state === 'error' ? 'error'
      : state === 'blocked' ? 'blocked'
      : state === 'queued' || state === 'waiting_dependencies' || state === 'waiting_user' || state === 'running' ? 'waiting'
      : 'missing_output';
    return { edge, source, result, ready, state, reason: ready ? null : reason };
  });
  // A Pick chooses among whatever its inputs produced: once nothing is still
  // pending, one usable candidate is enough (a failed variant in a
  // comparison must not block the others). Everything else needs all inputs.
  const node = nodeById(graph, nodeId);
  const ok = node?.kind === 'select'
    ? dependencies.some(dep => dep.ready) && !dependencies.some(dep => dep.reason === 'waiting')
    : dependencies.every(dep => dep.ready);
  return {
    ok,
    dependencies,
    missing: ok ? [] : dependencies.filter(dep => !dep.ready),
  };
}

function nodeInputPortStatuses(graph, nodeId, resultForNode) {
  const node = nodeById(graph, nodeId);
  if (!node) return {};
  const required = dependencyReadiness(graph, nodeId, resultForNode).dependencies;
  const allIncoming = (graph.edges || []).filter(edge => edge.to.node === nodeId);
  const statuses = {};
  (node.ports || []).forEach((port, index) => {
    if (port.side !== 'left') return;
    const deps = required.filter(dep => dep.edge.to.port === index);
    const optional = allIncoming.filter(edge => edge.to.port === index && edge.dashed);
    if (!deps.length) {
      statuses[index] = { state: optional.length ? 'optional' : 'unconnected', dependencies: [] };
      return;
    }
    const failed = deps.find(dep => dep.state === 'error' || dep.state === 'blocked');
    statuses[index] = {
      state: failed ? 'blocked' : deps.every(dep => dep.ready) ? 'ready' : 'waiting',
      dependencies: deps,
    };
  });
  return statuses;
}

// Topological order (Kahn). Cycles are flagged as remaining unscheduled.
function topoOrder(graph, opts = {}) {
  const includeDashed = opts.includeDashed !== false;
  const edges = graph.edges.filter(edge => includeDashed || !edge.dashed);
  const indeg = {};
  graph.nodes.forEach(n => { indeg[n.id] = 0; });
  edges.forEach(e => {
    if (indeg[e.to.node] != null) indeg[e.to.node] += 1;
  });
  const out = [];
  const q = graph.nodes.filter(n => indeg[n.id] === 0).map(n => n.id);
  while (q.length) {
    const id = q.shift();
    out.push(id);
    edges.filter(e => e.from.node === id).forEach(e => {
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
  return new Set(graph.nodes.map(node => node.id));
}

function runOrderNodeIds(graph, startNodeId, options = {}) {
  const resultForNode = typeof options === 'function' ? options : options.getResult;
  const allOrder = topoOrder(graph, { includeDashed: false });
  const included = startNodeId
    ? downstreamNodeIds(graph, startNodeId, { includeDashed: false })
    : defaultRunNodeIds(graph);

  if (startNodeId) {
    // Include every missing ancestor, including side inputs of downstream
    // nodes. Ancestors with an already usable cached output can be reused.
    const queue = [...included];
    while (queue.length) {
      const id = queue.shift();
      activeDepsForRun(graph, id).forEach(edge => {
        const source = nodeById(graph, edge.from.node);
        const canReuse = typeof resultForNode === 'function' && nodeHasUsableOutput(source, resultForNode(source?.id));
        if (canReuse || included.has(edge.from.node)) return;
        included.add(edge.from.node);
        queue.push(edge.from.node);
      });
    }
  }
  return allOrder.filter(id => included.has(id));
}

function activeDepsForRun(graph, nodeId) {
  return graph.edges.filter(e => e.to.node === nodeId && !e.dashed);
}

// Validate a potential edge: type match + no duplicate + no cycle
// Port kinds that are mutually compatible (media types can flow into each other)
const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'file', 'asset']);
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

// ---------- COMPARISON ----------
// Every (provider, model) a capability can run on, for the compare picker.
function comparisonOptions(capability) {
  return providersFor(capability).flatMap(m => {
    const models = providerCapability(m.id, capability)?.models || [];
    return models.length
      ? models.map(model => ({ provider: m.id, model, label: `${m.name} · ${modelLabel(m.id, model)}` }))
      : [{ provider: m.id, model: undefined, label: m.name }];
  });
}

// Duplicate a generator node once per variant ({ provider, model }), feed
// the original and every copy into a new Pick node, and move the original's
// downstream edges onto the Pick, so whatever the user picks flows on.
// Returns { graph, pickId, variantIds, changes } or { error }.
function buildComparison(graph, nodeId, variants) {
  const original = nodeById(graph, nodeId);
  if (!original || original.kind !== 'task') return { error: `"${nodeId}" is not a generator node` };
  if (!Array.isArray(variants) || !variants.length) return { error: 'choose at least one provider / model to compare against' };
  if (original.provider_params?._raw_args) return { error: 'reset this node to standard settings before comparing it' };
  const options = comparisonOptions(original.capability);
  const seen = new Set([`${original.provider}|${original.model || ''}`]);
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const variantIds = [];
  const changes = {};
  const height = 210;
  for (const variant of variants) {
    const key = `${variant.provider}|${variant.model || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!options.some(o => o.provider === variant.provider && (o.model || '') === (variant.model || ''))) {
      return { error: `${variant.provider}${variant.model ? ` / ${variant.model}` : ''} cannot run ${original.capability}` };
    }
    let { node: copy, changes: c1 } = switchTaskProvider(original, variant.provider);
    let c2 = [];
    if (variant.model && copy.model !== variant.model) ({ node: copy, changes: c2 } = switchTaskModel(copy, variant.model));
    const id = makeNodeId({ nodes }, 'gen');
    copy = { ...copy, id, x: original.x, y: (original.y || 0) + height * (variantIds.length + 1), thumbs: [] };
    nodes.push(copy);
    variantIds.push(id);
    if (c1.length || c2.length) changes[id] = [...c1, ...c2];
    // Same inputs as the original (ports match: same capability).
    graph.edges.filter(e => e.to.node === original.id).forEach(e => edges.push({ ...e, to: { ...e.to, node: id } }));
  }
  if (!variantIds.length) return { error: 'every chosen variant is already on this node' };

  const pickTemplate = NODE_TEMPLATES.find(t => t.kind === 'select');
  const pickId = makeNodeId({ nodes }, 'sel');
  const pick = {
    ...pickTemplate.spawn(),
    id: pickId,
    title: `Compare · ${capabilityInfo(original.capability)?.title || original.capability}`,
    x: (original.x || 0) + (original.w || 244) + 60,
    y: original.y || 0,
  };
  nodes.push(pick);
  const outPort = (original.ports || []).findIndex(p => p.side === 'right');
  const pickIn = pick.ports.findIndex(p => p.side === 'left');
  const pickOut = pick.ports.findIndex(p => p.side === 'right');
  const downstream = edges.filter(e => e.from.node === original.id);
  const kept = edges.filter(e => e.from.node !== original.id);
  const rewired = downstream.map(e => ({ ...e, from: { node: pickId, port: pickOut } }));
  const feeds = [original.id, ...variantIds].map(id => ({ from: { node: id, port: outPort }, to: { node: pickId, port: pickIn } }));
  return {
    graph: { ...graph, nodes, edges: [...kept, ...feeds, ...rewired] },
    pickId,
    variantIds,
    changes,
  };
}

Object.assign(window, {
  NODE_TEMPLATES, paletteTemplates, Storage, Executor,
  makeInitialState, appReducer,
  comparisonOptions, buildComparison, settleInterruptedResults, paidRunSummary, needsPaidRunConfirmation, reportedSpend, DEFAULT_PAID_RUN_LIMIT,
  nodeById, nodeIdPrefix, nodeDisplayWidth, normalizeGraphPorts, topoOrder, downstreamNodeIds, defaultRunNodeIds, runOrderNodeIds, activeDepsForRun, canConnect, makeNodeId,
  // Thumb helpers — exported so editor.jsx can reuse without duplicating
  resultThumbs, sourceThumbs, upstreamThumbs, thumbHasUsableSource, usableResultThumbs,
  nodeHasUsableOutput, dependencyReadiness, nodeInputPortStatuses,
});
