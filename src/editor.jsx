// Editor canvas — owns all live interactions: drag nodes, drag-connect ports,
// click edges, context menu, plus the topo runner that paints execution
// state onto nodes in real time.

// ---- TOPO RUNNER ----
// Walks the graph in topological order, calling Executor.runNode for each.
// Local state (runRef + version) drives per-frame progress; persisted results
// land in project.runResults at the end so they survive reload.
function useRunner({ projectId, projectName, projectOutputDir, graph, dispatch, config, getRunResult }) {
  const EMPTY = { active: false, results: {}, current: null, progress: 0, aborted: false, queue: [], waitingForPick: null };
  const ref = React.useRef({ ...EMPTY });
  const [, force] = React.useReducer(x => x + 1, 0);

  const start = React.useCallback(async (fromNodeId) => {
    if (ref.current.active) return;
    const order = runOrderNodeIds(graph, fromNodeId, { getResult: getRunResult });

    // Budget gate: runs that would submit more paid generations than the
    // user's limit wait for an explicit OK (the run is marked active so a
    // second click can't start another one meanwhile).
    const paid = paidRunSummary(graph, order);
    const limit = config && 'paidRunLimit' in config ? config.paidRunLimit : DEFAULT_PAID_RUN_LIMIT;
    if (needsPaidRunConfirmation(paid, limit)) {
      const confirmed = await new Promise(resolve => {
        ref.current = { ...EMPTY, active: true, waitingForConfirm: { summary: paid, limit, resolve } };
        force();
      });
      if (!confirmed) {
        ref.current = { ...EMPTY };
        force();
        return;
      }
    }

    const queuedResults = Object.fromEntries(order.map(id => [id, { state: 'queued', progress: 0 }]));
    dispatch({ type: 'CLEAR_RUN_RESULTS_FOR_NODES', projectId, nodeIds: order });
    ref.current = { active: true, results: queuedResults, current: null, progress: 0, aborted: false, queue: order, waitingForPick: null };
    force();

    // Hard failures collected across the run; surfaced once in an error
    // dialog when the run finishes (blocked nodes are not hard failures).
    const runErrors = [];

    for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
      const id = order[orderIndex];
      if (ref.current.aborted) break;
      const node = graph.nodes.find(n => n.id === id);
      if (!node) continue;

      ref.current.current = id;
      ref.current.progress = 0;
      ref.current.queue = order.slice(orderIndex + 1);
      ref.current.results[id] = { state: 'waiting_dependencies', progress: 0 };
      force();

      const resultForSource = sourceId => ref.current.results[sourceId] || getRunResult(sourceId);
      const requiredEdges = activeDepsForRun(graph, id);
      const optionalReadyEdges = graph.edges.filter(e => {
        if (e.to.node !== id || !e.dashed) return false;
        const source = graph.nodes.find(n => n.id === e.from.node);
        return nodeHasUsableOutput(source, resultForSource(e.from.node));
      });
      const deps = [...requiredEdges, ...optionalReadyEdges].map(e => {
        const fromNode = graph.nodes.find(n => n.id === e.from.node);
        const result = resultForSource(e.from.node);
        return { edge: e, from: fromNode, result };
      });

      const readiness = dependencyReadiness(graph, id, resultForSource);
      if (!readiness.ok) {
        const blockedBy = readiness.missing.map(dep => dep.source?.id || dep.edge.from.node);
        const details = readiness.missing.map(dep => {
          const label = dep.source?.title || dep.source?.id || dep.edge.from.node;
          return `${label} (${dep.reason.replace(/_/g, ' ')})`;
        });
        const blockedResult = {
          state: 'blocked', progress: 0, blockedBy,
          error: `Waiting for required input: ${details.join(', ')}`,
        };
        ref.current.results[id] = blockedResult;
        dispatch({ type: 'SET_RUN_RESULT', projectId, nodeId: id, result: blockedResult });
        force();
        continue;
      }

      // ── Pick / Select node: pause and wait for user to choose ──────────
      if (node.kind === 'select') {
        // Only inputs that produced output count — a failed variant in a
        // comparison must not contribute thumbnails cached from older runs.
        const readyDeps = deps.filter(d => nodeHasUsableOutput(d.from, d.result));
        const candidates = upstreamThumbs(readyDeps, { forSelect: true });
        if (!candidates.length) {
          ref.current.results[id] = { state: 'error', progress: 0, error: 'No upstream results yet — run upstream nodes first.' };
          dispatch({ type: 'SET_RUN_RESULT', projectId, nodeId: id, result: ref.current.results[id] });
          runErrors.push({ nodeId: id, title: node.title || id, error: ref.current.results[id].error });
          force();
          continue;
        }
        // Only 1 candidate — nothing to choose, auto-select and move on
        if (candidates.length === 1) {
          const result = { selectedIndex: 0, thumbs: [{ ...candidates[0], chosen: true }], state: 'done', progress: 1 };
          ref.current.results[id] = result;
          dispatch({ type: 'SET_RUN_RESULT', projectId, nodeId: id, result });
          dispatch({ type: 'PATCH_GRAPH', fn: g => ({
            ...g, nodes: g.nodes.map(n => n.id === id ? { ...n, selectedIndex: 0 } : n),
          }), preserveResults: true });
          force();
          continue;
        }

        // Suspend the run until the user clicks a thumbnail
        ref.current.results[id] = { state: 'waiting_user', progress: 0 };
        const selectedIndex = await new Promise(resolve => {
          ref.current.waitingForPick = { nodeId: id, candidates, resolve };
          force();
        });
        if (ref.current.aborted || selectedIndex < 0) break;

        const thumbs = candidates.map((t, i) => ({ ...t, chosen: i === selectedIndex }));
        const pickResult = { selectedIndex, thumbs, state: 'done', progress: 1 };
        ref.current.results[id] = pickResult;
        dispatch({ type: 'SET_RUN_RESULT', projectId, nodeId: id, result: pickResult });
        dispatch({ type: 'PATCH_GRAPH', fn: g => ({
          ...g, nodes: g.nodes.map(n => n.id === id ? { ...n, selectedIndex } : n),
        }), preserveResults: true });
        force();
        continue;
      }
      // ───────────────────────────────────────────────────────────────────

      ref.current.results[id] = { state: 'running', progress: 0 };
      force();

      const runConfig = {
        ...(config || {}),
        projectId,
        projectName: projectName || 'Output',
        projectOutputDir: projectOutputDir || '',
        project: {
          ...((config && config.project) || {}),
          id: projectId,
          name: projectName || 'Output',
          outputDir: projectOutputDir || '',
        },
      };
      const ctx = {
        config: runConfig, abortRef: ref, get aborted() { return ref.current.aborted; },
        // Persist the provider job as soon as it exists, so quitting mid-run
        // leaves something to resume instead of paying for a new run.
        onJob: (job) => dispatch({ type: 'SET_RUN_RESULT', projectId, nodeId: id, result: { state: 'running', progress: 0, job } }),
      };
      let res;
      try {
        res = await Executor.runNode(node, deps, ctx, (p) => {
          if (ref.current.aborted) return;
          ref.current.progress = p;
          ref.current.results[id] = { state: 'running', progress: p };
          force();
        });
      } catch (error) {
        res = { ok: false, error: String(error) };
      }
      if (ref.current.aborted || res?.error === 'aborted') {
        delete ref.current.results[id];
        // Stop cancelled the provider job: nothing left to resume.
        dispatch({ type: 'CLEAR_RUN_RESULTS_FOR_NODES', projectId, nodeIds: [id] });
        break;
      }
      if (res?.ok) {
        const doneResult = withoutKeys(res, ['ok'], { state: 'done', progress: 1 });
        if (nodeHasUsableOutput(node, doneResult)) {
          ref.current.results[id] = doneResult;
          // ↓ Persist immediately so the node shows its preview right away
          dispatch({ type: 'SET_RUN_RESULT', projectId, nodeId: id, result: doneResult });
        } else {
          const errResult = {
            state: 'error', progress: 0,
            error: `${node.title || node.id} completed without a usable output.`,
          };
          ref.current.results[id] = errResult;
          dispatch({ type: 'SET_RUN_RESULT', projectId, nodeId: id, result: errResult });
          runErrors.push({ nodeId: id, title: node.title || id, error: errResult.error });
        }
      } else {
        const errResult = { state: 'error', progress: 0, error: res?.error || 'failed' };
        ref.current.results[id] = errResult;
        dispatch({ type: 'SET_RUN_RESULT', projectId, nodeId: id, result: errResult });
        runErrors.push({ nodeId: id, title: node.title || id, error: errResult.error });
      }
      force();
    }

    if (ref.current.aborted) {
      Object.entries(ref.current.results).forEach(([id, result]) => {
        if (result.state === 'queued' || result.state === 'waiting_dependencies' || result.state === 'waiting_user') {
          delete ref.current.results[id];
        }
      });
    }
    ref.current.active = false;
    ref.current.current = null;
    ref.current.waitingForPick = null;
    // Surface hard failures in one dialog now that the run is over.
    if (!ref.current.aborted && runErrors.length) {
      dispatch({ type: 'UI_PATCH', patch: { errorModal: { errors: runErrors } } });
    }
    force();
  }, [projectId, projectName, projectOutputDir, graph, dispatch, config, getRunResult]);

  const abort = React.useCallback(() => {
    if (ref.current.waitingForConfirm) {
      const { resolve } = ref.current.waitingForConfirm;
      ref.current.waitingForConfirm = null;
      resolve(false);
      return;
    }
    ref.current.aborted = true;
    if (ref.current.waitingForPick) {
      const { resolve } = ref.current.waitingForPick;
      ref.current.waitingForPick = null;
      resolve(-1); // unblock the awaited Promise
    }
    force();
  }, []);

  const reset = React.useCallback(() => {
    ref.current = { active: false, results: {}, current: null, progress: 0, aborted: false, queue: [], waitingForPick: null };
    dispatch({ type: 'CLEAR_RUN_RESULTS', projectId });
    force();
  }, [dispatch, projectId]);

  // Called by the paid-run confirmation dialog
  const confirmRun = React.useCallback((ok) => {
    if (ref.current.waitingForConfirm) {
      const { resolve } = ref.current.waitingForConfirm;
      ref.current.waitingForConfirm = null;
      force();
      resolve(!!ok);
    }
  }, []);

  // Called by the PickModal when the user clicks a thumbnail
  const pick = React.useCallback((selectedIndex) => {
    if (ref.current.waitingForPick) {
      const { resolve } = ref.current.waitingForPick;
      ref.current.waitingForPick = null;
      force();
      resolve(selectedIndex);
    }
  }, []);

  return {
    state: ref.current,
    start, abort, reset, pick, confirmRun,
    getOverride: (nodeId) => {
      if (ref.current.active && ref.current.results[nodeId]) {
        return ref.current.results[nodeId];
      }
      return getRunResult(nodeId);
    },
  };
}

