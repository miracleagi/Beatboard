// App entry — owns reducer, hydration, autosave, file import/export.

// ── Resizable side panels ─────────────────────────────────────────────────────
// Widths persist across restarts in localStorage (UI pref, not project data).
const PANEL_WIDTH_KEY = 'beatboard.ui.panelWidths';
const PANEL_DEFAULTS = { leftNodes: 168, leftLibrary: 260, right: 288 };
const PANEL_LIMITS = { leftNodes: [140, 420], leftLibrary: [180, 440], right: [232, 520] };

function loadPanelWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_WIDTH_KEY)) || {};
    return { ...PANEL_DEFAULTS, ...saved };
  } catch (_) {
    return { ...PANEL_DEFAULTS };
  }
}

// Thin vertical drag handle between a sidebar and the canvas.
// Drag to resize (clamped), double-click to reset to the default width.
function PanelSplitter({ t, side, getWidth, setWidth, limits, onReset, setDragging }) {
  const [hover, setHover] = React.useState(false);
  const onMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = getWidth();
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const raw = side === 'left' ? startW + dx : startW - dx;
      setWidth(Math.min(limits[1], Math.max(limits[0], raw)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onReset}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="拖动调整宽度 · 双击恢复默认"
      style={{
        width: 5, flex: 'none', cursor: 'col-resize', zIndex: 11,
        background: hover ? `${t.accent}66` : 'transparent',
        borderLeft: side === 'right' ? `1px solid ${t.border}` : 'none',
        borderRight: side === 'left' ? `1px solid ${t.border}` : 'none',
        transition: 'background 0.12s',
      }}
    />
  );
}

