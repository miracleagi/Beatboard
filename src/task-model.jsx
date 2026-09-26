// Task nodes — provider-neutral generation nodes (docs/design/multi-provider.md).
//
// Part 1: the provider catalog (src/providers/*.json) and everything the UI
// and the MCP bridge need to create and edit task nodes from it.
// Part 2: migration of legacy PixVerse nodes into task nodes.
//
//   { kind: 'task', capability: 'video.generate', provider: 'pixverse',
//     model: 'v6', params: { duration_s: 5, resolution: '720p', … },
//     provider_params: { timeout: 600, off_peak: true, … },
//     ports: [{ kind: 'image', side: 'left', slot: 'image', … }, …] }
//
// This file converts legacy PixVerse nodes (`kind: 'cli'` argv templates and
// the older `kind: 'gen' | 'motion'` provider nodes) into task nodes. The Rust
// PixVerse provider (src-tauri/src/providers/pixverse/args.rs) turns a task
// node back into argv; golden fixtures generated from this file
// (scripts/gen-pixverse-fixtures.mjs) prove both paths produce the same argv.
//
// Plain JS on purpose: loaded by the app and by Node for fixture generation.

// PixVerse subcommand → capability, input-port slots, and the placeholder
// each input flag must carry for the node to migrate to typed params.
const PV_TASK_SPECS = {
  'image': {
    capability: 'image.generate',
    slots: { image: 'images', text: 'prompt' },
    inputs: { '--prompt': '{prompt}', '--image': '{image}', '--images': '{images}' },
  },
  'video': {
    capability: 'video.generate',
    slots: { image: 'image', text: 'prompt' },
    inputs: { '--prompt': '{prompt}', '--image': '{image}' },
  },
  'transition': {
    capability: 'video.transition',
    slots: { image: 'frames', text: 'prompt' },
    inputs: { '--images': '{images}', '--prompt': '{prompt}' },
  },
  'reference': {
    capability: 'video.reference',
    slots: { image: 'images', video: 'videos', audio: 'audios', text: 'prompt' },
    inputs: { '--images': '{images}', '--videos': '{videos}', '--audios': '{audios}', '--prompt': '{prompt}' },
  },
  'motion-control': {
    capability: 'video.motion_control',
    slots: { image: 'character', video: 'motion' },
    inputs: { '--image': '{from}', '--video': '{to}' },
  },
  'extend': {
    capability: 'video.extend',
    slots: { video: 'video', text: 'prompt' },
    inputs: { '--video': '{video_id}', '--prompt': '{prompt}' },
  },
  'upscale': {
    capability: 'video.upscale',
    slots: { video: 'video' },
    inputs: { '--video': '{video_id}' },
  },
  'modify': {
    capability: 'video.modify',
    slots: { video: 'video', image: 'images', text: 'prompt' },
    inputs: { '--video': '{video_id}', '--images': '{images}', '--prompt': '{prompt}' },
  },
  'voice': {
    capability: 'audio.speech',
    slots: { text: 'text' },
    inputs: { '--text': '{prompt}' },
  },
  'music': {
    capability: 'audio.music',
    slots: { image: 'image', text: 'prompt' },
    inputs: { '--prompt': '{prompt}', '--image': '{images}' },
  },
  'template': {
    capability: 'provider.template',
    slots: { image: 'images', video: 'video', text: 'prompt' },
    inputs: { '--image': '{images}', '--video': '{video}', '--prompt': '{prompt}' },
  },
};

// Value flags → [bucket, key]. `duration` is subcommand-specific (see below).
const PV_VALUE_FLAGS = {
  '--quality': ['params', 'resolution'],
  '--aspect-ratio': ['params', 'aspect_ratio'],
  '--count': ['params', 'count'],
  '--seed': ['params', 'seed'],
  '--timeout': ['provider_params', 'timeout'],
  '--detail-level': ['provider_params', 'detail_level'],
  '--keyframe-time': ['provider_params', 'keyframe_time'],
  '--template-id': ['provider_params', 'template_id'],
  '--lyrics': ['provider_params', 'lyrics'],
  '--voice-id': ['provider_params', 'voice_id'],
  '--provider-voice-id': ['provider_params', 'provider_voice_id'],
  '--language': ['provider_params', 'language'],
  '--stability': ['provider_params', 'stability'],
  '--similarity-boost': ['provider_params', 'similarity_boost'],
  '--style': ['provider_params', 'style'],
  '--speed': ['provider_params', 'speed'],
  '--volume': ['provider_params', 'volume'],
  '--pitch': ['provider_params', 'pitch'],
  '--emotion': ['provider_params', 'emotion'],
  '--idempotency-key': ['provider_params', 'idempotency_key'],
  '--client-request-id': ['provider_params', 'client_request_id'],
  '--output': ['provider_params', 'output'],
};