// ---- EDGE PICK (for click-to-select) ----
function pointToSegDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx*dx + dy*dy;
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t*dx), p.y - (a.y + t*dy));
}

// Approximate edge proximity by sampling its bezier
function sampledEdgePoints(from, to, n = 16) {
  const off = Math.max(70, Math.abs(to.x - from.x) * 0.45);
  const c1 = { x: from.x + off, y: from.y };
  const c2 = { x: to.x - off, y: to.y };
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push({
      x: u*u*u*from.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*to.x,
      y: u*u*u*from.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*to.y,
    });
  }
  return pts;
}

function edgeMidPoint(from, to) {
  const pts = sampledEdgePoints(from, to, 2);
  return pts[1] || {
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
  };
}


// Reuse the shared helpers exported by state.jsx — no local copies needed.
function editorSourceThumbs(node, result) {
  const thumbs = resultThumbs(result);
  if (thumbs.length) return thumbs;
  return Array.isArray(node?.thumbs) ? node.thumbs : [];
}

function selectCandidateThumbs(graph, project, node) {
  if (!node) return null;

  // ── Select node: collect all upstream candidates for the Pick modal ──────
  if (node.kind === 'select') {
    const thumbs = [];
    graph.edges
      .filter(edge => edge.to.node === node.id && !edge.dashed)
      .forEach(edge => {
        const from = nodeById(graph, edge.from.node);
        const source = editorSourceThumbs(from, project.runResults[from?.id]);
        if (!source.length) return;
        if (from.kind === 'gen' || from.kind === 'motion' || from.kind === 'cli' || from.kind === 'task') {
          source.forEach((thumb, i) => thumbs.push({ ...thumb, sourceNodeId: from.id, sourceIndex: i }));
          return;
        }
        const picked = source.find(t => t.chosen) || source[0];
        if (picked) thumbs.push({ ...picked, sourceNodeId: from.id });
      });
    return thumbs.length ? thumbs : null;
  }

  // ── Output node: only show its own run result, never upstream passthrough.
  // The user must explicitly run the output node to see results here.
  if (node.kind === 'output') {
    const result = project.runResults[node.id];
    if (!result) return null;
    const thumbs = editorSourceThumbs(node, result);
    return thumbs.length ? thumbs : null;
  }

  return null;
}