function downloadJSON(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

function App() {
  const [state, dispatch] = React.useReducer(appReducer, undefined, makeInitialState);

  // ── Undo history ────────────────────────────────────────────────────────────
  // historyRef holds up to MAX_UNDO snapshots of { projectId, graph } taken
  // just before each PATCH_GRAPH mutation.
  const MAX_UNDO = 50;
  const historyRef = React.useRef([]);
  // Keep a stable ref to the latest state so the wrapped dispatch can read it
  // without becoming a stale closure.
  const stateRef = React.useRef(state);
  stateRef.current = state;

  // Wrapped dispatch: intercept PATCH_GRAPH to snapshot the graph first.
  const dispatchWithHistory = (action) => {
    if (action.type === 'PATCH_GRAPH') {
      const s = stateRef.current;
      const proj = s.projects.find(p => p.id === s.activeProjectId);
      if (proj) {
        historyRef.current = [
          { projectId: proj.id, graph: proj.graph },
          ...historyRef.current,
        ].slice(0, MAX_UNDO);
      }
    }
    dispatch(action);
  };

  // MCP bridge: lets AI agents (Claude Code, Cursor, …) drive this same
  // reducer through the Rust-side MCP server. Agent edits are undoable.
  useMcpBridge({ stateRef, dispatch: dispatchWithHistory });

  // ── Storage hydration ────────────────────────────────────────────────────────
  const storageReadyRef = React.useRef(false);
  React.useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => Storage.load())
      .then((saved) => {
        if (cancelled) return;
        if (saved && saved.projects && saved.projects.length > 0) {
          dispatch({ type: 'HYDRATE', state: { ...saved, ui: makeInitialState().ui } });
        }
      })
      .catch((e) => console.warn('storage hydrate failed', e))
      .finally(() => {
        if (!cancelled) storageReadyRef.current = true;
      });
    return () => { cancelled = true; };
  }, []);

  // ── Autosave (debounced) on any state change ─────────────────────────────────
  const saveTimer = React.useRef(null);
  const doSave = React.useCallback(() => {
    const { ui, ...rest } = stateRef.current;
    try {
      Promise.resolve(Storage.save({ ...rest, ui: { /* leave empty */ } }))
        .catch((e) => console.warn('storage save failed', e));
    } catch (e) {
      console.warn('storage save failed', e);
    }
  }, []);

  React.useEffect(() => {
    if (!storageReadyRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(doSave, 250);
    return () => saveTimer.current && clearTimeout(saveTimer.current);
  }, [state, doSave]);

  // ── Save flash (brief "Saved ✓" indicator for ⌘S) ────────────────────────────
  const [saveFlash, setSaveFlash] = React.useState(false);
  const flashTimer = React.useRef(null);
  const triggerSaveFlash = () => {
    setSaveFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setSaveFlash(false), 1400);
  };

  // ── Theme ────────────────────────────────────────────────────────────────────
  const theme = 'dark';
  const t = TOKENS[theme];

  const project = state.projects.find(p => p.id === state.activeProjectId) || state.projects[0];

  // ── Import / Export ──────────────────────────────────────────────────────────
  const onImport = async (file) => {
    if (!file) return;
    try {
      const txt = await file.text();
      const data = JSON.parse(txt);
      const proj = data.project || data;
      dispatch({ type: 'IMPORT_PROJECT', project: proj });
    } catch (e) {
      console.error('Import failed', e);
      alert('Import failed: ' + e.message);
    }
  };
  const onExport = () => {
    const slug = (project.name || 'project').replace(/[^\w-]/g, '_').toLowerCase();
    downloadJSON(`${slug}.beatboard.json`, { format: 'beatboard-graph-v1', project: {
      name: project.name, color: project.color, outputDir: project.outputDir || '',
      graph: project.graph, runResults: project.runResults,
    }});
  };

  const spawnTemplateAt = (tpl, x, y) => {
    const fresh = tpl.spawn();
    const id = makeNodeId(project.graph, tpl.kind.slice(0, 3));

    let overrides = {};
    if (fresh.kind === 'output') {
      const existingCount = project.graph.nodes.filter(n => n.kind === 'output').length;
      const idx = String(existingCount + 1).padStart(2, '0');
      const base = (project.name || 'Output').replace(/\s+/g, ' ').trim();
      overrides = { title: `${base} ${idx}` };
    }

    dispatchWithHistory({ type: 'PATCH_GRAPH', fn: g => ({
      ...g,
      nodes: [...g.nodes, { ...fresh, ...overrides, id, x, y }],
    })});
    dispatch({ type: 'UI_PATCH', patch: { selectedNodeId: id, selectedEdgeIdx: null } });
  };

  // ── Sidebar fold + tab state ─────────────────────────────────────────────────
  const [leftOpen,  setLeftOpen]  = React.useState(true);
  const [leftTab,   setLeftTab]   = React.useState('nodes'); // 'nodes' | 'library'
  const [rightOpen, setRightOpen] = React.useState(true);

  // Drag-resizable panel widths (kept per left tab; persisted to localStorage)
  const [panelWidths, setPanelWidths] = React.useState(loadPanelWidths);
  const [panelDragging, setPanelDragging] = React.useState(false);
  React.useEffect(() => {
    try { localStorage.setItem(PANEL_WIDTH_KEY, JSON.stringify(panelWidths)); } catch (_) {}
  }, [panelWidths]);
  const leftKey = leftTab === 'library' ? 'leftLibrary' : 'leftNodes';
  const setPanelWidth = (key) => (w) => setPanelWidths(prev => ({ ...prev, [key]: Math.round(w) }));
  const resetPanelWidth = (key) => () => setPanelWidths(prev => ({ ...prev, [key]: PANEL_DEFAULTS[key] }));

  const leftPanelWidth = leftOpen ? panelWidths[leftKey] : 0;
  const panelTransition = panelDragging ? 'none' : 'width 0.18s ease';

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  // ⌘[ / ⌘]  toggle sidebars
  // ⌘S       force-save immediately + show flash
  // ⌘Z       undo last graph mutation
  React.useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;

      // Sidebar toggles
      if (e.key === '[') { e.preventDefault(); setLeftOpen(o => !o); return; }
      if (e.key === ']') { e.preventDefault(); setRightOpen(o => !o); return; }

      // ⌘S — immediate save
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
        doSave();
        triggerSaveFlash();
        return;
      }

      // ⌘Z — undo (skip if focus is inside a text input / textarea)
      if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        const tag = document.activeElement?.tagName?.toLowerCase();
        const isEditable = tag === 'input' || tag === 'textarea' ||
          document.activeElement?.isContentEditable;
        if (isEditable) return; // let the browser handle normal text undo
        e.preventDefault();
        if (historyRef.current.length === 0) return;
        const [prev, ...rest] = historyRef.current;
        historyRef.current = rest;
        dispatch({ type: 'UNDO_GRAPH', projectId: prev.projectId, graph: prev.graph });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doSave]); // doSave is stable (useCallback with no deps)

  // ── Palette → canvas drop / click-add ───────────────────────────────────────
  const onPaletteDropToCanvas = (tpl, clientX, clientY) => {
    const elt = document.elementFromPoint(clientX, clientY);
    if (!elt) return;
    const canvas = elt.closest('[data-canvas]');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left - (state.ui.panX || 0) - 100;
    const y = clientY - rect.top - (state.ui.panY || 0) - 30;
    spawnTemplateAt(tpl, x, y);
  };

  const onPaletteAddToCanvas = (tpl) => {
    const canvas = document.querySelector('[data-canvas]');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const offset = (project.graph.nodes.length % 8) * 22;
    const fresh = tpl.spawn();
    const x = Math.max(24, (rect.width - (fresh.w || 220)) / 2 - (state.ui.panX || 0) + offset);
    const y = Math.max(24, (rect.height - 160) / 2 - (state.ui.panY || 0) + offset);
    spawnTemplateAt(tpl, x, y);
  };

  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: t.bg, color: t.text,
      display: 'flex', flexDirection: 'column',
      fontFamily: FONT_UI,
      overflow: 'hidden',
    }}>
      <TopBar t={t} state={state} dispatch={dispatchWithHistory}
        onImport={onImport} onExport={onExport}
      />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>

        {/* ── Left sidebar (collapsible + drag-resizable) ──── */}
        <div style={{
          width: leftPanelWidth, flex: 'none',
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',  // lets Palette fill height via flex-grow
          transition: panelTransition,
        }}>
          <Palette t={t} onDrop={onPaletteDropToCanvas} onAdd={onPaletteAddToCanvas}
            state={state} dispatch={dispatchWithHistory}
            leftTab={leftTab} onLeftTabChange={setLeftTab}/>
        </div>
        {leftOpen && (
          <PanelSplitter t={t} side="left"
            getWidth={() => panelWidths[leftKey]}
            setWidth={setPanelWidth(leftKey)}
            limits={PANEL_LIMITS[leftKey]}
            onReset={resetPanelWidth(leftKey)}
            setDragging={setPanelDragging}/>
        )}

        {/* ── Canvas + edge toggle tabs ─────────────────── */}
        <div data-canvas style={{ flex: 1, display: 'flex', position: 'relative' }}>
          <EditorCanvas
            project={project} ui={state.ui} dispatch={dispatchWithHistory} config={state.config}
            theme={theme}
            cliStyle="hybrid"
            connectionStyle="bezier"
            previewStyle="hybrid"
            statusStyle="border"
          />

          {/* Left toggle pill */}
          <div
            onClick={() => setLeftOpen(o => !o)}
            title={`${leftOpen ? 'Collapse' : 'Expand'} left panel  ⌘[`}
            onMouseEnter={e => { e.currentTarget.style.background = t.panelHi; e.currentTarget.style.color = t.text; }}
            onMouseLeave={e => { e.currentTarget.style.background = t.panel;   e.currentTarget.style.color = t.textMute; }}
            style={{
              position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
              zIndex: 10, cursor: 'pointer',
              width: 14, height: 40,
              background: t.panel, color: t.textMute,
              border: `1px solid ${t.border}`, borderLeft: 'none',
              borderRadius: '0 5px 5px 0',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '2px 0 6px rgba(0,0,0,0.18)',
              transition: 'background 0.12s, color 0.12s',
            }}
          >
            <Icon name={leftOpen ? 'chevLeft' : 'chevRight'} size={9}/>
          </div>

          {/* Right toggle pill */}
          <div
            onClick={() => setRightOpen(o => !o)}
            title={`${rightOpen ? 'Collapse' : 'Expand'} right panel  ⌘]`}
            onMouseEnter={e => { e.currentTarget.style.background = t.panelHi; e.currentTarget.style.color = t.text; }}
            onMouseLeave={e => { e.currentTarget.style.background = t.panel;   e.currentTarget.style.color = t.textMute; }}
            style={{
              position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)',
              zIndex: 10, cursor: 'pointer',
              width: 14, height: 40,
              background: t.panel, color: t.textMute,
              border: `1px solid ${t.border}`, borderRight: 'none',
              borderRadius: '5px 0 0 5px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '-2px 0 6px rgba(0,0,0,0.18)',
              transition: 'background 0.12s, color 0.12s',
            }}
          >
            <Icon name={rightOpen ? 'chevRight' : 'chevLeft'} size={9}/>
          </div>

          {/* ⌘S save flash — briefly appears bottom-center of canvas */}
          {saveFlash && (
            <div style={{
              position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
              zIndex: 50, pointerEvents: 'none',
              background: t.panel, border: `1px solid ${t.green}`,
              borderRadius: 6, padding: '5px 14px',
              fontFamily: FONT_MONO, fontSize: 11, color: t.green,
              boxShadow: `0 2px 12px rgba(0,0,0,0.35), 0 0 0 1px ${t.green}22`,
              animation: 'atlasToastIn 0.12s ease',
            }}>
              Saved ✓
            </div>
          )}
        </div>

        {/* ── Right sidebar (collapsible + drag-resizable) ────────────────── */}
        {rightOpen && (
          <PanelSplitter t={t} side="right"
            getWidth={() => panelWidths.right}
            setWidth={setPanelWidth('right')}
            limits={PANEL_LIMITS.right}
            onReset={resetPanelWidth('right')}
            setDragging={setPanelDragging}/>
        )}
        <div style={{
          width: rightOpen ? panelWidths.right : 0, flex: 'none',
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',  // lets Inspector fill height via flex-grow
          transition: panelTransition,
        }}>
          <Inspector t={t} state={state} dispatch={dispatchWithHistory}/>
        </div>

      </div>
      <ConfigModal t={t} state={state} dispatch={dispatchWithHistory}/>

      {/* Inline keyframe for save flash */}
      <style>{`
        @keyframes atlasToastIn {
          from { opacity: 0; transform: translateX(-50%) translateY(6px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('app'));
root.render(<App/>);