// Boolean flags → [bucket, key, value].
const PV_BOOL_FLAGS = {
  '--audio': ['params', 'audio', true],
  '--no-audio': ['params', 'audio', false],
  '--multi-shot': ['provider_params', 'multi_shot', true],
  '--no-multi-shot': ['provider_params', 'multi_shot', false],
  '--use-speaker-boost': ['provider_params', 'use_speaker_boost', true],
  '--no-use-speaker-boost': ['provider_params', 'use_speaker_boost', false],
  '--off-peak': ['provider_params', 'off_peak', true],
  '--instrumental': ['provider_params', 'instrumental', true],
  '--auto-lyrics': ['provider_params', 'auto_lyrics', true],
  '--no-duration-auto': ['provider_params', 'no_duration_auto', true],
  '--no-wait': ['provider_params', 'no_wait', true],
};

// Integer-valued keys stored as numbers when that round-trips exactly.
const PV_NUMERIC_KEYS = new Set(['count', 'seed', 'duration_s', 'timeout', 'keyframe_time']);

function pvTypedValue(key, raw) {
  if (PV_NUMERIC_KEYS.has(key) && /^-?\d+$/.test(raw) && String(Number(raw)) === raw) return Number(raw);
  return raw;
}

function pvCliName(node) {
  const raw = node?.cli?.cmd || node?.cli?.bin || '';
  return String(raw).trim().split(/\s+/)[0].split(/[\\/]/).pop();
}

function isLegacyPixVerseNode(node) {
  return (node?.kind === 'cli' && pvCliName(node) === 'pixverse') ||
    ((node?.kind === 'gen' || node?.kind === 'motion') && node?.provider === 'pixverse');
}

function isTaskNode(node) {
  return node?.kind === 'task';
}

function withSlots(ports, spec) {
  return (ports || []).map(port => {
    if (port.side !== 'left' || !spec) return port;
    const slot = spec.slots[port.kind];
    return slot ? { ...port, slot } : port;
  });
}

function slotPortCount(ports, slot) {
  return ports.filter(p => p.side === 'left' && p.slot === slot).length;
}

// Parse a PixVerse argv template into typed task fields.
// Returns null when the template cannot be expressed losslessly.
function parsePixVerseArgs(args, spec, sub, ports) {
  if (!spec || args[0] !== 'create' || args[1] !== sub) return null;
  const out = { model: undefined, params: {}, provider_params: {} };
  const seen = new Set();
  let sawJson = false;
  const claim = key => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  for (let i = 2; i < args.length; i += 1) {
    const flag = String(args[i]);
    if (!flag.startsWith('--')) return null;
    if (flag === '--json') {
      if (sawJson) return null;
      sawJson = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(spec.inputs, flag)) {
      if (args[i + 1] !== spec.inputs[flag] || !claim(`input:${spec.inputs[flag]}`)) return null;
      i += 1;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(PV_BOOL_FLAGS, flag)) {
      const [bucket, key, value] = PV_BOOL_FLAGS[flag];
      if (!claim(key)) return null;
      out[bucket][key] = value;
      continue;
    }
    let target = PV_VALUE_FLAGS[flag];
    if (flag === '--model') target = ['model', 'model'];
    if (flag === '--duration' && sub !== 'music') target = ['params', 'duration_s'];
    if (flag === '--duration-seconds' && sub === 'music') target = ['params', 'duration_s'];
    if (!target) return null;
    const value = args[i + 1];
    if (value == null || String(value).startsWith('--') || String(value).includes('{')) return null;
    const [bucket, key] = target;
    if (!claim(key)) return null;
    if (bucket === 'model') out.model = String(value);
    else out[bucket][key] = pvTypedValue(key, String(value));
    i += 1;
  }
  if (!sawJson) return null;

  // `create image` picks --image vs --images from the number of image ports
  // (see Input::ByPorts in args.rs); the template must agree with that rule.
  if (sub === 'image') {
    const multi = slotPortCount(ports, 'images') > 1;
    if (seen.has('input:{image}') && multi) return null;
    if (seen.has('input:{images}') && !multi) return null;
    if (seen.has('input:{image}') && seen.has('input:{images}')) return null;
  }
  return out;
}