// ---- AUTO LAYOUT ----
// Groups nodes by kind into fixed columns that reflect pipeline flow:
//   [asset / prompt]  →  [gen / motion / cli]  →  [select]  →  [output]
// Within each column nodes are stacked top-to-bottom using actual DOM heights.
function computeAutoLayout(nodes, edges) {
  const COL_GAP = 80;     // horizontal gap between columns
  const ROW_GAP = 24;     // vertical gap between nodes in the same column
  const ORIGIN_X = 120;   // left margin
  const FALLBACK_H = 160; // fallback height when DOM element not found

  // Fixed kind → column index mapping (pipeline order)
  //   col 0: inputs (asset, prompt)
  //   col 1: image / audio generation
  //   col 2: video generation
  //   col 3: video post-processing (extend, upscale, modify) and CLI tools (ffmpeg)
  //   col 4: pick / select
  //   col 5: output
  const KIND_COL = { asset: 0, prompt: 0, gen: 1, motion: 2, cli: 3, select: 4, output: 5 };

  // Generator (task) nodes: image and audio generators sit in the image
  // column, video generators and effects in the video column, and nodes that
  // transform an existing video (extend / upscale / modify) after them.
  const TASK_COL = {
    'video.extend': KIND_COL.cli, 'video.upscale': KIND_COL.cli, 'video.modify': KIND_COL.cli,
  };
  function taskColFor(n) {
    if (TASK_COL[n.capability] !== undefined) return TASK_COL[n.capability];
    const out = taskOutputKind(n);
    return out === 'video' || out === 'asset' ? KIND_COL.motion : KIND_COL.gen;
  }

  // Measure actual heights / widths from the DOM
  function getNodeHeight(id) {
    const el = document.querySelector(`[data-node-id="${id}"]`);
    return el ? el.offsetHeight : FALLBACK_H;
  }
  function getNodeWidth(id) {
    const n = nodes.find(x => x.id === id);
    return (n && nodeDisplayWidth(n)) || 220;
  }

  // Assign column: use KIND_COL if known, otherwise fall back to topological level
  // (so custom / future node kinds still get a reasonable placement)
  const inDegree = {};
  const succs = {};
  for (const n of nodes) { inDegree[n.id] = 0; succs[n.id] = []; }
  for (const e of edges) {
    inDegree[e.to.node] = (inDegree[e.to.node] || 0) + 1;
    succs[e.from.node].push(e.to.node);
  }
  const topoLevel = {};
  const visited = new Set();
  function dfs(id) {
    if (visited.has(id)) return topoLevel[id] ?? 0;
    visited.add(id);
    let maxChild = -1;
    for (const s of succs[id] || []) maxChild = Math.max(maxChild, dfs(s));
    topoLevel[id] = maxChild + 1;
    return topoLevel[id];
  }
  for (const n of nodes.filter(n => inDegree[n.id] === 0)) dfs(n.id);
  for (const n of nodes) { if (!visited.has(n.id)) dfs(n.id); }
  const maxTopo = Math.max(0, ...Object.values(topoLevel));
  for (const id of Object.keys(topoLevel)) topoLevel[id] = maxTopo - topoLevel[id];

  // Final column assignment: prefer kind-based, else topological
  const MAX_KIND_COL = Math.max(...Object.values(KIND_COL));
  function colFor(n) {
    if (n.kind === 'task') return taskColFor(n);
    if (KIND_COL[n.kind] !== undefined) return KIND_COL[n.kind];
    // Unknown kind: place after the last known kind column
    return MAX_KIND_COL + 1 + (topoLevel[n.id] ?? 0);
  }

  // Group nodes by column, preserve original Y order within each column
  const byCol = {};
  for (const n of nodes) {
    const c = colFor(n);
    byCol[c] = byCol[c] || [];
    byCol[c].push(n);
  }
  for (const c of Object.keys(byCol)) {
    byCol[c].sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
  }

  // Compute X for each column based on the widest node in it
  const cols = Object.keys(byCol).map(Number).sort((a, b) => a - b);
  const colX = {};
  let curX = ORIGIN_X;
  for (const c of cols) {
    colX[c] = curX;
    const maxW = Math.max(...byCol[c].map(n => getNodeWidth(n.id)));
    curX += maxW + COL_GAP;
  }

  // Stack each column top-to-bottom with actual heights, center in viewport
  const posMap = {};
  const viewH = window.innerHeight;
  for (const c of cols) {
    const group = byCol[c];
    const heights = group.map(n => getNodeHeight(n.id));
    const totalH = heights.reduce((s, h) => s + h, 0) + (group.length - 1) * ROW_GAP;
    let curY = Math.max(24, viewH / 2 - totalH / 2);
    group.forEach((n, i) => {
      posMap[n.id] = { x: colX[c], y: curY };
      curY += heights[i] + ROW_GAP;
    });
  }

  return nodes.map(n => ({ ...n, ...(posMap[n.id] || {}) }));
}

