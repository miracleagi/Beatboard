// MCP bridge — applies agent tool calls to the live canvas.
//
// Rust (src-tauri/src/mcp.rs) forwards each MCP tool call as an `mcp:op`
// event; this bridge executes it against the same reducer/runner the UI
// uses, then replies via the `mcp_response` command. The agent and the
// user are therefore editing the exact same graph, with undo intact.

// Agent-facing node type → palette template title (NODE_TEMPLATES in state.jsx)
const MCP_NODE_TYPES = {
  prompt: 'Prompt',
  asset: 'Asset / Reference',
  image: 'PixVerse · image',
  video: 'PixVerse · video',
  transition: 'PixVerse · transition',
  reference: 'PixVerse · reference',
  motion_control: 'PixVerse · motion control',
  extend: 'PixVerse · extend',
  upscale: 'PixVerse · upscale',
  speech: 'PixVerse · speech',
  pick: 'Pick · manual',
  ffmpeg_compose: 'ffmpeg · compose',
  output: 'Output',
};

// Param key → PixVerse CLI flag (rewritten in cli.args)
const MCP_CLI_FLAGS = {
  model: '--model',
  quality: '--quality',
  aspect_ratio: '--aspect-ratio',
  duration: '--duration',
  count: '--count',
  timeout: '--timeout',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mcpActiveProject(state) {
  return state.projects.find(p => p.id === state.activeProjectId) || state.projects[0];
}

// Give React a beat to flush the dispatched update before we reply (the next
// agent call reads stateRef and must see this op's effect).
function mcpFlush() {
  return new Promise(r => setTimeout(r, 30));
}

// Decode atlasmedia:// / asset:// preview URLs back to plain local paths —
// agents work with the filesystem, not with webview protocols.
function mcpLocalPath(value) {
  const s = String(value || '');
  if (/^(atlasmedia|asset):\/\/localhost/i.test(s)) {
    try {
      const pathname = new URL(s).pathname;
      const encoded = pathname.startsWith('/%2F') ? pathname.slice(1) : pathname;
      return decodeURIComponent(encoded);
    } catch (_) {}
  }
  return s;
}

function mcpNodeType(node) {
  if (node.kind === 'cli') {
    const bin = String(node.cli?.cmd || node.cli?.bin || '').trim().split(/\s+/)[0].split(/[\\/]/).pop();
    if (bin === 'ffmpeg') return 'ffmpeg_compose';
    if (bin === 'pixverse') {
      const sub = node.cli?.args?.[1] || 'image';
      return {
        'image': 'image', 'video': 'video', 'transition': 'transition',
        'reference': 'reference', 'motion-control': 'motion_control',
        'extend': 'extend', 'upscale': 'upscale', 'speech': 'speech',
      }[sub] || 'image';
    }
    return 'cli';
  }
  if (node.kind === 'select') return 'pick';
  return node.kind; // prompt | asset | output | gen | motion
}

function mcpThumbOutputs(result) {
  const thumbs = Array.isArray(result?.thumbs) ? result.thumbs : [];
  return thumbs
    .map(t => ({
      type: t.type === 'video' ? 'video' : 'image',
      path: mcpLocalPath(t.path || t.local_path || t.localPath || t.url || ''),
      ...(t.id ? { cloud_id: t.id } : {}),
      ...(t.chosen ? { chosen: true } : {}),
    }))
    .filter(o => o.path && o.path.startsWith('/'));
}

// Look up a node with a few retries — a just-dispatched add may not have
// rendered yet when the agent's next call arrives.
async function mcpFindNode(stateRef, id) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const proj = mcpActiveProject(stateRef.current);
    const node = proj && nodeById(proj.graph, id);
    if (node) return { node, proj };
    await new Promise(r => setTimeout(r, 60));
  }
  return { error: `node "${id}" not found — call get_graph to list nodes` };
}

// IDs handed out this session that may not be rendered into the graph yet
const mcpPendingIds = new Set();

