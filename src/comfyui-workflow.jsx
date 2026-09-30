// ComfyUI workflows on task nodes (provider `comfyui`, capability
// `comfyui.workflow`).
//
// The user exports a workflow from ComfyUI in API format (Workflow → Export
// (API)) and imports it here. We suggest bindings — which node input takes
// the prompt, the negative prompt, the seed, which Load* nodes take the
// Beatboard node's connected media, which node is the output — and the user
// adjusts them in the Inspector. The node then carries:
//
//   workflow: { name, graph: <API JSON>, output_kind: 'image' | 'video' | 'audio',
//               bindings: { prompt: { node, input } | null, negative: … | null,
//                           seed: [{ node, input }], inputs: [{ node, input, kind }],
//                           output: '<node id>' | null } }
//
// Input ports follow the bindings: `prompt` (slot `prompt`) when a prompt is
// bound, then one port per bound media input (slot `in@<node id>`). The Rust
// provider (src-tauri/src/providers/comfyui) reads the same shape.
//
// Plain JS on purpose: loaded by the app and by Node in tests.

// Load nodes whose file input can be fed from a Beatboard port.
// class_type → [input name, media kind]
const COMFY_MEDIA_LOADERS = {
  LoadImage: ['image', 'image'],
  LoadImageMask: ['image', 'image'],
  LoadImageOutput: ['image', 'image'],
  LoadVideo: ['file', 'video'],
  VHS_LoadVideo: ['video', 'video'],
  VHS_LoadVideoFFmpeg: ['video', 'video'],
  LoadAudio: ['audio', 'audio'],
  VHS_LoadAudioUpload: ['audio', 'audio'],
};

const COMFY_TEXT_INPUTS = ['text', 'prompt', 'text_g', 'text_l', 'positive', 'negative', 'string'];
const COMFY_SEED_INPUTS = ['seed', 'noise_seed'];

function isComfyLink(value) {
  return Array.isArray(value);
}

// Parse imported text into an API-format graph. Returns { graph } or { error }.
function parseComfyWorkflow(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (e) {
    return { error: 'This file is not valid JSON.' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'This is not a ComfyUI workflow.' };
  }
  if (Array.isArray(data.nodes) && Array.isArray(data.links)) {
    return { error: 'This is the ComfyUI editor format. In ComfyUI choose Workflow → Export (API) and import that file instead.' };
  }
  // Accept a queued prompt body ({ prompt: {…} }) too.
  const graph = data.prompt && typeof data.prompt === 'object' && !Array.isArray(data.prompt) ? data.prompt : data;
  const ids = Object.keys(graph);
  if (!ids.length) return { error: 'The workflow is empty.' };
  const bad = ids.find(id => !graph[id] || typeof graph[id].class_type !== 'string' || !graph[id].inputs || typeof graph[id].inputs !== 'object');
  if (bad !== undefined) {
    return { error: `Node "${bad}" is not in ComfyUI's API format. In ComfyUI choose Workflow → Export (API).` };
  }
  return { graph };
}