function taskBase(node) {
  const { cli, provider, model, quality, aspectRatio, count, duration, audio, offPeak, timeout, ...rest } = node;
  return rest;
}

function migrateCliNode(node) {
  const args = (node.cli?.args || []).map(String);
  const sub = args[0] === 'create' ? args[1] : undefined;
  const spec = PV_TASK_SPECS[sub];
  const ports = withSlots(node.ports, spec);
  const parsed = parsePixVerseArgs(args, spec, sub, ports);
  const base = { ...taskBase(node), kind: 'task', provider: 'pixverse', badge: 'pixverse', ports };
  if (!parsed) {
    // Keep the exact template; the provider resolves it with legacy rules.
    return {
      ...base,
      capability: spec ? spec.capability : 'pixverse.raw',
      params: {},
      provider_params: { _raw_args: args },
    };
  }
  return {
    ...base,
    capability: spec.capability,
    ...(parsed.model ? { model: parsed.model } : {}),
    params: parsed.params,
    provider_params: parsed.provider_params,
  };
}

// Older provider nodes (kind gen/motion, provider pixverse) — mirrors
// build_provider_args in src-tauri/src/providers/pixverse/legacy.rs.
function migrateProviderNode(node) {
  const video = node.kind === 'motion';
  const spec = PV_TASK_SPECS[video ? 'video' : 'image'];
  // gen nodes always sent a single --image: route every image port to one
  // slot and keep a single-port shape by giving only the first port the slot.
  let imageSlotted = false;
  const ports = (node.ports || []).map(port => {
    if (port.side !== 'left') return port;
    if (port.kind === 'image') {
      if (imageSlotted) return port;
      imageSlotted = true;
      return { ...port, slot: video ? 'image' : 'images' };
    }
    const slot = spec.slots[port.kind];
    return slot ? { ...port, slot } : port;
  });
  const params = {
    resolution: node.quality || (video ? '720p' : '1080p'),
    aspect_ratio: node.aspectRatio || '16:9',
  };
  if (Number.isInteger(node.count) && node.count >= 0) params.count = node.count;
  const provider_params = { timeout: Number.isInteger(node.timeout) && node.timeout >= 0 ? node.timeout : (video ? 600 : 300) };
  if (video) {
    params.duration_s = Number.isInteger(node.duration) && node.duration >= 0 ? node.duration : 5;
    if (node.audio === true) params.audio = true;
    if (node.offPeak === true) provider_params.off_peak = true;
  }
  return {
    ...taskBase(node),
    kind: 'task',
    provider: 'pixverse',
    badge: 'pixverse',
    capability: spec.capability,
    model: node.model || (video ? 'v6' : 'gpt-image-2.0'),
    ports,
    params,
    provider_params,
  };
}

// Legacy PixVerse node → task node. Other nodes are returned unchanged.
function migrateLegacyPixVerseNode(node) {
  if (!isLegacyPixVerseNode(node)) return node;
  return node.kind === 'cli' ? migrateCliNode(node) : migrateProviderNode(node);
}


// ════════════════════════════════════════════════════════════════════════════
// Provider catalog
// ════════════════════════════════════════════════════════════════════════════

const PROVIDER_MANIFEST_FILES = ['pixverse'];
let providerCatalog = { capabilities: {}, providers: [] };

function setProviderCatalog(catalog) {
  providerCatalog = catalog;
}

// Fetch the capability registry and every provider manifest. The app awaits
// this before first render (editor-app.jsx).
async function loadProviderCatalog(base = 'src/providers/') {
  const get = async (name) => {
    const res = await fetch(`${base}${name}.json`);
    if (!res.ok) throw new Error(`failed to load ${name}.json: ${res.status}`);
    return res.json();
  };
  const [capabilities, ...providers] = await Promise.all([
    get('capabilities'),
    ...PROVIDER_MANIFEST_FILES.map(get),
  ]);
  setProviderCatalog({ capabilities, providers });
  return providerCatalog;
}

function providerCatalogList() {
  return providerCatalog.providers;
}

function capabilityIds() {
  return Object.keys(providerCatalog.capabilities);
}

function capabilityInfo(capability) {
  return providerCatalog.capabilities[capability] || null;
}