function mcpMakeId(graph, prefix) {
  let i = 1;
  while (graph.nodes.some(n => n.id === `${prefix}${i}`) || mcpPendingIds.has(`${prefix}${i}`)) i += 1;
  const id = `${prefix}${i}`;
  mcpPendingIds.add(id);
  return id;
}

// Apply agent params onto a (copy of a) node. Shared by add_node/set_params.
function mcpApplyParams(node, params) {
  const p = params || {};
  const n = { ...node };
  if (typeof p.title === 'string' && p.title) n.title = p.title;
  if (typeof p.prompt === 'string') {
    // Works for prompt nodes (read via dep.from.prompt) AND generator nodes
    // (first_prompt in pixverse.rs checks node.prompt first).
    n.prompt = p.prompt;
    if (n.kind === 'prompt') {
      n.footer = { ...(n.footer || {}), left: p.prompt.slice(0, 24) || 'edit me' };
    }
  }
  if (n.kind === 'asset' && typeof p.path === 'string' && p.path.startsWith('/')) {
    const isVideo = /\.(mp4|mov|webm|m4v)$/i.test(p.path);
    const label = p.path.split('/').pop();
    n.thumbs = [{
      path: p.path,
      url: `atlasmedia://localhost/${encodeURIComponent(p.path)}`,
      label,
      type: isVideo ? 'video' : 'image',
      seed: p.path,
    }];
    if (!p.title) n.title = label;
  }
  if (n.kind === 'select' && Number.isFinite(p.selected_index)) {
    n.selectedIndex = p.selected_index;
  }
  if (n.kind === 'cli' && n.cli) {
    const args = [...(n.cli.args || [])];
    const fields = (n.cli.fields || []).map(f => ({ ...f }));
    for (const [key, flag] of Object.entries(MCP_CLI_FLAGS)) {
      if (p[key] == null) continue;
      const value = String(p[key]);
      const i = args.indexOf(flag);
      if (i >= 0 && i + 1 < args.length) {
        args[i + 1] = value;
      } else {
        const j = args.indexOf('--json');
        args.splice(j >= 0 ? j : args.length, 0, flag, value);
      }
      const fieldKey = key === 'aspect_ratio' ? 'ratio' : key;
      const field = fields.find(f => f.k === fieldKey);
      if (field) field.v = value;
    }
    n.cli = { ...n.cli, args, fields };
  }
  return n;
}

// ─── Tool handlers ───────────────────────────────────────────────────────────

function mcpGetGraph(stateRef) {
  const proj = mcpActiveProject(stateRef.current);
  if (!proj) return { error: 'no active project' };
  const runner = window.AtlasRunner;
  const persisted = proj.runResults || {};
  return {
    project: proj.name,
    run_active: !!(runner && runner.state.active),
    nodes: proj.graph.nodes.map(n => {
      const live = runner && runner.state.active ? runner.state.results[n.id] : null;
      const r = live || persisted[n.id];
      return {
        id: n.id,
        type: mcpNodeType(n),
        title: n.title,
        ...(n.prompt ? { prompt: n.prompt } : {}),
        ...(n.kind === 'cli' && n.cli
          ? { command: [n.cli.cmd || n.cli.bin, ...(n.cli.args || [])].join(' ') }
          : {}),
        ...(n.kind === 'asset'
          ? { path: mcpLocalPath(n.thumbs?.[0]?.path || n.thumbs?.[0]?.url || '') }
          : {}),
        ...(n.kind === 'select' && n.selectedIndex != null ? { selected_index: n.selectedIndex } : {}),
        inputs: (n.ports || []).filter(p => p.side === 'left').map(p => p.label || p.kind),
        result_state: r ? (r.state || 'done') : 'idle',
      };
    }),
    edges: proj.graph.edges.map(e => {
      const toN = nodeById(proj.graph, e.to.node);
      const port = toN?.ports?.[e.to.port];
      return { from: e.from.node, to: e.to.node, ...(port?.label ? { to_port: port.label } : {}) };
    }),
  };
}