function comfyNodeIds(graph) {
  // ComfyUI ids are numeric strings (sometimes "12:3" inside subgraphs).
  return Object.keys(graph).sort((a, b) => {
    const na = parseFloat(a), nb = parseFloat(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function comfyNodeTitle(graph, id) {
  const node = graph?.[id];
  if (!node) return `#${id}`;
  return `#${id} ${node._meta?.title || node.class_type}`;
}

function comfyOutputKindOf(node) {
  const c = node?.class_type || '';
  if (/Audio/i.test(c)) return 'audio';
  if (/Video|WEBM|VideoCombine/i.test(c)) return 'video';
  return 'image';
}

// Everything in a graph that can be bound, for the Inspector's pickers.
function comfyCandidates(graph) {
  const text = [], seed = [], media = [], outputs = [];
  comfyNodeIds(graph).forEach(id => {
    const node = graph[id];
    const inputs = node.inputs || {};
    Object.entries(inputs).forEach(([input, value]) => {
      if (isComfyLink(value)) return;
      if (typeof value === 'string' && (COMFY_TEXT_INPUTS.includes(input) || /text|prompt/i.test(input))) {
        text.push({ node: id, input });
      }
      if (typeof value === 'number' && COMFY_SEED_INPUTS.includes(input)) seed.push({ node: id, input });
    });
    const loader = COMFY_MEDIA_LOADERS[node.class_type];
    if (loader && inputs[loader[0]] !== undefined && !isComfyLink(inputs[loader[0]])) {
      media.push({ node: id, input: loader[0], kind: loader[1] });
    }
    if (/^(Save|Preview)/.test(node.class_type) || node.class_type === 'VHS_VideoCombine') {
      outputs.push({ node: id, kind: comfyOutputKindOf(node), saves: node.class_type !== 'PreviewImage' && !/^Preview/.test(node.class_type) });
    }
  });
  return { text, seed, media, outputs };
}

// The text input feeding a sampler's `positive` / `negative` conditioning.
function comfyConditioningText(graph, candidates, which) {
  for (const id of comfyNodeIds(graph)) {
    const link = graph[id].inputs?.[which];
    if (!isComfyLink(link)) continue;
    const found = candidates.text.find(t => t.node === String(link[0]));
    if (found) return found;
  }
  return null;
}

// Best-guess bindings for a freshly imported graph.
function suggestComfyBindings(graph) {
  const c = comfyCandidates(graph);
  const titled = (re) => c.text.find(t => re.test(graph[t.node]._meta?.title || ''));
  let prompt = comfyConditioningText(graph, c, 'positive') || titled(/positive|prompt/i) || null;
  let negative = comfyConditioningText(graph, c, 'negative') || titled(/negative/i) || null;
  if (!prompt) prompt = c.text.find(t => graph[t.node].class_type === 'CLIPTextEncode' && t !== negative) || c.text.find(t => t !== negative) || null;
  if (negative && prompt && negative.node === prompt.node && negative.input === prompt.input) negative = null;
  const saved = c.outputs.filter(o => o.saves);
  const output = (saved[0] || c.outputs[0] || null)?.node || null;
  return {
    prompt,
    negative,
    seed: c.seed,
    inputs: c.media,
    output,
  };
}

function comfyOutputKind(graph, bindings) {
  if (bindings?.output && graph[bindings.output]) return comfyOutputKindOf(graph[bindings.output]);
  const c = comfyCandidates(graph);
  const saved = c.outputs.find(o => o.saves) || c.outputs[0];
  return saved ? saved.kind : 'image';
}

// Build the stored workflow object from a graph (and optional bindings).
function makeComfyWorkflow(graph, { name, bindings } = {}) {
  const b = bindings || suggestComfyBindings(graph);
  const clean = {
    prompt: b.prompt || null,
    negative: b.negative || null,
    seed: b.seed || [],
    inputs: b.inputs || [],
    output: b.output || null,
  };
  return {
    name: name || '',
    graph,
    bindings: clean,
    output_kind: comfyOutputKind(graph, clean),
  };
}

// Why a workflow's bindings can't run, or null. Mirrors check_workflow in
// src-tauri/src/providers/comfyui/mod.rs.
function checkComfyBindings(workflow) {
  const graph = workflow.graph || {};
  const b = workflow.bindings || {};
  const targets = [
    ['prompt', b.prompt], ['negative prompt', b.negative],
    ...(b.seed || []).map(t => ['seed', t]),
    ...(b.inputs || []).map(t => ['input', t]),
  ].filter(([, t]) => t);
  for (const [role, t] of targets) {
    if (!t || typeof t.node !== 'string' || typeof t.input !== 'string') return `the ${role} binding needs { node, input } (node ids are strings)`;
    const node = graph[t.node];
    if (!node) return `the ${role} is bound to node #${t.node}, which is not in the workflow`;
    if (!(t.input in (node.inputs || {}))) return `the ${role} is bound to ${comfyNodeTitle(graph, t.node)}.${t.input}, which does not exist`;
    if (isComfyLink(node.inputs[t.input])) return `the ${role} is bound to ${comfyNodeTitle(graph, t.node)}.${t.input}, which is wired to another node`;
  }
  for (const m of b.inputs || []) {
    if (!['image', 'video', 'audio'].includes(m.kind)) return `input ${comfyNodeTitle(graph, m.node)} needs kind image, video or audio`;
  }
  if (b.output && !graph[b.output]) return `the output is bound to node #${b.output}, which is not in the workflow`;
  return null;
}

// Input ports for a workflow's bindings (the output port is added by
// normalizedNodePorts from `output_kind`).
function comfyInputPorts(workflow) {
  const ports = [];
  const b = workflow?.bindings || {};
  if (b.prompt) ports.push({ kind: 'text', side: 'left', label: 'prompt', slot: 'prompt' });
  (b.inputs || []).forEach(m => {
    const node = workflow.graph?.[m.node];
    const title = node?._meta?.title && node._meta.title !== node.class_type ? node._meta.title : `${m.kind} #${m.node}`;
    ports.push({ kind: m.kind, side: 'left', label: title.slice(0, 14), slot: `in@${m.node}` });
  });
  return ports.map((p, i) => ({ ...p, top: 44 + i * 24 }));
}

function comfyOutputTop(leftCount) {
  return leftCount ? 44 + ((leftCount - 1) * 24) / 2 : 52;
}

// A comfyui node with this workflow: ports rebuilt, params the workflow can't
// take dropped. Edges are the caller's job (see replaceNodeKeepingEdges).
function withComfyWorkflow(node, workflow) {
  const left = comfyInputPorts(workflow);
  const next = {
    ...node,
    workflow,
    ports: [...left, { kind: workflow.output_kind || 'image', side: 'right', top: comfyOutputTop(left.length) }],
  };
  const reconcile = typeof reconcileTaskParams === 'function'
    ? reconcileTaskParams
    : require('./task-model.jsx').reconcileTaskParams;
  return reconcile(next).node;
}

// Replace a node, keeping edges whose ports still exist. Incoming edges follow
// their port's slot (or label when there is no slot); outgoing edges move to
// the new output port, and are dropped if its media kind changed.
function replaceNodeKeepingEdges(graph, next) {
  const old = graph.nodes.find(n => n.id === next.id);
  if (!old) return graph;
  const keyOf = p => `${p.kind}|${p.slot || p.label || ''}`;
  const newIndexByKey = {};
  (next.ports || []).forEach((p, i) => { if (p.side === 'left') newIndexByKey[keyOf(p)] = i; });
  const oldOut = (old.ports || []).find(p => p.side === 'right');
  const newOutIndex = (next.ports || []).findIndex(p => p.side === 'right');
  const newOut = next.ports?.[newOutIndex];
  const edges = [];
  graph.edges.forEach(e => {
    if (e.to?.node === next.id) {
      const port = old.ports?.[e.to.port];
      const idx = port ? newIndexByKey[keyOf(port)] : undefined;
      if (idx !== undefined) edges.push({ ...e, to: { ...e.to, port: idx } });
    } else if (e.from?.node === next.id) {
      if (newOutIndex >= 0 && (!oldOut || !newOut || oldOut.kind === newOut.kind)) {
        edges.push({ ...e, from: { ...e.from, port: newOutIndex } });
      }
    } else {
      edges.push(e);
    }
  });
  return { ...graph, nodes: graph.nodes.map(n => (n.id === next.id ? next : n)), edges };
}

function comfyBindingSummary(workflow) {
  if (!workflow) return null;
  const b = workflow.bindings || {};
  const at = t => (t ? `${comfyNodeTitle(workflow.graph, t.node)}.${t.input}` : null);
  return {
    name: workflow.name || '',
    nodes: Object.keys(workflow.graph || {}).length,
    output_kind: workflow.output_kind,
    prompt: at(b.prompt),
    negative: at(b.negative),
    seed: (b.seed || []).map(at),
    inputs: (b.inputs || []).map(m => `${at(m)} (${m.kind})`),
    output: b.output ? comfyNodeTitle(workflow.graph, b.output) : null,
  };
}

const ComfyWorkflow = {
  COMFY_MEDIA_LOADERS, parseComfyWorkflow, comfyNodeIds, comfyNodeTitle, comfyCandidates, suggestComfyBindings,
  comfyOutputKind, makeComfyWorkflow, checkComfyBindings, comfyInputPorts, withComfyWorkflow,
  replaceNodeKeepingEdges, comfyBindingSummary,
};

if (typeof window !== 'undefined') Object.assign(window, ComfyWorkflow);
if (typeof module !== 'undefined' && module.exports) module.exports = ComfyWorkflow;