// Capability id for a capability name or one of its legacy aliases.
function resolveCapability(name) {
  if (providerCatalog.capabilities[name]) return name;
  return capabilityIds().find(id => (providerCatalog.capabilities[id].aliases || []).includes(name)) || null;
}

function providerManifest(provider) {
  return providerCatalog.providers.find(m => m.id === provider) || null;
}

function providersFor(capability) {
  return providerCatalog.providers.filter(m => m.capabilities && m.capabilities[capability]);
}

function providerCapability(provider, capability) {
  return providerManifest(provider)?.capabilities?.[capability] || null;
}

// Param specs with the manifest's shared `param_defs` merged under each
// capability entry's overrides. Order is the manifest's display order.
function taskParamSpecs(provider, capability) {
  const manifest = providerManifest(provider);
  const entry = manifest?.capabilities?.[capability];
  if (!entry) return [];
  return (entry.params || []).map(p => ({ ...(manifest.param_defs?.[p.key] || {}), ...p }));
}

function providerName(provider) {
  return providerManifest(provider)?.name || provider || '';
}

function modelLabel(provider, model) {
  if (!model) return '';
  return providerManifest(provider)?.models?.[model] || model;
}

function taskOutputKind(node) {
  return capabilityInfo(node?.capability)?.output || 'image';
}

// Effective value of a param: what the node sets, else the manifest default.
function taskParamValue(node, spec) {
  const value = node?.[spec.bucket]?.[spec.key];
  return value === undefined ? spec.default : value;
}

// Up to three params worth showing on the node card and in the footer.
const SUMMARY_KEYS = ['resolution', 'aspect_ratio', 'duration_s', 'count', 'template_id', 'language', 'speed', 'keyframe_time'];

function taskSummaryFields(node) {
  const specs = taskParamSpecs(node.provider, node.capability);
  const fields = [];
  for (const key of SUMMARY_KEYS) {
    const spec = specs.find(s => s.key === key);
    if (!spec) continue;
    const value = taskParamValue(node, spec);
    if (value === undefined || value === '') continue;
    const shown = key === 'duration_s' ? `${value}s` : key === 'count' ? `${value}×` : key === 'speed' ? `${value}×` : String(value);
    fields.push({ k: key === 'aspect_ratio' ? 'ratio' : key === 'duration_s' ? 'dur' : key === 'resolution' ? 'quality' : key.replace(/_/g, ' '), v: shown });
    if (fields.length === 3) break;
  }
  return fields;
}

// Title / badge / footer derived from the node's settings.
function taskNodeDecor(node) {
  const info = capabilityInfo(node.capability);
  const model = modelLabel(node.provider, node.model);
  const summary = taskSummaryFields(node).map(f => f.v).join(' · ');
  return {
    title: [info?.title || node.capability, model].filter(Boolean).join(' · '),
    badge: node.provider || 'task',
    footer: {
      ...(node.footer || {}),
      left: [node.provider, summary].filter(Boolean).join(' · '),
      right: node.footer?.right || '— idle',
    },
  };
}

function taskPortsFor(capability) {
  const info = capabilityInfo(capability);
  if (!info) return [];
  return [
    ...info.ports.map(p => ({ kind: p.kind, side: 'left', top: p.top, label: p.label, slot: p.slot })),
    { kind: info.output, side: 'right', top: info.output_top },
  ];
}

// A fresh task node for the palette / MCP, using the provider's initial values.
function spawnTaskNode(capability, provider) {
  const chosen = provider || providersFor(capability)[0]?.id;
  const entry = providerCapability(chosen, capability);
  if (!entry) throw new Error(`no provider supports ${capability}`);
  const init = entry.initial || {};
  const node = {
    kind: 'task',
    capability,
    provider: chosen,
    ...(init.model ? { model: init.model } : {}),
    params: JSON.parse(JSON.stringify(init.params || {})),
    provider_params: JSON.parse(JSON.stringify(init.provider_params || {})),
    w: 244,
    ports: taskPortsFor(capability),
    footer: { left: '', right: '— idle' },
  };
  return { ...node, ...taskNodeDecor(node) };
}

function withDecor(node) {
  return { ...node, ...taskNodeDecor(node) };
}