async function mcpAddNode(args, stateRef, dispatch) {
  const title = MCP_NODE_TYPES[args.type];
  if (!title) {
    return { error: `unknown node type "${args.type}" — valid: ${Object.keys(MCP_NODE_TYPES).join(', ')}` };
  }
  const tpl = NODE_TEMPLATES.find(t => t.title === title);
  if (!tpl) return { error: `palette template missing for "${args.type}"` };
  const proj = mcpActiveProject(stateRef.current);
  if (!proj) return { error: 'no active project' };

  const fresh = mcpApplyParams(tpl.spawn(), args.params);
  const id = mcpMakeId(proj.graph, tpl.kind.slice(0, 3));
  const count = proj.graph.nodes.length;
  const x = Number.isFinite(args.x) ? args.x : 80 + (count % 4) * 300;
  const y = Number.isFinite(args.y) ? args.y : 80 + Math.floor(count / 4) * 230;

  dispatch({ type: 'PATCH_GRAPH', fn: g => ({
    ...g,
    nodes: [...g.nodes, { ...fresh, id, x, y }],
  })});
  await mcpFlush();
  return {
    ok: true,
    node_id: id,
    type: args.type,
    title: fresh.title,
    inputs: (fresh.ports || []).filter(p => p.side === 'left').map(p => p.label || p.kind),
  };
}

async function mcpConnectNodes(args, stateRef, dispatch) {
  const fromFound = await mcpFindNode(stateRef, args.from_node);
  if (fromFound.error) return { error: fromFound.error };
  const toFound = await mcpFindNode(stateRef, args.to_node);
  if (toFound.error) return { error: toFound.error };
  const fromN = fromFound.node;
  const toN = toFound.node;
  const graph = mcpActiveProject(stateRef.current).graph;

  const fromPort = (fromN.ports || []).findIndex(p => p.side === 'right');
  if (fromPort < 0) return { error: `node "${fromN.id}" has no output port` };

  const leftPorts = (toN.ports || [])
    .map((p, idx) => ({ p, idx }))
    .filter(x => x.p.side === 'left');
  let candidates;
  if (args.to_port) {
    candidates = leftPorts.filter(x => (x.p.label || x.p.kind) === args.to_port);
    if (!candidates.length) {
      return { error: `node "${toN.id}" has no input port "${args.to_port}" — available: ${leftPorts.map(x => x.p.label || x.p.kind).join(', ')}` };
    }
  } else {
    // Prefer free ports, but allow stacking onto occupied ones (ffmpeg clips)
    const occupied = new Set(graph.edges.filter(e => e.to.node === toN.id).map(e => e.to.port));
    candidates = [
      ...leftPorts.filter(x => !occupied.has(x.idx)),
      ...leftPorts.filter(x => occupied.has(x.idx)),
    ];
  }

  let lastReason = 'no compatible input port';
  for (const { idx } of candidates) {
    const verdict = canConnect(graph, { node: fromN.id, port: fromPort }, { node: toN.id, port: idx });
    if (verdict.ok) {
      dispatch({ type: 'PATCH_GRAPH', fn: g => ({
        ...g,
        edges: [...g.edges, { from: { node: fromN.id, port: fromPort }, to: { node: toN.id, port: idx } }],
      })});
      await mcpFlush();
      return { ok: true, from: fromN.id, to: toN.id, to_port: toN.ports[idx].label || toN.ports[idx].kind };
    }
    lastReason = verdict.reason;
  }
  return { error: `cannot connect ${fromN.id} → ${toN.id}: ${lastReason}` };
}

