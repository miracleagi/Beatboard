// MCP bridge — applies agent tool calls to the live canvas.
//
// Rust (src-tauri/src/mcp.rs) forwards each MCP tool call as an `mcp:op`
// event; this bridge executes it against the same reducer/runner the UI
// uses, then replies via the `mcp_response` command. The agent and the
// user are therefore editing the exact same graph, with undo intact.

// Agent-facing non-generator node types → palette template title
// (NODE_TEMPLATES in state.jsx). Generator types are capabilities from the
// provider catalog (e.g. `video.generate`), or their legacy aliases (`video`).
const MCP_NODE_TYPES = {
  prompt: 'Prompt',
  asset: 'Asset / Reference',
  pick: 'Pick · manual',
  ffmpeg_compose: 'ffmpeg · compose',
  output: 'Output',
};

function mcpValidTypes() {
  const aliases = capabilityIds().flatMap(id => capabilityInfo(id).aliases || []);
  return [...Object.keys(MCP_NODE_TYPES), ...capabilityIds(), ...aliases];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mcpActiveProject(state) {
  return state.projects.find(p => p.id === state.activeProjectId) || state.projects[0];
}

function mcpProjectSummary(project, activeProjectId) {
  return {
    id: project.id,
    name: project.name,
    color: project.color,
    output_dir: project.outputDir || '',
    node_count: project.graph?.nodes?.length || 0,
    edge_count: project.graph?.edges?.length || 0,
    modified_at: project.modifiedAt || null,
    active: project.id === activeProjectId,
  };
}

function mcpProjectMutationError() {
  const runner = window.AtlasRunner;
  return runner?.state?.active
    ? 'cannot create, switch, or delete projects while a graph run is active'
    : null;
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
  if (node.kind === 'task') return node.capability;
  if (node.kind === 'cli') {
    const bin = String(node.cli?.cmd || node.cli?.bin || '').trim().split(/\s+/)[0].split(/[\\/]/).pop();
    return bin === 'ffmpeg' ? 'ffmpeg_compose' : 'cli';
  }
  if (node.kind === 'select') return 'pick';
  return node.kind; // prompt | asset | output | gen | motion
}

// Generator settings as agents see them: provider, model and one flat param map.
function mcpTaskSettings(node) {
  if (node.kind !== 'task') return {};
  return {
    provider: node.provider,
    ...(node.model ? { model: node.model } : {}),
    params: { ...(node.params || {}), ...(node.provider_params || {}) },
  };
}

function mcpThumbOutputs(result) {
  const thumbs = Array.isArray(result?.thumbs) ? result.thumbs : [];
  return thumbs
    .map(t => ({
      type: t.type === 'audio' ? 'audio' : t.type === 'video' ? 'video' : 'image',
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
// Returns { node } or { error }.
function mcpApplyParams(node, params) {
  const p = params || {};
  let n = { ...node };
  if (typeof p.title === 'string' && p.title) n.title = p.title;
  if (typeof p.prompt === 'string') {
    // Works for prompt nodes (read via dep.from.prompt) AND generator nodes
    // (first_prompt in providers/inputs.rs checks node.prompt first).
    n.prompt = p.prompt;
    if (n.kind === 'prompt') {
      n.footer = { ...(n.footer || {}), left: p.prompt.slice(0, 24) || 'edit me' };
    }
  }
  if (n.kind === 'asset' && typeof p.path === 'string' && p.path.startsWith('/')) {
    const isVideo = /\.(mp4|mov|webm|m4v)$/i.test(p.path);
    const isAudio = /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(p.path);
    const label = p.path.split('/').pop();
    n.thumbs = [{
      path: p.path,
      url: `atlasmedia://localhost/${encodeURIComponent(p.path)}`,
      label,
      type: isAudio ? 'audio' : isVideo ? 'video' : 'image',
      seed: p.path,
    }];
    if (!p.title) n.title = label;
  }
  if (n.kind === 'select' && Number.isFinite(p.selected_index)) {
    n.selectedIndex = p.selected_index;
  }
  if (n.kind === 'task') {
    if (n.provider_params?._raw_args) {
      const settings = Object.keys(p).filter(k => !['title', 'prompt'].includes(k));
      if (settings.length) {
        return { error: `node "${n.id}" runs a hand-edited command; reset it in the Inspector before changing ${settings.join(', ')}` };
      }
    } else {
      const applied = applyTaskParams(n, p);
      if (applied.error) return { error: applied.error };
      // Keep a title the agent set explicitly over the derived one.
      n = { ...applied.node, ...(typeof p.title === 'string' && p.title ? { title: p.title } : {}) };
    }
  }
  return { node: n };
}

// ─── Tool handlers ───────────────────────────────────────────────────────────

function mcpListProjects(stateRef) {
  const state = stateRef.current;
  return {
    active_project_id: state.activeProjectId || null,
    projects: (state.projects || []).map(project => mcpProjectSummary(project, state.activeProjectId)),
  };
}

async function mcpCreateProject(args, stateRef, dispatch) {
  const mutationError = mcpProjectMutationError();
  if (mutationError) return { error: mutationError };

  const name = typeof args.name === 'string' && args.name.trim()
    ? args.name.trim().slice(0, 120)
    : 'Untitled';
  const color = typeof args.color === 'string' && /^#[0-9a-f]{6}$/i.test(args.color)
    ? args.color
    : '#7fc8ff';
  const outputDir = typeof args.output_dir === 'string' ? args.output_dir.trim() : '';
  if (outputDir && !outputDir.startsWith('/')) {
    return { error: 'output_dir must be an absolute local directory path' };
  }

  dispatch({
    type: 'NEW_PROJECT',
    name,
    color,
    outputDir,
    graph: { nodes: [], edges: [] },
  });
  await mcpFlush();
  const state = stateRef.current;
  const project = mcpActiveProject(state);
  if (!project) return { error: 'project creation did not complete' };
  return {
    ok: true,
    project: mcpProjectSummary(project, state.activeProjectId),
    note: 'the new blank project is now active',
  };
}

async function mcpSwitchProject(args, stateRef, dispatch) {
  const mutationError = mcpProjectMutationError();
  if (mutationError) return { error: mutationError };

  const state = stateRef.current;
  const project = (state.projects || []).find(item => item.id === args.project_id);
  if (!project) {
    return { error: `project "${args.project_id || ''}" not found — call list_projects first` };
  }
  if (project.id !== state.activeProjectId) {
    dispatch({ type: 'SWITCH_PROJECT', id: project.id });
    await mcpFlush();
  }
  const nextState = stateRef.current;
  return {
    ok: true,
    project: mcpProjectSummary(project, nextState.activeProjectId),
  };
}

async function mcpDeleteProject(args, stateRef, dispatch) {
  const mutationError = mcpProjectMutationError();
  if (mutationError) return { error: mutationError };

  const state = stateRef.current;
  const projects = state.projects || [];
  const project = projects.find(item => item.id === args.project_id);
  if (!project) {
    return { error: `project "${args.project_id || ''}" not found — call list_projects first` };
  }
  if (args.confirm !== true) {
    return { error: 'delete_project requires confirm=true' };
  }
  if (projects.length <= 1) {
    return { error: 'cannot delete the last canvas project; create another project first' };
  }

  dispatch({ type: 'CLOSE_PROJECT', id: project.id });
  await mcpFlush();
  const nextState = stateRef.current;
  const active = mcpActiveProject(nextState);
  return {
    ok: true,
    deleted_project: { id: project.id, name: project.name },
    active_project: active ? mcpProjectSummary(active, nextState.activeProjectId) : null,
    note: 'the Beatboard project was removed; generated media files on disk were not deleted',
  };
}

function mcpGetGraph(stateRef) {
  const proj = mcpActiveProject(stateRef.current);
  if (!proj) return { error: 'no active project' };
  const runner = window.AtlasRunner;
  const persisted = proj.runResults || {};
  return {
    project_id: proj.id,
    project: proj.name,
    output_dir: proj.outputDir || '',
    run_active: !!(runner && runner.state.active),
    nodes: proj.graph.nodes.map(n => {
      const live = runner && runner.state.active ? runner.state.results[n.id] : null;
      const r = live || persisted[n.id];
      return {
        id: n.id,
        type: mcpNodeType(n),
        title: n.title,
        ...(n.prompt ? { prompt: n.prompt } : {}),
        ...mcpTaskSettings(n),
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
  const capability = resolveCapability(args.type);
  const title = MCP_NODE_TYPES[args.type];
  if (!capability && !title) {
    return { error: `unknown node type "${args.type}" — valid: ${mcpValidTypes().join(', ')}` };
  }
  const proj = mcpActiveProject(stateRef.current);
  if (!proj) return { error: 'no active project' };

  let spawned;
  if (capability) {
    const provider = args.params?.provider;
    if (provider && !providerCapability(provider, capability)) {
      return { error: `provider "${provider}" does not support ${capability} — available: ${providersFor(capability).map(m => m.id).join(', ')}` };
    }
    spawned = spawnTaskNode(capability, provider);
  } else {
    const tpl = NODE_TEMPLATES.find(t => t.title === title);
    if (!tpl) return { error: `palette template missing for "${args.type}"` };
    spawned = tpl.spawn();
  }
  const applied = mcpApplyParams(spawned, args.params);
  if (applied.error) return { error: applied.error };
  const fresh = applied.node;
  const id = mcpMakeId(proj.graph, nodeIdPrefix(fresh.kind));
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
    type: capability || args.type,
    title: fresh.title,
    ...mcpTaskSettings(fresh),
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
  const applied = mcpApplyParams(found.node, args.params);
  if (applied.error) return { error: applied.error };
  dispatch({ type: 'PATCH_GRAPH', fn: g => ({
    ...g,
    nodes: g.nodes.map(n => (n.id === args.node_id ? { ...applied.node, x: n.x, y: n.y } : n)),
  })});
  await mcpFlush();
  const proj = mcpActiveProject(stateRef.current);
  const node = nodeById(proj.graph, args.node_id) || applied.node;
  return {
    ok: true,
    node_id: node.id,
    title: node.title,
    ...(node.prompt ? { prompt: node.prompt } : {}),
    ...mcpTaskSettings(node),
  };
}

async function mcpCompareNode(args, stateRef, dispatch) {
  const found = await mcpFindNode(stateRef, args.node_id);
  if (found.error) return { error: found.error };
  const variants = (args.variants || []).map(v => ({ provider: v.provider, model: v.model }));
  const result = buildComparison(found.proj.graph, args.node_id, variants);
  if (result.error) {
    const options = comparisonOptions(found.node.capability || '').map(o => `${o.provider}${o.model ? `/${o.model}` : ''}`);
    return { error: `${result.error}${options.length ? ` — options: ${options.join(', ')}` : ''}` };
  }
  dispatch({ type: 'PATCH_GRAPH', fn: g => buildComparison(g, args.node_id, variants).graph || g });
  await mcpFlush();
  return {
    ok: true,
    pick_node_id: result.pickId,
    variant_node_ids: result.variantIds,
    ...(Object.keys(result.changes).length ? { adjusted_params: result.changes } : {}),
    note: 'run_node on the pick node runs every variant, then pauses for the user to pick; each variant is a separate paid run',
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
  const order = runOrderNodeIds(proj.graph, startId, {
    getResult: id => (proj.runResults || {})[id],
  });
  if (!order.length) return { error: 'nothing to run — the graph is empty' };
  const state = stateRef.current;
  const limit = 'paidRunLimit' in state.config ? state.config.paidRunLimit : DEFAULT_PAID_RUN_LIMIT;
  const paid = paidRunSummary(proj.graph, order);
  runner.start(startId); // fire and forget; agent polls get_node_result
  return {
    ok: true,
    running: order,
    paid_generations: paid.total,
    ...(needsPaidRunConfirmation(paid, limit)
      ? { needs_user_confirmation: true, note_confirmation: `above the user's limit of ${limit} paid generations — the run waits until they confirm in the Beatboard window` }
      : {}),
    note: 'poll get_node_result on the node(s) you care about — generator nodes can take minutes',
  };
}

async function mcpGetNodeResult(args, stateRef) {
  const found = await mcpFindNode(stateRef, args.node_id);
  if (found.error) return { error: found.error };
  const runner = window.AtlasRunner;

  if (runner?.state?.waitingForConfirm) {
    return {
      node_id: args.node_id,
      state: 'waiting_for_confirmation',
      note: 'the run submits more paid generations than the user allows without asking — they must confirm in the Beatboard window',
    };
  }
  const waiting = runner?.state?.waitingForPick;
  if (waiting && waiting.nodeId === args.node_id) {
    return {
      node_id: args.node_id,
      state: 'waiting_for_pick',
      candidates: waiting.candidates.length,
      note: 'run paused — the user must click a thumbnail in the Beatboard window',
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
    ...(state === 'error' || state === 'blocked' ? { error: result.error, blocked_by: result.blockedBy } : {}),
    ...(state === 'interrupted' ? { note: 'Beatboard quit while this ran; the user can Resume it from the Inspector to collect the result without re-running' } : {}),
    ...(state === 'done' ? { outputs: mcpThumbOutputs(result) } : {}),
    ...(state === 'done' && result.cost ? { cost: result.cost } : {}),
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
      list_projects: args => mcpListProjects(stateRef),
      create_project: args => mcpCreateProject(args, stateRef, dispatch),
      switch_project: args => mcpSwitchProject(args, stateRef, dispatch),
      delete_project: args => mcpDeleteProject(args, stateRef, dispatch),
      get_graph: args => mcpGetGraph(stateRef),
      add_node: args => mcpAddNode(args, stateRef, dispatch),
      connect_nodes: args => mcpConnectNodes(args, stateRef, dispatch),
      set_params: args => mcpSetParams(args, stateRef, dispatch),
      compare_node: args => mcpCompareNode(args, stateRef, dispatch),
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