// Set (or clear, with undefined / '') one param, honouring `excludes`.
function setTaskParam(node, spec, value) {
  const bucket = { ...(node[spec.bucket] || {}) };
  if (value === undefined || value === '' || value === null || (spec.type === 'bool' && value === false)) {
    delete bucket[spec.key];
  } else {
    bucket[spec.key] = value;
  }
  let next = { ...node, [spec.bucket]: bucket };
  if (value === true) {
    for (const other of spec.excludes || []) {
      const otherSpec = taskParamSpecs(node.provider, node.capability).find(s => s.key === other);
      if (otherSpec) {
        const b = { ...(next[otherSpec.bucket] || {}) };
        delete b[other];
        next = { ...next, [otherSpec.bucket]: b };
      }
    }
  }
  return withDecor(next);
}

function setTaskModel(node, model) {
  const next = { ...node };
  if (model) next.model = model; else delete next.model;
  return withDecor(next);
}

// Move a node to another provider: keep params the target also accepts,
// drop the rest (reported so the UI can say what changed).
function switchTaskProvider(node, provider) {
  const target = providerCapability(provider, node.capability);
  if (!target) return { node, dropped: [] };
  const specs = taskParamSpecs(provider, node.capability);
  const dropped = [];
  const keep = (bucket) => Object.fromEntries(Object.entries(node[bucket] || {}).filter(([key]) => {
    const ok = key.startsWith('_') ? false : specs.some(s => s.key === key && s.bucket === bucket);
    if (!ok) dropped.push(key);
    return ok;
  }));
  const model = (target.models || []).includes(node.model) ? node.model : target.initial?.model;
  const next = { ...node, provider, params: keep('params'), provider_params: keep('provider_params') };
  if (model) next.model = model; else delete next.model;
  return { node: withDecor(next), dropped };
}

// Apply agent-supplied params (MCP add_node / set_params) to a task node.
// Returns { node } or { error }. Accepts the legacy key names older MCP
// clients used for PixVerse flags.
const LEGACY_PARAM_NAMES = { quality: 'resolution', duration: 'duration_s', duration_seconds: 'duration_s' };

function applyTaskParams(node, params) {
  let next = node;
  const p = { ...(params || {}) };
  if (typeof p.provider === 'string' && p.provider !== next.provider) {
    if (!providerCapability(p.provider, next.capability)) {
      const valid = providersFor(next.capability).map(m => m.id).join(', ');
      return { error: `provider "${p.provider}" does not support ${next.capability} — available: ${valid}` };
    }
    next = switchTaskProvider(next, p.provider).node;
  }
  delete p.provider;
  if (typeof p.model === 'string') next = setTaskModel(next, p.model);
  delete p.model;
  const specs = taskParamSpecs(next.provider, next.capability);
  for (const [rawKey, raw] of Object.entries(p)) {
    if (['title', 'prompt', 'path', 'selected_index'].includes(rawKey)) continue;
    const key = LEGACY_PARAM_NAMES[rawKey] || rawKey;
    const spec = specs.find(s => s.key === key);
    if (!spec) {
      return { error: `"${rawKey}" is not a parameter of ${next.capability} on ${next.provider} — valid: ${specs.map(s => s.key).join(', ')} (see describe_capabilities)` };
    }
    let value = raw;
    if (spec.type === 'bool' || spec.type === 'tri') {
      if (typeof value !== 'boolean') return { error: `"${rawKey}" must be true or false` };
    } else if (value !== null && value !== undefined) {
      const numeric = spec.type === 'int' || (spec.options || []).some(o => typeof o === 'number');
      if (numeric && String(value).trim() !== '' && Number.isFinite(Number(value))) value = Number(value);
      else if (typeof value !== 'string' && typeof value !== 'number') return { error: `"${rawKey}" must be a string or number` };
    }
    next = setTaskParam(next, spec, value);
  }
  return { node: next };
}

const TaskModel = {
  // catalog
  setProviderCatalog, loadProviderCatalog, providerCatalogList, capabilityIds, capabilityInfo, resolveCapability,
  providerManifest, providersFor, providerCapability, taskParamSpecs, providerName, modelLabel,
  taskOutputKind, taskParamValue, taskSummaryFields, taskNodeDecor, taskPortsFor, spawnTaskNode,
  setTaskParam, setTaskModel, switchTaskProvider, applyTaskParams,
  // migration
  PV_TASK_SPECS, isTaskNode, isLegacyPixVerseNode, migrateLegacyPixVerseNode,
};

if (typeof window !== 'undefined') Object.assign(window, TaskModel);
if (typeof module !== 'undefined' && module.exports) module.exports = TaskModel;