// ---- MAIN CANVAS ----
function EditorCanvas({ project, ui, dispatch, config, theme = 'dark', cliStyle, connectionStyle, previewStyle, statusStyle }) {
  const t = TOKENS[theme];
  const graph = project.graph;
  const canvasRef = React.useRef(null);

  // Local UI state for transient gestures; pan lives in reducer so palette
  // drops from outside the canvas use the same coordinates.
  const [dragConn, setDragConn] = React.useState(null);  // { from, x, y, hoverPort? }
  const pan = { x: ui.panX || 0, y: ui.panY || 0 };

  const runner = useRunner({
    projectId: project.id,
    projectName: project.name,
    projectOutputDir: project.outputDir || '',
    graph, dispatch, config,
    getRunResult: (id) => project.runResults[id],
  });
  // Expose the live runner so the MCP bridge can start runs and read
  // per-node progress (refreshed every render, so closures stay current).
  window.AtlasRunner = runner;
  const defaultRunOrder = React.useMemo(() => runOrderNodeIds(graph), [graph]);
  const defaultDoneCount = defaultRunOrder.filter(id => project.runResults[id]?.state === 'done').length;

  // Resolve a port's canvas-local center
  const portPos = React.useCallback((nodeId, portIdx) => {
    const n = nodeById(graph, nodeId);
    if (!n) return null;
    const p = (n.ports || [])[portIdx];
    if (!p) return null;
    return {
      x: n.x + (p.side === 'left' ? 0 : nodeDisplayWidth(n)),
      y: n.y + p.top,
      side: p.side, kind: p.kind,
    };
  }, [graph]);

  const selectedEdge = ui.selectedEdgeIdx != null ? graph.edges[ui.selectedEdgeIdx] : null;
  const selectedEdgeFrom = selectedEdge && portPos(selectedEdge.from.node, selectedEdge.from.port);
  const selectedEdgeTo = selectedEdge && portPos(selectedEdge.to.node, selectedEdge.to.port);
  const selectedEdgeMid = selectedEdgeFrom && selectedEdgeTo
    ? edgeMidPoint(selectedEdgeFrom, selectedEdgeTo)
    : null;

  const toggleEdgeDashed = React.useCallback((idx) => {
    if (idx == null || idx < 0) return;
    dispatch({ type: 'PATCH_GRAPH', fn: g => ({
      ...g,
      edges: g.edges.map((edge, i) => i === idx ? { ...edge, dashed: !edge.dashed } : edge),
    })});
    dispatch({ type: 'UI_PATCH', patch: { selectedEdgeIdx: idx, contextMenu: null } });
  }, [dispatch]);

  const deleteEdge = React.useCallback((idx) => {
    if (idx == null || idx < 0) return;
    dispatch({ type: 'PATCH_GRAPH', fn: g => ({
      ...g,
      edges: g.edges.filter((_, i) => i !== idx),
    })});
    dispatch({ type: 'UI_PATCH', patch: { selectedEdgeIdx: null, contextMenu: null } });
  }, [dispatch]);

  // ---- NODE DRAG ----
  const onNodeMouseDown = (id, e) => {
    if (e.target.closest('.no-drag')) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const node = nodeById(graph, id);
    if (!node) return;
    const startX = e.clientX, startY = e.clientY;
    const origX = node.x, origY = node.y;
    let moved = false;
    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      dispatch({ type: 'PATCH_GRAPH', fn: g => ({
        ...g,
        nodes: g.nodes.map(n => n.id === id ? { ...n, x: origX + dx, y: origY + dy } : n),
      })});
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!moved) {
        dispatch({ type: 'UI_PATCH', patch: { selectedNodeId: id, selectedEdgeIdx: null, contextMenu: null } });
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ---- PORT DRAG (connect) ----
  const onPortMouseDown = (nodeId, portIdx, e) => {
    e.preventDefault();
    e.stopPropagation();
    const n = nodeById(graph, nodeId);
    const p = n && n.ports[portIdx];
    if (!p) return;
    if (p.side !== 'right') return; // start drags from output ports only
    const startPt = { x: n.x + nodeDisplayWidth(n), y: n.y + p.top };
    setDragConn({ from: { node: nodeId, port: portIdx }, fromKind: p.kind, fromX: startPt.x, fromY: startPt.y, x: startPt.x, y: startPt.y, hover: null });
    const rect = canvasRef.current.getBoundingClientRect();
    const onMove = (ev) => {
      const x = ev.clientX - rect.left - pan.x;
      const y = ev.clientY - rect.top - pan.y;
      // hit test against input ports
      let hover = null;
      const radius2 = 16 * 16;
      for (const node of graph.nodes) {
        for (let i = 0; i < (node.ports || []).length; i++) {
          const pp = node.ports[i];
          if (pp.side !== 'left') continue;
          const px = node.x;
          const py = node.y + pp.top;
          if ((px - x) ** 2 + (py - y) ** 2 < radius2) {
            const check = canConnect(graph, { node: nodeId, port: portIdx }, { node: node.id, port: i });
            hover = { node: node.id, port: i, x: px, y: py, ok: check.ok, reason: check.reason };
            break;
          }
        }
        if (hover) break;
      }
      setDragConn(d => d ? { ...d, x: hover ? hover.x : x, y: hover ? hover.y : y, hover } : null);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setDragConn(d => {
        if (d && d.hover && d.hover.ok) {
          dispatch({ type: 'PATCH_GRAPH', fn: g => ({
            ...g,
            edges: [...g.edges, { from: { node: nodeId, port: portIdx }, to: { node: d.hover.node, port: d.hover.port } }],
          })});
        }
        return null;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ---- PAN ON EMPTY CANVAS ----
  const onCanvasMouseDown = (e) => {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const orig = { ...pan };
    let moved = false;
    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      dispatch({ type: 'UI_PATCH', patch: { panX: orig.x + dx, panY: orig.y + dy } });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!moved) {
        dispatch({ type: 'UI_PATCH', patch: { selectedNodeId: null, selectedEdgeIdx: null, contextMenu: null } });
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ---- EDGE CLICK ----
  const onCanvasMouseUpForEdge = (e) => {
    if (e.target !== e.currentTarget) return;
    // Try hit-testing edges
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - pan.x;
    const y = e.clientY - rect.top - pan.y;
    let hit = -1;
    let bestDist = 8;
    graph.edges.forEach((edge, i) => {
      const f = portPos(edge.from.node, edge.from.port);
      const u = portPos(edge.to.node, edge.to.port);
      if (!f || !u) return;
      const pts = sampledEdgePoints(f, u, 16);
      for (let j = 0; j < pts.length - 1; j++) {
        const d = pointToSegDist({ x, y }, pts[j], pts[j+1]);
        if (d < bestDist) { bestDist = d; hit = i; }
      }
    });
    if (hit >= 0) {
      dispatch({ type: 'UI_PATCH', patch: { selectedEdgeIdx: hit, selectedNodeId: null } });
    }
  };

  // ---- KEYBOARD ----
  React.useEffect(() => {
    const onKey = (e) => {
      // Ignore when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (ui.selectedEdgeIdx != null) {
          deleteEdge(ui.selectedEdgeIdx);
        } else if (ui.selectedNodeId) {
          dispatch({ type: 'PATCH_GRAPH', fn: g => ({
            ...g,
            nodes: g.nodes.filter(n => n.id !== ui.selectedNodeId),
            edges: g.edges.filter(e => e.from.node !== ui.selectedNodeId && e.to.node !== ui.selectedNodeId),
          })});
          dispatch({ type: 'UI_PATCH', patch: { selectedNodeId: null } });
        }
      }
      if (e.key === 'Escape') {
        dispatch({ type: 'UI_PATCH', patch: { selectedNodeId: null, selectedEdgeIdx: null, contextMenu: null, configOpen: false } });
        if (runner.state.active) runner.abort();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui, dispatch, runner, deleteEdge]);

  // ---- ACTIONS ----
  const onNodeAction = (id, action) => {
    if (action === 'delete') {
      dispatch({ type: 'PATCH_GRAPH', fn: g => ({
        ...g,
        nodes: g.nodes.filter(n => n.id !== id),
        edges: g.edges.filter(e => e.from.node !== id && e.to.node !== id),
      })});
      dispatch({ type: 'UI_PATCH', patch: { selectedNodeId: null } });
    } else if (action === 'duplicate') {
      const orig = nodeById(graph, id);
      if (!orig) return;
      const newId = makeNodeId(graph, nodeIdPrefix(orig.kind));
      const copy = JSON.parse(JSON.stringify(orig));
      copy.id = newId;
      copy.x = orig.x + 24;
      copy.y = orig.y + 24;
      dispatch({ type: 'PATCH_GRAPH', fn: g => ({ ...g, nodes: [...g.nodes, copy] }) });
      dispatch({ type: 'UI_PATCH', patch: { selectedNodeId: newId } });
    } else if (action === 'rerun') {
      runner.start(id);
    }
  };

  const onPatchNode = (id, patch) => {
    const currentNode = nodeById(graph, id);
    dispatch({ type: 'PATCH_GRAPH', fn: g => ({
      ...g,
      nodes: g.nodes.map(n => n.id === id ? { ...n, ...patch } : n),
    })});
    // A manual Pick is itself a fresh node output. Keep that selected result
    // while PATCH_GRAPH invalidates every dependent downstream result.
    if (currentNode?.kind === 'select' && Array.isArray(patch.thumbs) && patch.thumbs.some(thumbHasUsableSource)) {
      const selectedIndex = Math.max(0, patch.selectedIndex ?? patch.thumbs.findIndex(thumb => thumb.chosen));
      dispatch({
        type: 'SET_RUN_RESULT', projectId: project.id, nodeId: id,
        result: { state: 'done', progress: 1, selectedIndex, thumbs: patch.thumbs },
      });
    }
  };

  // ---- DROP FROM PALETTE ----
  const onPaletteDrop = (template, clientX, clientY) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = clientX - rect.left - pan.x - 100;
    const y = clientY - rect.top - pan.y - 30;
    const fresh = template.spawn();
    const id = makeNodeId(graph, nodeIdPrefix(template.kind));
    dispatch({ type: 'PATCH_GRAPH', fn: g => ({
      ...g,
      nodes: [...g.nodes, { ...fresh, id, x, y }],
    })});
    dispatch({ type: 'UI_PATCH', patch: { selectedNodeId: id } });
  };

  // ---- RENDER ----
  // ── Single clean cubic bezier for every edge ─────────────────────────────
  // Horizontal control-point offset capped so curves stay nicely rounded even
  // when columns are far apart. Uses a sqrt-based taper for large distances.
  const bezierEdgePath = (from, to) => {
    const dx = to.x - from.x;
    const dy = Math.abs(to.y - from.y);
    // Base offset from horizontal distance, capped at 140px; add a fraction of
    // vertical distance so backwards/same-column edges still curve gracefully.
    const off = Math.min(Math.max(55, Math.abs(dx) * 0.38 + dy * 0.08), 140);
    return `M ${from.x} ${from.y} C ${from.x + off} ${from.y}, ${to.x - off} ${to.y}, ${to.x} ${to.y}`;
  };

  // active = edge touches the selected node (or nothing is selected)
  const edgeStyleFor = (e, sel, active) => {
    if (sel) return {
      dash: e.dashed ? '5 6' : 'none',
      w: 2.2, halo: 5, op: 1, haloOp: 0.75, r: 3.5, showDots: true,
    };
    if (active) return {
      dash: e.dashed ? '5 6' : 'none',
      w: e.dashed ? 1.2 : 1.6, halo: 0, op: e.dashed ? 0.55 : 0.7, haloOp: 0, r: 2.5, showDots: false,
    };
    // passive — dim, thin, no halo
    return {
      dash: e.dashed ? '5 6' : 'none',
      w: e.dashed ? 0.9 : 1.1, halo: 0, op: e.dashed ? 0.18 : 0.22, haloOp: 0, r: 2, showDots: false,
    };
  };

  // Is this edge "active"? — touches the selected node, or nothing is selected
  const edgeIsActive = (e) => {
    if (!ui.selectedNodeId && ui.selectedEdgeIdx == null) return true; // no selection → all active
    if (ui.selectedEdgeIdx != null) return false;                       // edge selected → only that edge matters
    return e.from.node === ui.selectedNodeId || e.to.node === ui.selectedNodeId;
  };

  const edgeEvents = (edgeIndex) => ({
    onMouseDown: (ev) => ev.stopPropagation(),
    onClick: (ev) => {
      ev.stopPropagation();
      dispatch({ type: 'UI_PATCH', patch: { selectedEdgeIdx: edgeIndex, selectedNodeId: null, contextMenu: null } });
    },
    onContextMenu: (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      dispatch({ type: 'UI_PATCH', patch: {
        selectedEdgeIdx: edgeIndex,
        selectedNodeId: null,
        contextMenu: { x: ev.clientX, y: ev.clientY, target: { kind: 'edge', idx: edgeIndex } },
      }});
    },
  });

  // ── z=1  Edge body (below nodes, always rendered) ────────────────────────
  const renderEdgeBase = (e, i) => {
    const f = portPos(e.from.node, e.from.port);
    const u = portPos(e.to.node, e.to.port);
    if (!f || !u) return null;
    const color = PORT_COLORS[f.kind] || t.accent;
    const sel = ui.selectedEdgeIdx === i;
    const active = edgeIsActive(e);
    const s = edgeStyleFor(e, sel, active);
    const path = bezierEdgePath(f, u);
    return (
      <g key={`base-${i}`}>
        {/* Invisible wide hit target */}
        <path d={path} fill="none" stroke="transparent" strokeWidth="14"
          pointerEvents="stroke" style={{ cursor: 'pointer' }}
          {...edgeEvents(i)} />
        {/* Halo only for selected edges */}
        {s.halo > 0 && (
          <path d={path} fill="none" stroke={t.bg}
            strokeWidth={s.halo} opacity={s.haloOp}
            strokeLinecap="round" strokeLinejoin="round" strokeDasharray={s.dash} />
        )}
        <path d={path} fill="none" stroke={color}
          strokeWidth={s.w} opacity={s.op}
          strokeLinecap="round" strokeLinejoin="round" strokeDasharray={s.dash} />
      </g>
    );
  };

  // ── z=4  Port-endpoint dots — only for selected or active edges ───────────
  const renderEdgeDots = (e, i) => {
    const f = portPos(e.from.node, e.from.port);
    const u = portPos(e.to.node, e.to.port);
    if (!f || !u) return null;
    const color = PORT_COLORS[f.kind] || t.accent;
    const sel = ui.selectedEdgeIdx === i;
    const active = edgeIsActive(e);
    const s = edgeStyleFor(e, sel, active);
    if (!s.showDots && !sel) return null; // skip dots for passive edges
    const op = sel ? 0.9 : 0.7;
    return (
      <g key={`dot-${i}`}>
        <circle cx={f.x} cy={f.y} r={s.r} fill={t.bg} stroke={color}
          strokeWidth={sel ? 1.8 : 1.2} opacity={op} />
        <circle cx={u.x} cy={u.y} r={s.r} fill={t.bg} stroke={color}
          strokeWidth={sel ? 1.8 : 1.2} opacity={op} />
      </g>
    );
  };

  // ── z=5  Selected / running edge (floats above nodes) ────────────────────
  const renderEdgeTop = (e, i) => {
    const f = portPos(e.from.node, e.from.port);
    const u = portPos(e.to.node, e.to.port);
    if (!f || !u) return null;
    const color = PORT_COLORS[f.kind] || t.accent;
    const sel = ui.selectedEdgeIdx === i;
    const source = nodeById(graph, e.from.node);
    const sourceReady = !e.dashed && nodeHasUsableOutput(source, runner.getOverride(e.from.node));
    const running = sourceReady && runner.getOverride(e.to.node)?.state === 'running';
    if (!sel && !running) return null;
    const s = edgeStyleFor(e, sel, true);
    const path = bezierEdgePath(f, u);
    return (
      <g key={`top-${i}`}>
        <path d={path} fill="none" stroke={t.bg}
          strokeWidth={s.halo || 5} opacity={0.9}
          strokeLinecap="round" strokeLinejoin="round" strokeDasharray={s.dash} />
        <path d={path} fill="none" stroke={color}
          strokeWidth={s.w} opacity={1}
          strokeLinecap="round" strokeLinejoin="round" strokeDasharray={s.dash} />
        {running && (
          <path d={path} fill="none" stroke={t.amber}
            strokeWidth={e.dashed ? 2 : 3} opacity={e.dashed ? 0.7 : 1}
            strokeLinecap="round" strokeDasharray="3 7"
            style={{ animation: 'mg-dash 0.7s linear infinite' }} />
        )}
      </g>
    );
  };

  const mkEdgeLayer = (zIndex, children) => (
    <div style={{
      position: 'absolute', left: pan.x, top: pan.y,
      width: 10000, height: 10000, zIndex, pointerEvents: 'none',
    }}>
      {/* overflow:visible lets paths extend into negative canvas coordinates without being clipped
          by the SVG viewport. The canvas root's overflow:hidden clips the final result instead. */}
      <svg style={{ position: 'absolute', left: 0, top: 0, width: 10000, height: 10000,
                    overflow: 'visible', pointerEvents: 'none' }}>
        {children}
      </svg>
    </div>
  );

  return (
    <div
      ref={canvasRef}
      onMouseDown={onCanvasMouseDown}
      onMouseUp={onCanvasMouseUpForEdge}
      style={{
        flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden',
        background: t.bg,
        backgroundImage: `radial-gradient(circle, ${t.grid} 1px, transparent 1px)`,
        backgroundSize: '24px 24px',
        backgroundPosition: `${pan.x % 24}px ${pan.y % 24}px`,
        cursor: dragConn ? 'crosshair' : 'default',
      }}
    >
      {/* z=1  Edge bodies — below nodes */}
      {mkEdgeLayer(1, graph.edges.map((e, i) => renderEdgeBase(e, i)))}

      {/* Selected edge quick action */}
      {selectedEdgeMid && (
        <div style={{
          position: 'absolute',
          left: pan.x + selectedEdgeMid.x - 18,
          top: pan.y + selectedEdgeMid.y - 18,
          zIndex: 8,
          background: t.panel,
          border: `1px solid ${t.borderStrong}`,
          borderRadius: 6,
          padding: 3,
          boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
          display: 'flex',
          gap: 3,
        }}>
          <button
            title={selectedEdge.dashed ? 'Make solid' : 'Make dashed'}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); toggleEdgeDashed(ui.selectedEdgeIdx); }}
            style={{
              width: 28, height: 28,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: t.panel2,
              border: `1px solid ${t.border}`,
              borderRadius: 4,
              color: t.textMid,
              cursor: 'pointer',
            }}
          >
            <Icon name="link" size={13}/>
          </button>
          <button
            title="Delete connection"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); deleteEdge(ui.selectedEdgeIdx); }}
            style={{
              width: 28, height: 28,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: t.panel2,
              border: `1px solid ${t.border}`,
              borderRadius: 4,
              color: t.red,
              cursor: 'pointer',
            }}
          >
            <Icon name="close" size={13}/>
          </button>
        </div>
      )}

      {/* Nodes */}
      <div style={{ position: 'absolute', left: pan.x, top: pan.y, zIndex: 2 }}>
        {graph.nodes.map(n => (
          <EditorNode
            key={n.id}
            t={t} node={n}
            selected={ui.selectedNodeId === n.id}
            runOverride={runner.getOverride(n.id)}
            runResult={project.runResults[n.id]}
            candidateThumbs={selectCandidateThumbs(graph, project, n)}
            inputReadiness={nodeInputPortStatuses(graph, n.id, id => runner.getOverride(id))}
            statusStyle={statusStyle}
            onMouseDown={onNodeMouseDown}
            onPortMouseDown={onPortMouseDown}
            onSelect={(id) => dispatch({ type: 'UI_PATCH', patch: { selectedNodeId: id, selectedEdgeIdx: null } })}
            onContextMenu={(id, e) => dispatch({ type: 'UI_PATCH', patch: {
              contextMenu: { x: e.clientX, y: e.clientY, target: { kind: 'node', id } },
              selectedNodeId: id,
            }})}
            onPatch={(patch) => onPatchNode(n.id, patch)}
            onAction={onNodeAction}
          />
        ))}
      </div>

      {/* z=4  Port dots — always above nodes so connection anchors stay visible */}
      {mkEdgeLayer(4, <>
        {graph.edges.map((e, i) => renderEdgeDots(e, i))}
        {dragConn && (
          <g>
            <path
              d={bezierEdgePath({ x: dragConn.fromX, y: dragConn.fromY }, { x: dragConn.x, y: dragConn.y })}
              fill="none"
              stroke={dragConn.hover
                ? (dragConn.hover.ok ? PORT_COLORS[dragConn.fromKind] : t.red)
                : PORT_COLORS[dragConn.fromKind]}
              strokeWidth="2" strokeDasharray="4 3"
            />
            {dragConn.hover && (
              <circle cx={dragConn.hover.x} cy={dragConn.hover.y} r="8"
                fill={dragConn.hover.ok ? 'rgba(127,200,255,0.18)' : 'rgba(229,145,122,0.2)'}
                stroke={dragConn.hover.ok ? t.accent : t.red}/>
            )}
          </g>
        )}
      </>)}

      {/* z=5  Selected / running edge — floats above nodes */}
      {mkEdgeLayer(5, graph.edges.map((e, i) => renderEdgeTop(e, i)))}

      {/* Floating run controls + status */}
      <div style={{
        position: 'absolute', top: 12, left: 12,
        display: 'flex', alignItems: 'center', gap: 8,
        zIndex: 20,
      }}>
        <div style={{
          padding: '5px 10px', background: t.panel, border: `1px solid ${t.border}`,
          borderRadius: 5, color: t.text, fontSize: 11,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <Icon name="folder" size={12} color={t.textMid}/>
          <span>{project.name}</span>
          <span style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 10 }}>{graph.nodes.length}n · {graph.edges.length}e</span>
          {runner.state.active && <span style={{ color: t.amber, fontFamily: FONT_MONO, fontSize: 10 }}>● running</span>}
        </div>
      </div>
      <div style={{
        position: 'absolute', top: 12, right: 12,
        display: 'flex', alignItems: 'center', gap: 6,
        zIndex: 20,
      }}>
        {runner.state.active ? (
          <Btn size="sm" leftIcon="pause" theme={theme} onClick={() => runner.abort()}>Stop</Btn>
        ) : (
          <Btn size="sm" primary leftIcon="play" theme={theme} onClick={() => runner.start()}>Run graph</Btn>
        )}
        <Btn size="sm" leftIcon="history" theme={theme} onClick={() => runner.reset()}>Clear</Btn>
        <div
          onClick={() => dispatch({ type: 'UI_PATCH', patch: { panX: 0, panY: 0 } })}
          style={{
            padding: '4px 8px', background: t.panel, border: `1px solid ${t.border}`,
            borderRadius: 5, color: t.textMid, fontFamily: FONT_MONO, fontSize: 10.5, cursor: 'pointer',
          }}
        >reset pan</div>
        <div
          title="Auto-layout nodes"
          onClick={() => {
            const newNodes = computeAutoLayout(graph.nodes, graph.edges);
            dispatch({ type: 'PATCH_GRAPH', fn: g => ({ ...g, nodes: newNodes }) });
            dispatch({ type: 'UI_PATCH', patch: { panX: 0, panY: 0 } });
          }}
          style={{
            padding: '4px 8px', background: t.panel, border: `1px solid ${t.border}`,
            borderRadius: 5, color: t.textMid, fontFamily: FONT_MONO, fontSize: 10.5, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <Icon name="grid" size={11}/>
          auto layout
        </div>
      </div>

      {/* Bottom log */}
      <div style={{
        position: 'absolute', left: 12, right: 12, bottom: 12,
        background: t.bg2, border: `1px solid ${t.border}`, borderRadius: 6,
        padding: '8px 12px',
        display: 'flex', alignItems: 'center', gap: 12,
        fontFamily: FONT_MONO, fontSize: 10.5,
        zIndex: 6,
        color: t.textMid,
      }}>
        <Icon name="terminal" size={12} color={t.accent}/>
        <span style={{ color: t.text }}>log</span>
        <span style={{ color: t.textMute }}>·</span>
        {runner.state.waitingForPick ? (
          <span><span style={{ color: t.accent }}>[pick]</span> 请在弹窗中选择一张图片继续…</span>
        ) : runner.state.active && runner.state.current ? (
          <span><span style={{ color: t.amber }}>[run]</span> {runner.state.current} · {Math.round(runner.state.progress*100)}%</span>
        ) : Object.keys(runner.state.results).some(k => runner.state.results[k].state === 'error' || runner.state.results[k].state === 'blocked') ? (
          <span><span style={{ color: t.red }}>[blocked]</span> required outputs are missing · check node ports</span>
        ) : Object.keys(project.runResults).length > 0 ? (
          <span><span style={{ color: t.green }}>[ok]</span> last run · {defaultDoneCount}/{defaultRunOrder.length} default done</span>
        ) : (
          <span><span style={{ color: t.textMute }}>[idle]</span> drag from a port to connect · drag headers to move · Esc to cancel</span>
        )}
        <div style={{ flex: 1 }}/>
        <span style={{ color: t.textMute }}>
          {Storage && Storage.KEY ? 'localStorage' : 'fs'} · auto-saved
        </span>
      </div>

      {/* Paid-run confirmation — above the user's limit, a run waits here */}
      {runner.state.waitingForConfirm && (
        <PaidRunConfirmModal
          t={t}
          summary={runner.state.waitingForConfirm.summary}
          limit={runner.state.waitingForConfirm.limit}
          onConfirm={() => runner.confirmRun(true)}
          onCancel={() => runner.confirmRun(false)}
          onOpenConfig={() => { runner.confirmRun(false); dispatch({ type: 'UI_PATCH', patch: { configOpen: true } }); }}
        />
      )}

      {/* Pick modal — suspends the run until user selects a thumbnail */}
      {runner.state.waitingForPick && (
        <PickModal
          t={t}
          candidates={runner.state.waitingForPick.candidates}
          onPick={runner.pick}
          onAbort={runner.abort}
        />
      )}

      {/* Error dialog — run failures, surfaced once per run */}
      {ui.errorModal && (ui.errorModal.errors || []).length > 0 && (
        <ErrorModal
          t={t}
          errors={ui.errorModal.errors}
          onClose={() => dispatch({ type: 'UI_PATCH', patch: { errorModal: null } })}
          onOpenConfig={() => dispatch({ type: 'UI_PATCH', patch: { errorModal: null, configOpen: true } })}
          onSelectNode={(nodeId) => dispatch({ type: 'UI_PATCH', patch: { errorModal: null, selectedNodeId: nodeId } })}
        />
      )}

      {/* Context menu */}
      {ui.contextMenu && ui.contextMenu.target.kind === 'node' && (
        <ContextMenu
          t={t} x={ui.contextMenu.x} y={ui.contextMenu.y}
          onClose={() => dispatch({ type: 'UI_PATCH', patch: { contextMenu: null } })}
          items={[
            { label: 'Run from here', icon: 'play', onClick: () => runner.start(ui.contextMenu.target.id) },
            { label: 'Duplicate', icon: 'vary', onClick: () => onNodeAction(ui.contextMenu.target.id, 'duplicate') },
            { sep: true },
            { label: 'Delete', icon: 'close', danger: true, onClick: () => onNodeAction(ui.contextMenu.target.id, 'delete') },
          ]}
        />
      )}
      {ui.contextMenu && ui.contextMenu.target.kind === 'edge' && (
        <ContextMenu
          t={t} x={ui.contextMenu.x} y={ui.contextMenu.y}
          onClose={() => dispatch({ type: 'UI_PATCH', patch: { contextMenu: null } })}
          items={[
            {
              label: graph.edges[ui.contextMenu.target.idx]?.dashed ? 'Make solid' : 'Make dashed',
              icon: 'link',
              onClick: () => toggleEdgeDashed(ui.contextMenu.target.idx),
            },
            { sep: true },
            { label: 'Delete connection', icon: 'close', danger: true, onClick: () => deleteEdge(ui.contextMenu.target.idx) },
          ]}
        />
      )}
    </div>
  );
}

function ContextMenu({ t, x, y, items, onClose }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    setTimeout(() => window.addEventListener('mousedown', onClick), 0);
    return () => window.removeEventListener('mousedown', onClick);
  }, [onClose]);
  return (
    <div
      ref={ref}
      style={{
        position: 'fixed', left: x, top: y, zIndex: 100,
        background: t.panel, border: `1px solid ${t.borderStrong}`,
        borderRadius: 6,
        padding: 4, minWidth: 160,
        boxShadow: '0 10px 32px rgba(0,0,0,0.6)',
        fontFamily: FONT_UI, fontSize: 11.5,
      }}
    >
      {items.map((it, i) => it.sep ? (
        <div key={i} style={{ height: 1, background: t.border, margin: '3px 0' }}/>
      ) : (
        <div
          key={i}
          onClick={() => { it.onClick && it.onClick(); onClose(); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 10px', borderRadius: 4,
            color: it.danger ? t.red : t.text,
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = t.panelHi}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          {it.icon && <Icon name={it.icon} size={11} color={it.danger ? t.red : t.textMid}/>}
          {it.label}
        </div>
      ))}
    </div>
  );
}