async function mcpSetParams(args, stateRef, dispatch) {
  const found = await mcpFindNode(stateRef, args.node_id);
  if (found.error) return { error: found.error };
  dispatch({ type: 'PATCH_GRAPH', fn: g => ({
    ...g,
    nodes: g.nodes.map(n => (n.id === args.node_id ? mcpApplyParams(n, args.params) : n)),
  })});
  await mcpFlush();
  const proj = mcpActiveProject(stateRef.current);
  const node = nodeById(proj.graph, args.node_id) || found.node;
  return {
    ok: true,
    node_id: node.id,
    title: node.title,
    ...(node.prompt ? { prompt: node.prompt } : {}),
    ...(node.kind === 'cli' && node.cli
      ? { command: [node.cli.cmd || node.cli.bin, ...(node.cli.args || [])].join(' ') }
      : {}),
  };
}

async function mcpRunNode(args, stateRef) {
  const runner = window.AtlasRunner;
  if (!runner) return { error: 'canvas runner not ready — is a project open?' };
  if (runner.state.active) {
    return { error: 'a run is already in progress — poll get_node_result, or wait for it to finish' };
  }
  let startId;
  if (args.node_id) {
    const found = await mcpFindNode(stateRef, args.node_id);
    if (found.error) return { error: found.error };
    startId = args.node_id;
  }
  const proj = mcpActiveProject(stateRef.current);
  const order = runOrderNodeIds(proj.graph, startId);
  if (!order.length) return { error: 'nothing to run — the graph is empty' };
  runner.start(startId); // fire and forget; agent polls get_node_result
  return {
    ok: true,
    running: order,
    note: 'poll get_node_result on the node(s) you care about — generator nodes can take minutes',
  };
}

async function mcpGetNodeResult(args, stateRef) {
  const found = await mcpFindNode(stateRef, args.node_id);
  if (found.error) return { error: found.error };
  const runner = window.AtlasRunner;

  const waiting = runner?.state?.waitingForPick;
  if (waiting && waiting.nodeId === args.node_id) {
    return {
      node_id: args.node_id,
      state: 'waiting_for_pick',
      candidates: waiting.candidates.length,
      note: 'run paused — the user must click a thumbnail in the Atlas window',
    };
  }

  const proj = mcpActiveProject(stateRef.current);
  const live = runner && runner.state.active ? runner.state.results[args.node_id] : null;
  const result = live || (proj.runResults || {})[args.node_id] || null;
  if (!result) {
    return { node_id: args.node_id, state: 'idle', run_active: !!(runner && runner.state.active) };
  }
  const state = result.state || 'done';
  return {
    node_id: args.node_id,
    state,
    ...(state === 'running' ? { progress: Math.round((result.progress || 0) * 100) / 100 } : {}),
    ...(state === 'error' ? { error: result.error } : {}),
    ...(state === 'done' ? { outputs: mcpThumbOutputs(result) } : {}),
    run_active: !!(runner && runner.state.active),
  };
}

// ─── Bridge hook (mounted once from App in editor-app.jsx) ───────────────────

function useMcpBridge({ stateRef, dispatch }) {
  React.useEffect(() => {
    if (!window.__TAURI__) return; // browser/prototype mode — no MCP
    const { invoke } = window.__TAURI__.tauri;
    const { listen } = window.__TAURI__.event;
    let unlisten = null;
    let disposed = false;

    const HANDLERS = {
      get_graph: args => mcpGetGraph(stateRef),
      add_node: args => mcpAddNode(args, stateRef, dispatch),
      connect_nodes: args => mcpConnectNodes(args, stateRef, dispatch),
      set_params: args => mcpSetParams(args, stateRef, dispatch),
      run_node: args => mcpRunNode(args, stateRef),
      get_node_result: args => mcpGetNodeResult(args, stateRef),
    };

    listen('mcp:op', async event => {
      const { id, tool, args } = event.payload || {};
      let result;
      try {
        const handler = HANDLERS[tool];
        result = handler ? await handler(args || {}) : { error: `unknown tool "${tool}"` };
      } catch (e) {
        result = { error: String((e && e.message) || e) };
      }
      try {
        await invoke('mcp_response', { id, result });
      } catch (_) { /* window closing */ }
    }).then(fn => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);
}

Object.assign(window, { useMcpBridge });