// ---- PICK MODAL ----
// Full-screen selection overlay. Suspends the run until the user clicks one
// thumbnail, then resumes downstream execution with that choice.
// ---- ERROR MODAL ----
// Centered dialog listing every hard failure of the last run. Errors stay
// out of the inline layout (the Inspector shows a one-line summary + 详情).
function ErrorModal({ t, errors, onClose, onOpenConfig, onSelectNode }) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copyAll = () => {
    const text = errors.map(er => `[${er.title}] ${er.error}`).join('\n\n');
    try {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (_) {}
  };

  // The most common first-run failure: managed runtime not installed yet.
  const needsRuntime = errors.some(er => /managed runtime|Beatboard Config/i.test(String(er.error || '')));

  const btnStyle = {
    padding: '5px 14px', background: 'transparent',
    border: `1px solid ${t.border}`, borderRadius: 6,
    color: t.textMid, cursor: 'pointer',
    fontFamily: FONT_UI, fontSize: 12,
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2100,
        background: 'rgba(6,9,14,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(600px, 86vw)', maxHeight: '72vh',
          display: 'flex', flexDirection: 'column',
          background: t.panel, borderRadius: 10,
          border: `1px solid ${t.red}66`,
          boxShadow: `0 18px 60px rgba(0,0,0,0.55), 0 0 0 1px ${t.red}22`,
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 16px', borderBottom: `1px solid ${t.border}`, flexShrink: 0,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.red, flexShrink: 0 }}/>
          <span style={{ color: t.text, fontSize: 13, fontFamily: FONT_UI, fontWeight: 600 }}>
            运行失败 · {errors.length} 个节点
          </span>
          <span
            onClick={onClose}
            style={{ marginLeft: 'auto', color: t.textMute, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 4 }}
            onMouseEnter={e => { e.currentTarget.style.color = t.text; }}
            onMouseLeave={e => { e.currentTarget.style.color = t.textMute; }}
          >✕</span>
        </div>

        {/* Error list */}
        <div className="mg-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 16px' }}>
          {errors.map((er, i) => (
            <div key={`${er.nodeId}-${i}`} style={{ marginBottom: i === errors.length - 1 ? 0 : 12 }}>
              <div
                onClick={() => onSelectNode && onSelectNode(er.nodeId)}
                title="在画布上选中该节点"
                style={{
                  color: t.text, fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600,
                  marginBottom: 5, cursor: 'pointer', display: 'inline-block',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = t.accent; }}
                onMouseLeave={e => { e.currentTarget.style.color = t.text; }}
              >
                ● {er.title} <span style={{ color: t.textMute, fontWeight: 400 }}>({er.nodeId})</span>
              </div>
              <pre style={{
                margin: 0, padding: '9px 11px',
                background: 'rgba(0,0,0,0.28)', borderRadius: 6,
                border: `1px solid ${t.border}`,
                color: t.red, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.55,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>{String(er.error || 'failed')}</pre>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '11px 16px', borderTop: `1px solid ${t.border}`, flexShrink: 0,
        }}>
          {needsRuntime && (
            <span style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 10.5 }}>
              提示:可在 Config 安装托管的 PixVerse 运行时
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {needsRuntime && (
              <button style={{ ...btnStyle, borderColor: t.accent, color: t.accent }} onClick={onOpenConfig}>
                打开 Config
              </button>
            )}
            <button style={btnStyle} onClick={copyAll}>{copied ? '已复制 ✓' : '复制错误'}</button>
            <button style={btnStyle} onClick={onClose}>关闭</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PaidRunConfirmModal({ t, summary, limit, onConfirm, onCancel, onOpenConfig }) {
  const rows = Object.entries(summary.byProvider);
  return (
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(8,11,16,0.72)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT_UI,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 420, background: t.bg2, border: `1px solid ${t.borderStrong}`, borderRadius: 10,
        boxShadow: '0 24px 60px rgba(0,0,0,0.6)', padding: '16px 18px',
      }}>
        <div style={{ color: t.text, fontSize: 14, fontWeight: 600 }}>
          Run {summary.total} paid generation{summary.total === 1 ? '' : 's'}?
        </div>
        <div style={{ marginTop: 6, color: t.textMute, fontFamily: FONT_MONO, fontSize: 10.5, lineHeight: 1.5 }}>
          This run submits more than your limit of {limit}. Each is billed to your account with that provider.
        </div>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map(([provider, r]) => (
            <div key={provider} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT_MONO, fontSize: 11 }}>
              <span style={{ color: t.text, flex: 1 }}>{providerName(provider)}</span>
              <span style={{ color: t.textMid }}>{r.runs} node{r.runs === 1 ? '' : 's'}</span>
              <span style={{ color: t.textMute }}>· {r.outputs} output{r.outputs === 1 ? '' : 's'}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span onClick={onOpenConfig} style={{ color: t.accent, fontFamily: FONT_MONO, fontSize: 10, cursor: 'pointer' }}>change limit</span>
          <div style={{ flex: 1 }}/>
          <Btn theme="dark" onClick={onCancel}>Cancel</Btn>
          <Btn primary theme="dark" onClick={onConfirm}>Run {summary.total}</Btn>
        </div>
      </div>
    </div>
  );
}

function PickModal({ t, candidates, onPick, onAbort }) {
  const thumbSrc = (thumb) => (
    (typeof mediaSrc === 'function' && mediaSrc(thumb)) ||
    thumb.url || thumb.videoUrl || thumb.video_url || thumb.audioUrl || thumb.audio_url || thumb.path || thumb.output || thumb.src || ''
  );
  const isVideo = (thumb, src) =>
    thumb.type === 'video' || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(src || thumb.videoUrl || thumb.video_url || thumb.output || '');
  const isAudio = (thumb, src) =>
    thumb.type === 'audio' || /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(src || thumb.audioUrl || thumb.audio_url || thumb.output || '');

  // Grid columns: 1→1col, 2→2col, 3→3col, 4+→2col (wraps to rows)
  const n = candidates.length;
  const cols = n === 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : 2;
  const rows = Math.ceil(n / cols);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2000,
      background: 'rgba(6,9,14,0.97)',
      display: 'flex', flexDirection: 'column',
      padding: '18px 20px 14px',
    }}>
      {/* ── Header bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0, marginBottom: 14,
      }}>
        <div>
          <span style={{ color: t.text, fontSize: 14, fontFamily: FONT_UI, fontWeight: 600 }}>
            选择一个媒体结果继续
          </span>
          <span style={{ color: t.textMute, fontSize: 11, fontFamily: FONT_MONO, marginLeft: 12 }}>
            工作流已暂停 · 点击后继续后续节点生成
          </span>
        </div>
        <button
          onClick={onAbort}
          style={{
            padding: '5px 14px', background: 'transparent',
            border: `1px solid ${t.border}`, borderRadius: 6,
            color: t.textMid, cursor: 'pointer',
            fontFamily: FONT_UI, fontSize: 12, flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = t.red; e.currentTarget.style.color = t.red; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = t.border; e.currentTarget.style.color = t.textMid; }}
        >
          取消运行
        </button>
      </div>

      {/* ── Full-screen thumbnail grid ── */}
      <div style={{
        flex: 1, minHeight: 0,
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        gap: 10,
      }}>
        {candidates.map((thumb, i) => {
          const src = thumbSrc(thumb);
          const vid = isVideo(thumb, src);
          const aud = isAudio(thumb, src);
          return (
            <div
              key={thumb.seed || i}
              onClick={() => onPick(i)}
              style={{
                position: 'relative', borderRadius: 8,
                overflow: 'hidden', cursor: 'pointer',
                border: `2px solid ${t.border}`,
                background: '#000',
                transition: 'border-color 0.1s, box-shadow 0.1s',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = t.accent;
                e.currentTarget.style.boxShadow = `0 0 0 3px ${t.accentBg || 'rgba(99,179,237,0.18)'}`;
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = t.border;
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              {/* Media */}
              {src ? (
                aud
                  ? <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', padding: 16, boxSizing: 'border-box' }}>
                      <audio src={src} controls preload="metadata" style={{ width: '100%' }}/>
                    </div>
                  : vid
                  ? <video src={src} muted playsInline autoPlay loop
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}/>
                  : <img src={src} alt={thumb.label || `option ${i + 1}`}
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}/>
              ) : (
                <div style={{
                  width: '100%', height: '100%',
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', gap: 8,
                  color: t.textMute, fontFamily: FONT_MONO, fontSize: 12,
                }}>
                  <span style={{ fontSize: 28, opacity: 0.3 }}>◻</span>
                  {thumb.label || `option ${i + 1}`}
                </div>
              )}

              {/* Number badge — top-left */}
              <div style={{
                position: 'absolute', top: 10, left: 10,
                background: 'rgba(0,0,0,0.72)', borderRadius: 5,
                padding: '3px 10px',
                color: '#fff', fontFamily: FONT_MONO, fontSize: 13, fontWeight: 600,
              }}>
                {i + 1}
              </div>

              {/* Label badge — bottom strip (if present) */}
              {thumb.label && (
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0,
                  background: 'linear-gradient(transparent, rgba(0,0,0,0.72))',
                  padding: '24px 12px 10px',
                  color: 'rgba(255,255,255,0.8)', fontFamily: FONT_MONO, fontSize: 11,
                }}>
                  {thumb.label}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

window.EditorCanvas = EditorCanvas;
window.ContextMenu = ContextMenu;
window.PickModal = PickModal;
