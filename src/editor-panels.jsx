// Panels — palette, top bar, inspector, config modal.
//
// Each panel is self-contained and reads state + dispatches actions via props.
// Persistence happens at the app level (editor-app.jsx).

// ============ NEW PROJECT MODAL ============
const TEMPLATES = [
  { k: 'blank',    l: 'Blank graph',            i: 'plus',    name: 'Untitled',       color: '#9aa9c2' },
  { k: 'iterate',  l: 'Template: Single Image', i: 'sparkle', name: 'Single Image',   color: '#7fc8ff' },
  { k: 'batch',    l: 'Template: Image to Video', i: 'film',  name: 'Image to Video', color: '#8ed4a8' },
  { k: 'assembly', l: 'Template: Short Film',   i: 'grid',    name: 'Short Film',     color: '#f4c47a' },
];

function NewProjectModal({ t, onConfirm, onCancel }) {
  const [kind, setKind] = React.useState('blank');
  const [name, setName] = React.useState('Untitled');
  const [outputDir, setOutputDir] = React.useState('');
  const nameRef = React.useRef(null);

  React.useEffect(() => { nameRef.current && nameRef.current.select(); }, []);

  const selectTemplate = (k) => {
    setKind(k);
    const tpl = TEMPLATES.find(t => t.k === k);
    if (tpl) setName(tpl.name);
  };

  const browseDir = async () => {
    if (typeof window.AtlasChooseOutputDir !== 'function') return;
    try {
      const chosen = await window.AtlasChooseOutputDir();
      if (chosen) setOutputDir(chosen);
    } catch (_) {}
  };

  const confirm = () => {
    const tpl = TEMPLATES.find(t => t.k === kind);
    let graph = { nodes: [], edges: [] };
    if (kind !== 'blank') {
      const sc = { iterate: SCENARIO_ITERATE, batch: SCENARIO_BATCH, assembly: SCENARIO_ASSEMBLY }[kind];
      if (sc) graph = {
        nodes: sc.nodes.map(({ state, progress, ...rest }) => rest),
        edges: sc.edges.map(e => ({ ...e })),
      };
    }
    onConfirm({ name: name.trim() || 'Untitled', color: tpl?.color || '#7fc8ff', outputDir, graph });
  };

  const inputStyle = {
    background: t.bg, border: `1px solid ${t.border}`, borderRadius: 5,
    color: t.text, fontFamily: FONT_UI, fontSize: 12,
    padding: '6px 10px', width: '100%', outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{
        background: t.panel, border: `1px solid ${t.borderStrong}`, borderRadius: 10,
        padding: 24, width: 380, fontFamily: FONT_UI,
        boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: t.text, marginBottom: 18 }}>New Project</div>

        {/* Template picker */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, color: t.textMute, fontFamily: FONT_MONO, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>Template</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {TEMPLATES.map(tpl => (
              <div key={tpl.k} onClick={() => selectTemplate(tpl.k)} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', borderRadius: 5, cursor: 'pointer',
                background: kind === tpl.k ? t.accentBg : 'transparent',
                border: `1px solid ${kind === tpl.k ? t.accentBorder : 'transparent'}`,
                color: kind === tpl.k ? t.accent : t.text,
              }}>
                <Icon name={tpl.i} size={11} color={kind === tpl.k ? t.accent : t.textMid}/>
                <span style={{ fontSize: 12 }}>{tpl.l}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Project name */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, color: t.textMute, fontFamily: FONT_MONO, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>Project name</div>
          <input
            ref={nameRef}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') onCancel(); }}
            spellCheck={false}
            style={inputStyle}
          />
        </div>

        {/* Save directory (optional) */}
        {typeof window.AtlasChooseOutputDir === 'function' && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 10, color: t.textMute, fontFamily: FONT_MONO, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>Save directory <span style={{ opacity: 0.5 }}>(optional)</span></div>
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{
                ...inputStyle, flex: 1, color: outputDir ? t.text : t.textMute,
                fontFamily: FONT_MONO, fontSize: 10.5,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {outputDir || 'Not set — choose later in inspector'}
              </div>
              <Btn size="sm" theme="dark" leftIcon="folder" onClick={browseDir}>Browse</Btn>
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn size="sm" theme="dark" onClick={onCancel}>Cancel</Btn>
          <Btn size="sm" primary theme="dark" onClick={confirm}>Create</Btn>
        </div>
      </div>
    </div>
  );
}

// ============ TOP BAR (project tabs + run actions) ============
function TopBar({ t, state, dispatch, onImport, onExport }) {
  const active = state.projects.find(p => p.id === state.activeProjectId);
  const [showNewModal, setShowNewModal] = React.useState(false);
  const fileRef = React.useRef(null);

  const handleConfirm = ({ name, color, outputDir, graph }) => {
    setShowNewModal(false);
    dispatch({ type: 'NEW_PROJECT', name, color, outputDir, graph });
  };

  // In Tauri with titleBarStyle:Overlay the traffic lights sit inside our header.
  // We need to (a) mark the header as a drag region and (b) leave ~75px clear on the left.
  const isTauri = typeof window.__TAURI__ !== 'undefined';

  // Drag: use Tauri's startDragging() API directly — more reliable than CSS alone.
  const onDragRegionMouseDown = (e) => {
    if (e.button !== 0) return;
    // Don't steal clicks from interactive elements
    if (e.target.closest('button, input, a, [data-no-drag]')) return;
    if (isTauri) {
      try { window.__TAURI__.window.appWindow.startDragging(); } catch (_) {}
    }
  };

  // Double-click to toggle maximize/restore
  const onDragRegionDblClick = (e) => {
    if (e.target.closest('button, input, a, [data-no-drag]')) return;
    if (isTauri) {
      try { window.__TAURI__.window.appWindow.toggleMaximize(); } catch (_) {}
    }
  };

  return (
    <>
    {showNewModal && (
      <NewProjectModal t={t} onConfirm={handleConfirm} onCancel={() => setShowNewModal(false)} />
    )}
    <div
      data-tauri-drag-region
      onMouseDown={onDragRegionMouseDown}
      onDoubleClick={onDragRegionDblClick}
      style={{
        height: 40, flex: 'none',
        background: t.bg2,
        borderBottom: `1px solid ${t.border}`,
        display: 'flex', alignItems: 'stretch',
        fontFamily: FONT_UI,
        position: 'relative', zIndex: 6,
        WebkitAppRegion: 'drag',
        userSelect: 'none',
      }}
    >
      {/* App mark — shift right in Tauri to clear macOS traffic lights (~75px) */}
      <div data-tauri-drag-region style={{
        width: isTauri ? 155 : 130, display: 'flex', alignItems: 'center', gap: 8,
        padding: isTauri ? '0 14px 0 78px' : '0 14px',
        borderRight: `1px solid ${t.border}`,
        WebkitAppRegion: 'drag',
      }}>
        <AtlasLogo size={18} t={t}/>
        <span style={{ color: t.text, fontSize: 12, fontWeight: 600, letterSpacing: -0.1 }}>Atlas</span>
        <span style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 9, marginLeft: 'auto' }}>v0.9.0</span>
      </div>

      {/* Project tabs */}
      <div style={{ display: 'flex', alignItems: 'stretch', flex: 1, minWidth: 0, overflow: 'hidden', WebkitAppRegion: 'no-drag' }}>
        {state.projects.map(p => {
          const a = p.id === state.activeProjectId;
          return (
            <div
              key={p.id}
              onClick={() => dispatch({ type: 'SWITCH_PROJECT', id: p.id })}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '0 10px 0 14px',
                borderRight: `1px solid ${t.border}`,
                background: a ? t.bg : 'transparent',
                color: a ? t.text : t.textMid,
                fontSize: 12, cursor: 'pointer',
                position: 'relative', minWidth: 0, maxWidth: 240,
              }}
            >
              {a && <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, height: 2,
                background: t.accent,
              }}/>}
              <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color || t.textMute, flex: 'none' }}/>
              <input
                value={p.name}
                onChange={(e) => dispatch({ type: 'RENAME_PROJECT', id: p.id, name: e.target.value })}
                spellCheck={false}
                onClick={(e) => e.stopPropagation()}
                style={{
                  background: 'transparent', color: 'inherit',
                  border: 'none', outline: 'none', padding: 0,
                  fontSize: 12, minWidth: 0, width: 'auto',
                  flex: 1,
                }}
              />
              <span style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 10 }}>{p.graph.nodes.length}n</span>
              {a && state.projects.length > 1 && (
                <span
                  onClick={(e) => { e.stopPropagation(); dispatch({ type: 'CLOSE_PROJECT', id: p.id }); }}
                  style={{ color: t.textMute, padding: '2px 4px', borderRadius: 3, cursor: 'pointer' }}
                  onMouseEnter={(e) => e.currentTarget.style.background = t.panel2}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                ><Icon name="close" size={10}/></span>
              )}
            </div>
          );
        })}

        {/* New project button */}
        <div
          onClick={() => setShowNewModal(true)}
          style={{
            padding: '0 12px', display: 'flex', alignItems: 'center',
            color: t.textMid, cursor: 'pointer', height: '100%',
          }}
        ><Icon name="plus" size={13}/></div>

        {/* Import hidden file input */}
        <input
          ref={fileRef} type="file" accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => { onImport(e.target.files[0]); e.target.value = ''; }}
        />
      </div>

      {/* Right cluster */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 12px',
        borderLeft: `1px solid ${t.border}`,
        WebkitAppRegion: 'no-drag',
      }}>
        <Btn size="sm" leftIcon="download" theme="dark" onClick={onExport}>Export</Btn>
        <Btn size="sm" leftIcon="settings" theme="dark" onClick={() => dispatch({ type: 'UI_PATCH', patch: { configOpen: true } })}>Config</Btn>
      </div>
    </div>
    </>
  );
}

// ============ LIBRARY THUMB ============
// Lightweight thumbnail for the Library grid.
// Unlike MediaThumb, this does NOT call stopPropagation on mousedown,
// so drag handling on parent containers works correctly.
function LibraryThumb({ t, thumb, h = 52 }) {
  const [failed, setFailed] = React.useState(false);
  const src = mediaSrc(thumb);
  const isVid = isVideoThumb(thumb, src);
  const label = thumb?.label || '';

  if (!src || failed) {
    return (
      <Placeholder
        theme="dark" w="100%" h={h}
        label={label} seed={thumb?.seed || src || 'lib'}
        radius={3}
      />
    );
  }
  return (
    <div style={{
      width: '100%', height: h, borderRadius: 3, overflow: 'hidden',
      position: 'relative', border: `1px solid ${t.border}`, background: t.bg2,
    }}>
      {isVid ? (
        <video src={src} muted playsInline autoPlay loop preload="auto"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}
          onError={() => setFailed(true)}
        />
      ) : (
        <img src={src} alt={label} draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

// ============ LIBRARY PAGE (shown in Library tab of Palette) ============
function LibraryPage({ t, library, dispatch, onDrop, onAdd }) {
  const [search, setSearch] = React.useState('');
  const [dragItem, setDragItem] = React.useState(null);
  const [dragPos,  setDragPos]  = React.useState(null);

  const groups = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = (library || []).filter(item =>
      !q ||
      (item.projName || '').toLowerCase().includes(q) ||
      (item.thumb?.label || '').toLowerCase().includes(q)
    );
    const map = {};
    filtered.forEach(item => {
      if (!map[item.projId]) map[item.projId] = { projId: item.projId, projName: item.projName, projColor: item.projColor, items: [] };
      map[item.projId].items.push(item);
    });
    return Object.values(map);
  }, [library, search]);

  const makeTpl = (item) => ({
    title: item.thumb?.label || 'library item',
    kind: 'asset',
    group: 'Library',
    spawn: () => {
      const s = mediaSrc(item.thumb);
      const isVid = isVideoThumb(item.thumb, s);
      return {
        kind: 'asset',
        title: item.thumb?.label || (isVid ? 'imported.mp4' : 'imported.png'),
        w: 180, badge: 'asset',
        thumbs: [{ ...item.thumb, chosen: true }],
        ports: [{ kind: isVid ? 'video' : 'image', side: 'right', top: 36 }],
        footer: { left: `from ${item.projName}`, right: 'ready' },
      };
    },
  });

  const onItemMouseDown = (item, e) => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    const tpl = makeTpl(item);
    const onMove = (ev) => {
      if (!dragging && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 4) {
        dragging = true;
        setDragItem(item);
      }
      if (dragging) setDragPos({ x: ev.clientX, y: ev.clientY });
    };
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (dragging) onDrop(tpl, ev.clientX, ev.clientY);
      else onAdd && onAdd(tpl);
      setDragItem(null);
      setDragPos(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <>
      {/* Search bar */}
      <div style={{ padding: '7px 10px', borderBottom: `1px solid ${t.border}`, flex: 'none' }}>
        <input
          placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}
          style={{
            width: '100%', background: t.bg, border: `1px solid ${t.border}`, borderRadius: 4,
            color: t.text, fontFamily: FONT_UI, fontSize: 11, padding: '4px 8px',
            outline: 'none', boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Content */}
      {(!library || library.length === 0) ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px 16px' }}>
          <Icon name="image" size={22} color={t.textMute}/>
          <div style={{ marginTop: 10, textAlign: 'center', color: t.textMute, fontSize: 11, lineHeight: 1.65 }}>
            Nothing here yet.<br/>
            <span style={{ fontFamily: FONT_MONO, fontSize: 10, opacity: 0.7 }}>
              Select an output or pick node<br/>and click "Collect to Library"
            </span>
          </div>
        </div>
      ) : (
        <div className="mg-scroll" style={{ flex: 1, overflow: 'auto', padding: '4px 0 14px' }}>
          {groups.length === 0 && search && (
            <div style={{ padding: '16px 12px', textAlign: 'center', color: t.textMute, fontFamily: FONT_MONO, fontSize: 10.5 }}>
              No results for "{search}"
            </div>
          )}
          {groups.map(group => (
            <div key={group.projId} style={{ marginBottom: 8 }}>
              {/* Project label */}
              <div style={{
                padding: '5px 10px 6px',
                display: 'flex', alignItems: 'center', gap: 5,
                color: t.textMute, fontFamily: FONT_MONO, fontSize: 9,
                letterSpacing: 0.6, textTransform: 'uppercase',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: 1, background: group.projColor || t.textMute, flex: 'none' }}/>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{group.projName}</span>
                <span style={{ opacity: 0.5 }}>{group.items.length}</span>
              </div>

              {/* 3-column thumb grid */}
              <div style={{ padding: '0 8px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
                {group.items.map((item, i) => (
                  // onMouseDown lives here — LibraryThumb does NOT stopPropagation,
                  // so the drag starts correctly.
                  <div key={item.id || i}
                    onMouseDown={(e) => onItemMouseDown(item, e)}
                    title={`${item.thumb?.label || 'media'} · click to add, drag to place`}
                    style={{
                      position: 'relative', cursor: 'grab',
                      opacity: dragItem === item ? 0.35 : 1, transition: 'opacity 0.1s',
                    }}>
                    <LibraryThumb t={t} thumb={item.thumb} h={52}/>
                    {/* Remove × */}
                    <div
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); dispatch({ type: 'LIBRARY_REMOVE', id: item.id }); }}
                      title="Remove from Library"
                      style={{
                        position: 'absolute', top: 2, right: 2, zIndex: 2,
                        width: 14, height: 14, borderRadius: '50%',
                        background: 'rgba(0,0,0,0.65)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer',
                      }}
                    >
                      <Icon name="close" size={8} color="#fff"/>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Drag ghost */}
      {dragItem && dragPos && (() => {
        const s = mediaSrc(dragItem.thumb);
        const isVid = isVideoThumb(dragItem.thumb, s);
        return (
          <div style={{
            position: 'fixed', left: dragPos.x - 50, top: dragPos.y - 36,
            width: 100, height: 60, borderRadius: 5,
            border: `1.5px dashed ${t.accent}`,
            pointerEvents: 'none', zIndex: 9999, overflow: 'hidden',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}>
            {isVid
              ? <video src={s} muted playsInline autoPlay loop style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
              : <img src={s} style={{ width: '100%', height: '100%', objectFit: 'cover' }} draggable={false}/>
            }
          </div>
        );
      })()}
    </>
  );
}

// ============ PALETTE ============
// leftTab + onLeftTabChange are lifted to editor-app so sidebar width can respond.
function Palette({ t, onDrop, onAdd, state, dispatch, leftTab, onLeftTabChange }) {
  const library = state.library || [];
  const groups = React.useMemo(() => {
    const m = {};
    NODE_TEMPLATES.forEach((tpl, i) => {
      m[tpl.group] = m[tpl.group] || [];
      m[tpl.group].push({ ...tpl, idx: i });
    });
    return Object.entries(m);
  }, []);
  const [dragTpl, setDragTpl] = React.useState(null);
  const [dragPos, setDragPos] = React.useState(null);

  const onItemMouseDown = (tpl, e) => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!dragging && Math.abs(dx) + Math.abs(dy) > 4) { dragging = true; setDragTpl(tpl); }
      if (dragging) setDragPos({ x: ev.clientX, y: ev.clientY });
    };
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (dragging) onDrop(tpl, ev.clientX, ev.clientY);
      else onAdd && onAdd(tpl);
      setDragTpl(null);
      setDragPos(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const TABS = [
    { id: 'nodes',   label: 'Nodes'   },
    { id: 'library', label: 'Library' },
  ];

  return (
    <>
      <div style={{
        width: '100%', flex: 1, minHeight: 0,
        background: t.bg2, borderRight: `1px solid ${t.border}`,
        display: 'flex', flexDirection: 'column',
        fontFamily: FONT_UI,
        overflow: 'hidden',
      }}>
        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: `1px solid ${t.border}`, flex: 'none' }}>
          {TABS.map(tab => (
            <div key={tab.id} onClick={() => onLeftTabChange(tab.id)} style={{
              flex: 1, padding: '9px 0', textAlign: 'center', cursor: 'pointer',
              fontSize: 11.5, fontWeight: leftTab === tab.id ? 600 : 400,
              color: leftTab === tab.id ? t.text : t.textMute,
              borderBottom: `2px solid ${leftTab === tab.id ? t.accent : 'transparent'}`,
              transition: 'color 0.1s',
              userSelect: 'none',
            }}>
              {tab.label}
              {tab.id === 'library' && library.length > 0 && (
                <span style={{ marginLeft: 4, fontFamily: FONT_MONO, fontSize: 9, opacity: 0.75 }}>
                  {library.length}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Nodes tab */}
        {leftTab === 'nodes' && (
          <div className="mg-scroll" style={{ flex: 1, overflow: 'auto', padding: '4px 0 14px' }}>
            {groups.map(([name, items]) => (
              <div key={name} style={{ marginBottom: 8 }}>
                <div style={{
                  padding: '6px 12px',
                  color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
                  letterSpacing: 0.6, textTransform: 'uppercase',
                }}>{name}</div>
                {items.map(item => (
                  <div key={item.idx}
                    onMouseDown={(e) => onItemMouseDown(item, e)}
                    title="Click to add to the canvas, or drag to place"
                    style={{
                      padding: '5px 12px',
                      display: 'flex', alignItems: 'center', gap: 8,
                      color: t.text, fontSize: 11.5,
                      cursor: 'grab',
                      opacity: dragTpl && dragTpl.idx === item.idx ? 0.5 : 1,
                    }}
                  >
                    <Icon name={
                      item.kind === 'cli' ? 'terminal' :
                      item.kind === 'gen' ? 'sparkle' :
                      item.kind === 'motion' ? 'motion' :
                      item.kind === 'prompt' ? 'sparkle' :
                      item.kind === 'select' ? 'check' :
                      item.kind === 'asset' ? 'image' :
                      item.kind === 'output' ? 'film' : 'image'
                    } size={12}
                      color={item.kind === 'cli' ? t.amber : item.kind === 'output' ? t.green : t.accent}/>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                    {item.api && (
                      <span style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 9, letterSpacing: 0.3 }}>
                        {(PROVIDER_LABEL[item.api] || item.api).toUpperCase()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Library tab */}
        {leftTab === 'library' && (
          <LibraryPage t={t} library={library} dispatch={dispatch} onDrop={onDrop} onAdd={onAdd}/>
        )}
      </div>

      {/* Nodes drag ghost */}
      {dragTpl && dragPos && (
        <div style={{
          position: 'fixed', left: dragPos.x - 100, top: dragPos.y - 18,
          width: 200,
          background: t.panel, border: `1px dashed ${t.accent}`, borderRadius: 6,
          padding: '6px 10px', fontFamily: FONT_MONO, fontSize: 10.5, color: t.text,
          pointerEvents: 'none', zIndex: 9999,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>
          + {dragTpl.title}
        </div>
      )}
    </>
  );
}

// ============ PIXVERSE SUPPORT MATRIX ============
const PIXVERSE_CREATE_SPECS = {
  image: {
    command: 'pixverse create image',
    models: ['qwen-image', 'gpt-image-2.0', 'gemini-2.5-flash', 'gemini-3.0', 'gemini-3.1-flash', 'seedream-4.0', 'seedream-4.5', 'seedream-5.0-lite', 'kling-image-v3', 'kling-image-o3'],
    params: [
      '--prompt', '--image', '--images', '--model', '--quality', '--aspect-ratio',
      '--detail-level', '--count', '--seed', '--idempotency-key', '--no-wait',
      '--timeout', '--json',
    ],
    modes: [
      { id: 'T2I', label: 'Text to image', required: ['--prompt'] },
      { id: 'I2I', label: 'Image to image', required: ['--prompt', '--image / --images'] },
    ],
  },
  video: {
    command: 'pixverse create video',
    models: ['v6', 'v5.6', 'pixverse-c1', 'seedance-2.0-standard', 'seedance-2.0-fast', 'kling-3.0-pro', 'kling-3.0-standard', 'kling-o3-pro', 'kling-o3-standard', 'veo-3.1-standard', 'veo-3.1-lite', 'veo-3.1-fast', 'sora-2-pro', 'sora-2', 'happyhorse-1.0', 'grok-imagine'],
    params: [
      '--prompt', '--image', '--model', '--duration', '--quality', '--aspect-ratio',
      '--seed', '--count', '--audio', '--no-audio', '--multi-shot',
      '--no-multi-shot', '--off-peak', '--idempotency-key', '--no-wait',
      '--timeout', '--json',
    ],
    modes: [
      { id: 'T2V', label: 'Text to video', required: ['--prompt'] },
      { id: 'I2V', label: 'Image to video', required: ['--prompt', '--image'] },
    ],
  },
  transition: {
    command: 'pixverse create transition',
    models: ['v6', 'pixverse-c1', 'seedance-2.0-standard', 'seedance-2.0-fast', 'kling-3.0-pro', 'kling-3.0-standard', 'kling-o3-pro', 'kling-o3-standard', 'veo-3.1-standard', 'veo-3.1-lite', 'veo-3.1-fast', 'v5.6'],
    params: ['--from', '--to', '--model', '--quality', '--aspect-ratio', '--timeout', '--json'],
  },
  reference: {
    command: 'pixverse create reference',
    models: ['v6', 'pixverse-c1', 'seedance-2.0-standard', 'seedance-2.0-fast', 'kling-o3-pro', 'kling-o3-standard', 'grok-imagine', 'v5.6'],
    params: ['--prompt', '--images', '--model', '--quality', '--aspect-ratio', '--timeout', '--json'],
  },
  'motion-control': {
    command: 'pixverse create motion-control',
    models: ['v5.6'],
    params: ['--image', '--motion-ref', '--model', '--quality', '--aspect-ratio', '--timeout', '--json'],
  },
  extend: {
    command: 'pixverse create extend',
    models: ['v6', 'grok-imagine'],
    params: ['--video-id', '--model', '--timeout', '--json'],
  },
  upscale: {
    command: 'pixverse create upscale',
    models: [],
    params: ['--video-id', '--quality', '--timeout', '--json'],
  },
  speech: {
    command: 'pixverse create speech',
    models: ['v5'],
    params: ['--video-id', '--text', '--model', '--timeout', '--json'],
  },
};

function pixVerseSpecFor(sub) {
  return PIXVERSE_CREATE_SPECS[sub] || PIXVERSE_CREATE_SPECS.image;
}

// Detect which pixverse subcommand a node represents
function pixVerseSubcommand(node) {
  const args = node?.cli?.args || [];
  const idx = args.indexOf('create');
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  const footer = String(node?.footer?.left || '').toLowerCase();
  if (/create transition/.test(footer)) return 'transition';
  if (/create reference/.test(footer)) return 'reference';
  if (/create motion-control/.test(footer)) return 'motion-control';
  if (/create extend/.test(footer)) return 'extend';
  if (/create upscale/.test(footer)) return 'upscale';
  if (/create speech/.test(footer)) return 'speech';
  if (/create video/.test(footer)) return 'video';
  return 'image';
}

// ============ CLI ARG HELPERS ============
function cliCommandName(node) {
  const raw = node?.cli?.cmd || node?.cli?.bin || '';
  return String(raw).trim().split(/\s+/)[0].split(/[\\/]/).pop();
}

function isPixVerseCli(node) {
  return node?.kind === 'cli' && cliCommandName(node) === 'pixverse';
}

function cliArg(args, flag, fallback = '') {
  const i = (args || []).indexOf(flag);
  if (i < 0) return fallback;
  const next = args[i + 1];
  return next && !String(next).startsWith('--') ? next : fallback;
}

function hasCliFlag(args, flag) {
  return (args || []).includes(flag);
}

function upsertCliArg(args, flag, value) {
  const next = [...(args || [])];
  const i = next.indexOf(flag);
  if (value == null || value === '') {
    if (i >= 0) {
      const removeCount = next[i + 1] && !String(next[i + 1]).startsWith('--') ? 2 : 1;
      next.splice(i, removeCount);
    }
    return next;
  }
  if (i >= 0) {
    if (next[i + 1] && !String(next[i + 1]).startsWith('--')) next[i + 1] = String(value);
    else next.splice(i + 1, 0, String(value));
    return next;
  }
  const jsonIdx = next.indexOf('--json');
  const insertAt = jsonIdx >= 0 ? jsonIdx : next.length;
  next.splice(insertAt, 0, flag, String(value));
  return next;
}

function setCliToggle(args, flag, enabled) {
  const next = (args || []).filter(a => a !== flag);
  if (!enabled) return next;
  const jsonIdx = next.indexOf('--json');
  const insertAt = jsonIdx >= 0 ? jsonIdx : next.length;
  next.splice(insertAt, 0, flag);
  return next;
}


function pixVerseFields(sub, args) {
  if (sub === 'image') {
    return [
      { k: 'mode', v: 'T2I/I2I' },
      { k: 'model', v: cliArg(args, '--model', 'qwen-image') },
      { k: 'quality', v: cliArg(args, '--quality', '1080p') },
      { k: 'ratio', v: cliArg(args, '--aspect-ratio', '16:9') },
      { k: 'count', v: cliArg(args, '--count', '1') },
    ];
  }
  if (sub === 'video') {
    return [
      { k: 'mode', v: 'T2V/I2V' },
      { k: 'model', v: cliArg(args, '--model', 'v6') },
      { k: 'duration', v: `${cliArg(args, '--duration', '5')}s` },
      { k: 'quality', v: cliArg(args, '--quality', '720p') },
      { k: 'ratio', v: cliArg(args, '--aspect-ratio', '16:9') },
    ];
  }
  if (sub === 'transition') {
    return [
      { k: 'mode', v: 'transition' },
      { k: 'model', v: cliArg(args, '--model', 'v6') },
      { k: 'quality', v: cliArg(args, '--quality', '720p') },
      { k: 'ratio', v: cliArg(args, '--aspect-ratio', '16:9') },
    ];
  }
  if (sub === 'reference') {
    return [
      { k: 'mode', v: 'reference' },
      { k: 'model', v: cliArg(args, '--model', 'v6') },
      { k: 'quality', v: cliArg(args, '--quality', '720p') },
      { k: 'ratio', v: cliArg(args, '--aspect-ratio', '16:9') },
    ];
  }
  if (sub === 'motion-control') {
    return [
      { k: 'mode', v: 'motion-control' },
      { k: 'model', v: 'v5.6' },
      { k: 'quality', v: cliArg(args, '--quality', '720p') },
      { k: 'ratio', v: cliArg(args, '--aspect-ratio', '16:9') },
    ];
  }
  if (sub === 'extend') {
    return [
      { k: 'mode', v: 'extend' },
      { k: 'model', v: cliArg(args, '--model', 'v6') },
    ];
  }
  if (sub === 'upscale') {
    return [
      { k: 'mode', v: 'upscale' },
      { k: 'quality', v: cliArg(args, '--quality', '1080p') },
    ];
  }
  if (sub === 'speech') {
    return [
      { k: 'mode', v: 'speech' },
      { k: 'model', v: cliArg(args, '--model', 'v5') },
    ];
  }
  return [{ k: 'mode', v: sub }];
}

const GENERATOR_MODEL_PRESETS = {
  pixverse: PIXVERSE_CREATE_SPECS.image.models,
  replicate: ['black-forest-labs/flux.1-dev', 'black-forest-labs/flux-schnell'],
  google: ['imagen-3.0-generate'],
  openai: ['gpt-image-2.0'],
  fal: ['fal-ai/flux/dev'],
};

const MOTION_MODEL_PRESETS = {
  pixverse: PIXVERSE_CREATE_SPECS.video.models,
  piapi: ['kling-1.6'],
  google: ['veo-3.0-generate', 'veo-3.1-lite'],
  local: ['wan-2.1'],
  fal: ['fal-ai/kling-video/v1.6/pro/image-to-video'],
};

function modelPresetsFor(node) {
  const presets = node.kind === 'motion' ? MOTION_MODEL_PRESETS : GENERATOR_MODEL_PRESETS;
  return presets[node.provider] || [];
}

const MODEL_TITLE = {
  'black-forest-labs/flux.1-dev': 'Flux.1-dev',
  'black-forest-labs/flux-schnell': 'Flux Schnell',
  'fal-ai/flux/dev': 'Flux Dev',
  'imagen-3.0-generate': 'Imagen 3',
  'gpt-image-2.0': 'gpt-image-2.0',
  'qwen-image': 'qwen-image',
  'v6': 'PixVerse v6',
  'seedance-2.0-standard': 'Seedance 2.0',
  'veo-3.0-generate': 'Veo 3',
  'veo-3.1-lite': 'Veo 3.1 Lite',
  'kling-1.6': 'Kling 1.6',
  'wan-2.1': 'Wan 2.1',
};

function modelDisplayTitle(model) {
  const id = String(model || '').trim();
  if (!id) return 'Model';
  return MODEL_TITLE[id] || id.split('/').filter(Boolean).pop() || id;
}

function defaultModelForProvider(node, provider) {
  const presets = node.kind === 'motion' ? MOTION_MODEL_PRESETS : GENERATOR_MODEL_PRESETS;
  return presets[provider]?.[0] || node.model || '';
}

function normalizedCount(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

function displayPortCount(value, fallback = 1) {
  return Math.min(12, normalizedCount(value, fallback));
}

function connectedOutputCount(graph, node) {
  if (!graph || !node) return 0;
  let count = 0;
  (graph.edges || []).forEach(edge => {
    if (edge.from?.node !== node.id) return;
    const port = (node.ports || [])[edge.from.port];
    if (!port || port.side !== 'right') return;
    const ordinal = (node.ports || [])
      .slice(0, edge.from.port + 1)
      .filter(p => p.side === 'right').length;
    count = Math.max(count, ordinal);
  });
  return count;
}

function outputPortsFor(node, count, kind, graph) {
  const current = node.ports || [];
  const left = current.filter(p => p.side === 'left');
  const firstRight = current.find(p => p.side === 'right');
  const right = [{
    kind,
    side: 'right',
    top: firstRight?.top || (kind === 'video' ? 58 : 60),
  }];
  return [...left, ...right];
}

function resizedThumbsFor(node, count, kind) {
  const existing = node.thumbs || [];
  const n = displayPortCount(count);
  return Array.from({ length: n }, (_, i) => existing[i] || {
    seed: `${node.id || kind}-${i + 1}`,
    label: kind,
    type: kind,
    chosen: i === 0,
  });
}

function runtimeBadge(node) {
  if (node.kind === 'gen') {
    if (node.provider === 'pixverse') return `pixverse · ${node.count || 1}×`;
    return `api · ${node.count || 1}×`;
  }
  if (node.kind === 'motion') {
    const duration = node.duration || 5;
    if (node.provider === 'pixverse') return `pixverse · ${duration}s`;
    return `img→vid · ${duration}s`;
  }
  return node.badge;
}

function runtimeFooter(node) {
  const previous = node.footer || {};
  const right = previous.right || '— idle';
  if (node.kind === 'gen') {
    if (node.provider === 'pixverse') {
      const quality = node.quality || '1080p';
      const ratio = node.aspectRatio || (String(node.size || '').includes(':') ? node.size : '16:9');
      const count = node.count || 1;
      return { ...previous, left: `pixverse image · ${quality} · ${ratio} · ${count}×`, right };
    }
    const seed = node.seed || 'auto';
    const steps = node.steps ? ` · ${node.steps} steps` : '';
    return { ...previous, left: `seed ${seed}${steps}`, right };
  }
  if (node.kind === 'motion') {
    const duration = node.duration || 5;
    if (node.provider === 'pixverse') {
      const quality = node.quality || '720p';
      return { ...previous, left: `pixverse video · ${duration}s · ${quality}`, right };
    }
    return { ...previous, left: node.motionPrompt || modelDisplayTitle(node.model), right };
  }
  return previous;
}

function runtimePatchFor(node, patch, graph) {
  const next = { ...node, ...patch };
  if (next.kind !== 'gen' && next.kind !== 'motion') return patch;
  const outKind = next.kind === 'motion' ? 'video' : 'image';
  const nextPatch = {
    ...patch,
    title: modelDisplayTitle(next.model),
    badge: runtimeBadge(next),
    footer: runtimeFooter(next),
  };
  if (patch.count != null) {
    nextPatch.ports = outputPortsFor(next, next.count, outKind, graph);
    nextPatch.thumbs = resizedThumbsFor(next, next.count, outKind);
  }
  return nextPatch;
}

function pixVerseCliPortsFor(node, mode, count, graph) {
  const outKind = mode === 'video' ? 'video' : 'image';
  return outputPortsFor(node, count, outKind, graph);
}

// Subcommands that have a user-selectable --model flag
const PV_HAS_MODEL = new Set(['image','video','transition','reference','extend','speech']);

function pixVerseCliPatchFor(node, sub, nextArgs, graph) {
  const mode = sub === 'image' ? 'image' : 'video';
  // Only read model for subcommands that actually support --model;
  // motion-control is fixed to v5.6, upscale has no model flag.
  const model = PV_HAS_MODEL.has(sub) ? cliArg(nextArgs, '--model', sub === 'image' ? 'qwen-image' : 'v6') : '';
  const quality = cliArg(nextArgs, '--quality', sub === 'image' ? '1080p' : '720p');
  const ratio = cliArg(nextArgs, '--aspect-ratio', '16:9');
  const count = normalizedCount(cliArg(nextArgs, '--count', '1'));
  const duration = mode === 'video' ? `${cliArg(nextArgs, '--duration', '5')}s` : null;

  // Build a human-readable footer left string per subcommand
  let footerLeft;
  switch (sub) {
    case 'image':    footerLeft = `pixverse image · ${quality} · ${ratio} · ${count}×`; break;
    case 'video':    footerLeft = `pixverse video · ${duration} · ${quality} · ${count}×`; break;
    case 'transition': footerLeft = `pixverse create transition · ${model} · ${quality}`; break;
    case 'reference':  footerLeft = `pixverse create reference · ${model} · ${quality}`; break;
    case 'motion-control': footerLeft = `pixverse create motion-control · v5.6 · ${quality}`; break;
    case 'extend':   footerLeft = `pixverse create extend · ${model}`; break;
    case 'upscale':  footerLeft = `pixverse create upscale · ${quality}`; break;
    case 'speech':   footerLeft = `pixverse create speech · ${model}`; break;
    default:         footerLeft = `pixverse create ${sub}`;
  }

  return {
    title: model ? `PixVerse ${sub} · ${modelDisplayTitle(model)}` : `PixVerse ${sub}`,
    badge: 'cli · pixverse',
    footer: {
      ...(node.footer || {}),
      left: footerLeft,
      right: node.footer?.right || '— idle',
    },
    ports: pixVerseCliPortsFor(node, mode, count, graph),
    cli: {
      ...node.cli,
      args: nextArgs,
      fields: pixVerseFields(sub, nextArgs),
    },
  };
}

// ============ INSPECTOR ============
function Inspector({ t, state, dispatch }) {
  const project = state.projects.find(p => p.id === state.activeProjectId) || state.projects[0];
  if (!project) return <div style={inspectorShell(t)}/>;
  const graph = project.graph;
  const node = state.ui.selectedNodeId && graph.nodes.find(n => n.id === state.ui.selectedNodeId);
  const result = node && project.runResults[node.id];

  // Edge selected?
  if (state.ui.selectedEdgeIdx != null && !node) {
    const edge = graph.edges[state.ui.selectedEdgeIdx];
    if (!edge) return <div style={inspectorShell(t)}/>;
    return (
      <div style={inspectorShell(t)}>
        <div style={inspectorHeader(t)}>
          <Icon name="link" size={12} color={t.accent}/>
          <span style={{ color: t.text, fontSize: 12, fontWeight: 600 }}>Connection</span>
        </div>
        <div className="mg-scroll" style={{ flex: 1, overflow: 'auto' }}>
          <div style={{ padding: '14px' }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: t.textMid, lineHeight: 1.6 }}>
              {edge.from.node}.{edge.from.port} → {edge.to.node}.{edge.to.port}
            </div>
            <Btn size="sm" theme="dark" leftIcon="close" style={{ marginTop: 12 }}
              onClick={() => {
                dispatch({ type: 'PATCH_GRAPH', fn: g => ({ ...g, edges: g.edges.filter((_, i) => i !== state.ui.selectedEdgeIdx) }) });
                dispatch({ type: 'UI_PATCH', patch: { selectedEdgeIdx: null } });
              }}
            >Delete connection</Btn>
          </div>
        </div>
      </div>
    );
  }

  if (!node) {
    // Empty inspector — graph stats + health
    return (
      <div style={inspectorShell(t)}>
        <div style={inspectorHeader(t)}>
          <Icon name="layers" size={12} color={t.accent}/>
          <span style={{ color: t.text, fontSize: 12, fontWeight: 600 }}>Graph</span>
        </div>
        <div className="mg-scroll" style={{ flex: 1, overflow: 'auto' }}>
          <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
            <Stat t={t} k="nodes" v={`${graph.nodes.length}`} sub={`${graph.edges.length} edges`}/>
            <div style={{ height: 8 }}/>
            <Stat t={t} k="last run" v={Object.keys(project.runResults).length > 0
              ? `${Object.values(project.runResults).filter(r => r.state === 'done').length} done`
              : 'never'}/>
          </div>
          <ProjectSaveDirectory t={t} project={project} dispatch={dispatch}/>
          <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
            <SectionLabel t={t}>Quick actions</SectionLabel>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{
                padding: '6px 10px', background: t.panel, border: `1px solid ${t.border}`, borderRadius: 5,
                color: t.textMid, fontFamily: FONT_MONO, fontSize: 10.5, lineHeight: 1.55,
              }}>
                Run from <span style={{ color: t.accent }}>top-right</span>.<br/>
                Right-click a node for per-node actions.
              </div>
              <Btn size="sm" leftIcon="history" theme="dark" style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => dispatch({ type: 'CLEAR_RUN_RESULTS' })}>Clear run results</Btn>
            </div>
          </div>
          <div style={{ padding: '12px 14px' }}>
            <SectionLabel t={t}>Provider status</SectionLabel>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {Object.entries(PROVIDER_LABEL).map(([k, label]) => {
                const set = !!state.config.apiKeys[k];
                return (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT_MONO, fontSize: 10.5 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: set ? t.green : t.textMute }}/>
                    <span style={{ color: t.text, flex: 1 }}>{label}</span>
                    <span style={{ color: t.textMute }}>{set ? 'key set' : 'no key'}</span>
                  </div>
                );
              })}
              <div style={{ height: 4 }}/>
              <SectionLabel t={t}>Local binaries</SectionLabel>
              {Object.entries(state.config.binPaths).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT_MONO, fontSize: 10.5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.green }}/>
                  <span style={{ color: t.text, flex: 1 }}>{k}</span>
                  <span style={{ color: t.textMute, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Node selected
  const isCli = node.kind === 'cli';
  const isGen = node.kind === 'gen';
  const isMotion = node.kind === 'motion';
  const isApi = isGen || isMotion;
  const isPixVerse = isPixVerseCli(node);
  const onPatch = (patch) => dispatch({ type: 'PATCH_GRAPH', fn: g => ({
    ...g, nodes: g.nodes.map(n => n.id === node.id ? { ...n, ...patch } : n),
  })});
  const patchRuntime = (patch) => onPatch(runtimePatchFor(node, patch, graph));
  const setProvider = (provider) => patchRuntime({
    provider,
    model: defaultModelForProvider(node, provider),
  });
  const setModel = (model) => patchRuntime({ model });

  // For output nodes: compute ProjectName_01.ext preview name used in both
  // the inspector header and the "Output file" section below.
  let outputPreviewName = null;
  if (node.kind === 'output') {
    const outputResult = result;
    const thumb = outputResult?.thumbs?.find(t => thumbSavePath(t)) || outputResult?.thumbs?.[0];
    let upstreamPath = thumbSavePath(thumb) || null;
    if (!upstreamPath) {
      const upEdges = graph.edges.filter(e => e.to.node === node.id && !e.dashed);
      for (const e of upEdges) {
        const upResult = project.runResults[e.from.node];
        const upThumb = upResult?.thumbs?.find(tt => thumbSavePath(tt)) || upResult?.thumbs?.[0];
        const path = thumbSavePath(upThumb);
        if (path) { upstreamPath = path; break; }
      }
    }
    if (upstreamPath) {
      const srcExt = (upstreamPath.split('.').pop() || 'mp4').toLowerCase();
      const safeName = (project.name || 'Output')
        .trim()
        .replace(/[^a-zA-Z0-9 \-]/g, '_')
        .trim()
        .split(/\s+/).join('_');
      outputPreviewName = `${safeName}_01.${srcExt}`;
    }
  }

  return (
    <div style={inspectorShell(t)}>
      <div style={inspectorHeader(t)}>
        <div style={{
          width: 6, height: 6, borderRadius: 2,
          background: isCli ? t.amber : node.kind === 'output' ? t.green : t.accent,
        }}/>
        <input
          value={outputPreviewName ?? node.title}
          onChange={(e) => { if (!outputPreviewName) onPatch({ title: e.target.value }); }}
          readOnly={!!outputPreviewName}
          spellCheck={false}
          style={{
            background: 'transparent', color: t.text, fontSize: 12, fontWeight: 600,
            border: 'none', outline: 'none', padding: 0, flex: 1,
            fontFamily: FONT_UI,
            cursor: outputPreviewName ? 'default' : 'text',
          }}
        />
        <Pill bg={isCli ? t.amberBg : isApi ? t.accentBg : t.panel}
          color={isCli ? t.amber : isApi ? t.accent : t.textMute}
          border={isCli ? t.amberBg : isApi ? t.accentBorder : t.border}>
          {(node.badge || node.kind).toUpperCase()}
        </Pill>
      </div>

      <div className="mg-scroll" style={{ flex: 1, overflow: 'auto' }}>
        {/* Run result preview */}
        {result && (
          <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
            <SectionLabel t={t}>Last run</SectionLabel>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%',
                background: result.state === 'done' ? t.green : result.state === 'error' ? t.red : t.textMute }}/>
              <span style={{ color: t.text, fontFamily: FONT_MONO, fontSize: 11 }}>{result.state}</span>
              {result.error && (
                <span style={{ color: t.red, fontFamily: FONT_MONO, fontSize: 10.5, marginLeft: 'auto' }}>{result.error}</span>
              )}
            </div>
          </div>
        )}

        {isCli && isPixVerse && (
          <PixVerseSettings t={t} node={node} graph={graph} onPatch={onPatch} dispatch={dispatch}/>
        )}

        {isCli && !isPixVerse && (
          <>
            <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
              <SectionLabel t={t}>Binary path</SectionLabel>
              <input
                value={(node.cli && node.cli.bin) || ''}
                onChange={(e) => onPatch({ cli: { ...node.cli, bin: e.target.value } })}
                spellCheck={false}
                placeholder="~/bin/your-binary"
                style={inputStyle(t)}
              />
              <div style={{ marginTop: 6, color: t.textMute, fontFamily: FONT_MONO, fontSize: 10 }}>
                shared paths editable in <span style={{ color: t.accent, cursor: 'pointer' }}
                  onClick={() => dispatch({ type: 'UI_PATCH', patch: { configOpen: true } })}>Config →</span>
              </div>
            </div>
            <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
              <SectionLabel t={t}>Args (edit inline on node)</SectionLabel>
              <div style={{
                marginTop: 6, padding: '8px 10px',
                background: t.panel, border: `1px solid ${t.border}`, borderRadius: 4,
                color: t.text, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.55,
              }}>
                <div><span style={{ color: t.green }}>$</span> {node.cli?.cmd}</div>
                {(node.cli?.args || []).map((a, i) => (
                  <div key={i} style={{ paddingLeft: 10, color: t.textMid }}>{a}</div>
                ))}
              </div>
              <div style={{ marginTop: 8, color: t.textMute, fontFamily: FONT_MONO, fontSize: 10, lineHeight: 1.5 }}>
                {'{in}'} → upstream output path<br/>
                {'{out}'} → autogenerated output dir<br/>
                {'{prev.out}'} → result of left-port input
              </div>
            </div>
          </>
        )}

        {isApi && (
          <>
            <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
              <SectionLabel t={t}>Provider</SectionLabel>
              <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                <select
                  value={node.provider || ''}
                  onChange={(e) => setProvider(e.target.value)}
                  style={selectStyle(t)}
                >
                  {Object.entries(PROVIDER_LABEL).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
                <input
                  value={node.model || ''}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="model-id"
                  spellCheck={false}
                  style={inputStyle(t)}
                />
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {modelPresetsFor(node).map(m => (
                  <div key={m} onClick={() => setModel(m)} style={{
                    padding: '4px 7px',
                    background: node.model === m ? t.accentBg : t.panel,
                    border: `1px solid ${node.model === m ? t.accentBorder : t.border}`,
                    color: node.model === m ? t.accent : t.textMid,
                    borderRadius: 4,
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    cursor: 'pointer',
                  }}>{m}</div>
                ))}
              </div>
              <div style={{ marginTop: 8, color: t.textMute, fontFamily: FONT_MONO, fontSize: 10 }}>
                {node.provider === 'local' ? <><span style={{ color: t.green }}>●</span> local runner</> :
                  state.config.apiKeys[node.provider] ? <><span style={{ color: t.green }}>●</span> key set</> :
                  <><span style={{ color: t.red }}>●</span> no api key — <span style={{ color: t.accent, cursor: 'pointer' }} onClick={() => dispatch({ type: 'UI_PATCH', patch: { configOpen: true } })}>set in Config</span></>}
              </div>
            </div>
            {isGen && node.provider === 'pixverse' && (
              <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
                <SectionLabel t={t}>PixVerse image params</SectionLabel>
                <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <KV t={t} k="quality" v={node.quality || '1080p'} onChange={(v) => patchRuntime({ quality: v })}/>
                  <KV t={t} k="ratio" v={node.aspectRatio || '16:9'} onChange={(v) => patchRuntime({ aspectRatio: v })}/>
                  <NumberKV t={t} k="count" v={node.count || 1} min={1} onCommit={(v) => patchRuntime({ count: v })}/>
                  <KV t={t} k="seed" v={node.seed === 'auto' ? '' : (node.seed || '')} onChange={(v) => patchRuntime({ seed: v || 'auto' })}/>
                  <KV t={t} k="detail" v={node.detailLevel || ''} onChange={(v) => onPatch({ detailLevel: v })}/>
                  <KV t={t} k="timeout" v={node.timeout || 300} onChange={(v) => onPatch({ timeout: Number(v) || 300 })}/>
                  <KV t={t} k="idempotency" v={node.idempotencyKey || ''} onChange={(v) => onPatch({ idempotencyKey: v })}/>
                </div>
                <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
                  <ToggleChip t={t} active={!!node.noWait} onClick={() => onPatch({ noWait: !node.noWait })}>no-wait</ToggleChip>
                </div>
              </div>
            )}
            {isGen && node.provider !== 'pixverse' && (
              <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
                <SectionLabel t={t}>Params</SectionLabel>
                <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <NumberKV t={t} k="count" v={node.count || 4} min={1} onCommit={(v) => patchRuntime({ count: v })}/>
                  <NumberKV t={t} k="steps" v={node.steps || 28} min={1} onCommit={(v) => patchRuntime({ steps: v })}/>
                  <KV t={t} k="seed" v={node.seed || 'auto'} onChange={(v) => patchRuntime({ seed: v })}/>
                  <KV t={t} k="size" v={node.size || '1024²'} onChange={(v) => onPatch({ size: v })}/>
                </div>
              </div>
            )}
            {isMotion && (
              <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
                <SectionLabel t={t}>Motion</SectionLabel>
                <textarea
                  value={node.motionPrompt || ''}
                  onChange={(e) => onPatch({ motionPrompt: e.target.value })}
                  placeholder="describe motion"
                  spellCheck={false}
                  rows={2}
                  style={{ ...inputStyle(t), resize: 'vertical', fontFamily: FONT_MONO }}
                />
                <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
                  {[3, 5, 8, 10].map(d => (
                    <div key={d} onClick={() => patchRuntime({ duration: d })} style={{
                      flex: 1, textAlign: 'center', padding: '5px 0',
                      background: node.duration === d ? t.accentBg : t.panel,
                      border: `1px solid ${node.duration === d ? t.accentBorder : t.border}`,
                      color: node.duration === d ? t.accent : t.text,
                      borderRadius: 4, fontFamily: FONT_MONO, fontSize: 11, cursor: 'pointer',
                    }}>{d}s</div>
                  ))}
                </div>
                {node.provider === 'pixverse' && (
                  <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <KV t={t} k="quality" v={node.quality || '720p'} onChange={(v) => patchRuntime({ quality: v })}/>
                    <KV t={t} k="ratio" v={node.aspectRatio || '16:9'} onChange={(v) => patchRuntime({ aspectRatio: v })}/>
                    <NumberKV t={t} k="count" v={node.count || 1} min={1} onCommit={(v) => patchRuntime({ count: v })}/>
                    <KV t={t} k="seed" v={node.seed === 'auto' ? '' : (node.seed || '')} onChange={(v) => onPatch({ seed: v || 'auto' })}/>
                    <KV t={t} k="timeout" v={node.timeout || 600} onChange={(v) => onPatch({ timeout: Number(v) || 600 })}/>
                    <KV t={t} k="idempotency" v={node.idempotencyKey || ''} onChange={(v) => onPatch({ idempotencyKey: v })}/>
                  </div>
                )}
                {node.provider === 'pixverse' && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <ToggleChip t={t} active={!!node.audio} onClick={() => onPatch({ audio: !node.audio, noAudio: false })}>audio</ToggleChip>
                    <ToggleChip t={t} active={!!node.noAudio} onClick={() => onPatch({ noAudio: !node.noAudio, audio: false })}>no-audio</ToggleChip>
                    <ToggleChip t={t} active={!!node.multiShot} onClick={() => onPatch({ multiShot: !node.multiShot, noMultiShot: false })}>multi-shot</ToggleChip>
                    <ToggleChip t={t} active={!!node.noMultiShot} onClick={() => onPatch({ noMultiShot: !node.noMultiShot, multiShot: false })}>no-multi</ToggleChip>
                    <ToggleChip t={t} active={!!node.offPeak} onClick={() => onPatch({ offPeak: !node.offPeak })}>off-peak</ToggleChip>
                    <ToggleChip t={t} active={!!node.noWait} onClick={() => onPatch({ noWait: !node.noWait })}>no-wait</ToggleChip>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {node.kind === 'output' && <ProjectSaveDirectory t={t} project={project} dispatch={dispatch}/>}

        {/* ── Output node: download result to local folder ───────────────── */}
        {node.kind === 'output' && (() => {
          if (!outputPreviewName) return null;
          // Resolve upstream path for the actual save operation (same logic as above).
          const outputResult = result;
          const thumb = outputResult?.thumbs?.find(t => thumbSavePath(t)) || outputResult?.thumbs?.[0];
          let upstreamPath = thumbSavePath(thumb) || null;
          if (!upstreamPath) {
            const upEdges = graph.edges.filter(e => e.to.node === node.id && !e.dashed);
            for (const e of upEdges) {
              const upResult = project.runResults[e.from.node];
              const upThumb = upResult?.thumbs?.find(tt => thumbSavePath(tt)) || upResult?.thumbs?.[0];
              const path = thumbSavePath(upThumb);
              if (path) { upstreamPath = path; break; }
            }
          }
          if (!upstreamPath) return null;
          const outputDir = project.outputDir || '';
          return (
            <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
              <SectionLabel t={t}>Output file</SectionLabel>
              <div style={{
                marginTop: 6, padding: '6px 8px',
                background: t.panel, border: `1px solid ${t.border}`, borderRadius: 4,
                fontFamily: FONT_MONO, fontSize: 10, color: t.textMid,
                wordBreak: 'break-all', lineHeight: 1.5,
              }}>
                {outputPreviewName}
              </div>
              {outputDir && (
                <div style={{
                  marginTop: 6,
                  color: t.textMute,
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  save root: {outputDir}
                </div>
              )}
              <Btn
                size="sm"
                leftIcon="download"
                theme="dark"
                style={{ marginTop: 8, width: '100%', justifyContent: 'center' }}
                onClick={async () => {
                  if (typeof window.AtlasDownloadOutputFile === 'function') {
                    try {
                      const dest = await window.AtlasDownloadOutputFile(upstreamPath, project.name, outputDir);
                      if (dest) alert(`Saved to:\n${dest}`);
                    } catch (e) {
                      alert('Save failed: ' + String(e));
                    }
                  } else {
                    alert('Save to local is only available in the desktop app or localhost helper.');
                  }
                }}
              >
                Save to folder…
              </Btn>
            </div>
          );
        })()}

        {/* ── Collect to Library — output and select/pick nodes ────────────── */}
        {(node.kind === 'output' || node.kind === 'select') && (() => {
          const thumbs = (result?.thumbs || node.thumbs || []).filter(th => mediaSrc(th));
          if (!thumbs.length) return null;
          const lib = state.library || [];
          return (
            <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
              <SectionLabel t={t}>Collect to Library</SectionLabel>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {thumbs.map((thumb, i) => {
                  const itemId = `${project.id}:${node.id}:${i}`;
                  const inLib = lib.some(x => x.id === itemId);
                  const s = mediaSrc(thumb);
                  const isVid = isVideoThumb(thumb, s);
                  const toggle = () => {
                    if (inLib) {
                      dispatch({ type: 'LIBRARY_REMOVE', id: itemId });
                    } else {
                      dispatch({ type: 'LIBRARY_ADD', item: {
                        id: itemId,
                        projId: project.id,
                        projName: project.name,
                        projColor: project.color || '#7fc8ff',
                        nodeId: node.id,
                        thumb,
                        collectedAt: Date.now(),
                      }});
                    }
                  };
                  return (
                    <div key={i}>
                      <MediaThumb t={t} thumb={thumb} h={56}
                        fallbackLabel={isVid ? 'video' : 'image'}
                        previewable={true}
                        selected={inLib}
                      />
                      <button
                        onClick={toggle}
                        title={inLib ? 'Remove from Library' : 'Add to Library'}
                        style={{
                          marginTop: 4,
                          width: '100%',
                          padding: '5px 0',
                          borderRadius: 4,
                          border: `1px solid ${inLib ? t.accentBorder : t.border}`,
                          background: inLib ? t.accentBg : t.panel2,
                          color: inLib ? t.accent : t.textMid,
                          fontFamily: FONT_MONO, fontSize: 10,
                          cursor: 'pointer',
                          userSelect: 'none',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                        }}
                      >
                        <Icon name={inLib ? 'check' : 'plus'} size={9} color={inLib ? t.accent : t.textMid}/>
                        {inLib ? 'Saved to Library' : 'Add to Library'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* ── Asset node: show current thumb + Library source picker ──────── */}
        {node.kind === 'asset' && (() => {
          const currentThumb = (node.thumbs || [])[0];
          const lib = state.library || [];
          return (
            <>
              {/* Current thumbnail */}
              {currentThumb && mediaSrc(currentThumb) && (
                <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
                  <SectionLabel t={t}>Current source</SectionLabel>
                  <div style={{ marginTop: 8 }}>
                    <LibraryThumb t={t} thumb={currentThumb} h={80}/>
                    {currentThumb.label && (
                      <div style={{ marginTop: 4, fontFamily: FONT_MONO, fontSize: 10, color: t.textMute,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {currentThumb.label}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Local file picker */}
              {typeof window.AtlasChooseLocalFile === 'function' && (
                <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
                  <SectionLabel t={t}>Local file</SectionLabel>
                  <div style={{ marginTop: 8 }}>
                    <Btn size="sm" theme="dark" leftIcon="folder" onClick={async () => {
                      try {
                        const file = await window.AtlasChooseLocalFile();
                        if (!file) return;
                        const thumb = { ...file, chosen: true };
                        onPatch({
                          thumbs: [thumb],
                          ports: [{ kind: file.type === 'video' ? 'video' : 'image', side: 'right', top: 36 }],
                          title: file.label || node.title,
                          footer: { left: file.path, right: 'ready' },
                        });
                      } catch (_) {}
                    }}>Choose from disk…</Btn>
                  </div>
                  {currentThumb?.path && !/^(https?:|data:|blob:)/i.test(currentThumb.path) && (
                    <div style={{
                      marginTop: 5, fontFamily: FONT_MONO, fontSize: 9, color: t.textMute,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={currentThumb.path}>
                      {currentThumb.path}
                    </div>
                  )}
                </div>
              )}

              {/* Library source picker */}
              {lib.length > 0 && (
                <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
                  <SectionLabel t={t}>Pick from Library</SectionLabel>
                  <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 5 }}>
                    {lib.map((item) => {
                      const s = mediaSrc(item.thumb);
                      const isVid = isVideoThumb(item.thumb, s);
                      const isCurrent = currentThumb && (
                        mediaSrc(currentThumb) === s ||
                        (currentThumb.seed && currentThumb.seed === item.thumb?.seed)
                      );
                      return (
                        <div key={item.id}
                          onClick={() => {
                            onPatch({
                              thumbs: [{ ...item.thumb, chosen: true }],
                              ports: [{ kind: isVid ? 'video' : 'image', side: 'right', top: 36 }],
                              title: item.thumb?.label || node.title,
                              footer: { left: `from ${item.projName}`, right: 'ready' },
                            });
                          }}
                          title={`Use: ${item.thumb?.label || 'media'} · from ${item.projName}`}
                          style={{
                            position: 'relative', cursor: 'pointer',
                            outline: isCurrent ? `2px solid ${t.accent}` : 'none',
                            borderRadius: 4, overflow: 'hidden',
                          }}
                        >
                          <LibraryThumb t={t} thumb={item.thumb} h={52}/>
                          {isCurrent && (
                            <div style={{
                              position: 'absolute', top: 2, left: 2, zIndex: 2,
                              background: t.accentBg, border: `1px solid ${t.accentBorder}`,
                              borderRadius: 2, padding: '1px 4px',
                              fontFamily: FONT_MONO, fontSize: 8, color: t.accent,
                            }}>✓</div>
                          )}
                          <div style={{
                            marginTop: 2, fontFamily: FONT_MONO, fontSize: 8.5, color: t.textMute,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            paddingLeft: 1,
                          }}>
                            {item.projName}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          );
        })()}

        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
          <SectionLabel t={t}>Ports</SectionLabel>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(node.ports || []).map((p, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontFamily: FONT_MONO, fontSize: 10.5,
              }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: PORT_COLORS[p.kind] }}/>
                <span style={{ color: t.textMid, flex: 1 }}>{p.label || p.kind}</span>
                <span style={{ color: t.textMute }}>{p.side === 'left' ? 'in' : 'out'} · {PORT_LABEL[p.kind]}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Btn size="sm" leftIcon="vary" theme="dark" style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => {
              const newId = makeNodeId(graph, node.kind.slice(0,3));
              const copy = JSON.parse(JSON.stringify(node));
              copy.id = newId; copy.x = node.x + 24; copy.y = node.y + 24;
              dispatch({ type: 'PATCH_GRAPH', fn: g => ({ ...g, nodes: [...g.nodes, copy] }) });
              dispatch({ type: 'UI_PATCH', patch: { selectedNodeId: newId } });
            }}
          >
            Duplicate
          </Btn>
          <Btn size="sm" leftIcon="close" theme="dark" style={{ width: '100%', justifyContent: 'center', color: t.red }}
            onClick={() => {
              dispatch({ type: 'PATCH_GRAPH', fn: g => ({
                ...g,
                nodes: g.nodes.filter(n => n.id !== node.id),
                edges: g.edges.filter(e => e.from.node !== node.id && e.to.node !== node.id),
              })});
              dispatch({ type: 'UI_PATCH', patch: { selectedNodeId: null } });
            }}>
            Delete node
          </Btn>
        </div>
      </div>
    </div>
  );
}

function inspectorShell(t) {
  return {
    // flex: 1 fills the flex-column wrapper in editor-app; minHeight:0 prevents
    // the flex child from overriding the bounded height so overflow:auto works.
    width: 288, flex: 1, minHeight: 0,
    background: t.bg2, borderLeft: `1px solid ${t.border}`,
    display: 'flex', flexDirection: 'column',
    fontFamily: FONT_UI,
    overflow: 'hidden',
  };
}
function inspectorHeader(t) {
  return {
    padding: '10px 14px', borderBottom: `1px solid ${t.border}`,
    display: 'flex', alignItems: 'center', gap: 8,
  };
}
function inputStyle(t) {
  return {
    boxSizing: 'border-box', width: '100%',
    background: t.panel, border: `1px solid ${t.border}`,
    color: t.text, fontFamily: FONT_MONO, fontSize: 11,
    padding: '6px 8px', borderRadius: 4, outline: 'none',
  };
}
function selectStyle(t) {
  return {
    ...inputStyle(t),
    width: 'auto', flex: '0 0 120px',
  };
}
function KV({ t, k, v, onChange }) {
  return (
    <div>
      <div style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5, letterSpacing: 0.5, textTransform: 'uppercase' }}>{k}</div>
      <input
        value={v}
        onChange={(e) => onChange && onChange(e.target.value)}
        spellCheck={false}
        style={{ ...inputStyle(t), marginTop: 2 }}
      />
    </div>
  );
}

function NumberKV({ t, k, v, onCommit, min = 0, max }) {
  const [draft, setDraft] = React.useState(String(v ?? ''));
  React.useEffect(() => {
    setDraft(String(v ?? ''));
  }, [v]);

  const normalize = (raw) => {
    if (raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const floored = Math.floor(n);
    return Math.min(max ?? floored, Math.max(min, floored));
  };

  const commit = (raw, normalizeDraft = true) => {
    const next = normalize(String(raw).trim());
    if (next == null) {
      if (normalizeDraft) setDraft(String(v ?? ''));
      return;
    }
    onCommit && onCommit(next);
    if (normalizeDraft) setDraft(String(next));
  };

  return (
    <div>
      <div style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5, letterSpacing: 0.5, textTransform: 'uppercase' }}>{k}</div>
      <input
        value={draft}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          if (raw.trim() !== '') commit(raw, false);
        }}
        onBlur={() => commit(draft, true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          }
        }}
        type="number"
        min={min}
        max={max}
        step="1"
        spellCheck={false}
        style={{ ...inputStyle(t), marginTop: 2 }}
      />
    </div>
  );
}

// Chip-row selector for a fixed set of values (quality, ratio, duration…)
function ChipSelect({ t, value, options, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
      {options.map(opt => {
        const active = String(value) === String(opt);
        return (
          <div key={opt} onClick={() => onChange(String(opt))} style={{
            padding: '4px 8px',
            background: active ? t.accentBg : t.panel,
            border: `1px solid ${active ? t.accentBorder : t.border}`,
            color: active ? t.accent : t.textMid,
            borderRadius: 4,
            fontFamily: FONT_MONO,
            fontSize: 10,
            cursor: 'pointer',
            userSelect: 'none',
          }}>{opt}</div>
        );
      })}
    </div>
  );
}

function ToggleChip({ t, active, children, onClick }) {
  return (
    <div onClick={onClick} style={{
      flex: 1,
      minWidth: 68,
      boxSizing: 'border-box',
      textAlign: 'center',
      padding: '5px 0',
      background: active ? t.accentBg : t.panel,
      border: `1px solid ${active ? t.accentBorder : t.border}`,
      color: active ? t.accent : t.text,
      borderRadius: 4,
      fontFamily: FONT_MONO,
      fontSize: 11,
      cursor: 'pointer',
      userSelect: 'none',
    }}>{children}</div>
  );
}

function PixVerseSupportMatrix({ t, mode }) {
  const spec = pixVerseSpecFor(mode);
  return (
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Supported modes</SectionLabel>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {spec.modes.map(item => (
          <div key={item.id} style={{
            padding: '7px 8px',
            background: t.panel,
            border: `1px solid ${t.border}`,
            borderRadius: 4,
            fontFamily: FONT_MONO,
            fontSize: 10.5,
            lineHeight: 1.45,
          }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ color: t.accent, fontWeight: 700 }}>{item.id}</span>
              <span style={{ color: t.text }}>{item.label}</span>
            </div>
            <div style={{ marginTop: 3, color: t.textMute }}>
              required: {item.required.join(', ')}
            </div>
          </div>
        ))}
      </div>
      <div style={{
        marginTop: 8,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
      }}>
        {spec.params.map(param => (
          <span key={param} style={{
            padding: '3px 5px',
            background: t.bg,
            border: `1px solid ${t.border}`,
            borderRadius: 4,
            color: t.textMid,
            fontFamily: FONT_MONO,
            fontSize: 9.5,
          }}>{param}</span>
        ))}
      </div>
    </div>
  );
}

// ── Shared sub-components for PixVerse inspector panels ──────────────────────

function PVCommandHeader({ t, node, sub, onPatch, dispatch }) {
  return (
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Command</SectionLabel>
      <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          value={(node.cli && node.cli.bin) || 'pixverse'}
          onChange={(e) => onPatch({ cli: { ...node.cli, bin: e.target.value } })}
          spellCheck={false}
          style={{ ...inputStyle(t), flex: 1 }}
        />
        <Btn size="sm" theme="dark" leftIcon="settings"
          onClick={() => dispatch({ type: 'UI_PATCH', patch: { configOpen: true } })}>Config</Btn>
      </div>
      <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
        <span style={{
          padding: '3px 7px', background: t.amberBg, border: `1px solid ${t.amber}44`,
          borderRadius: 4, color: t.amber, fontFamily: FONT_MONO, fontSize: 9.5,
        }}>{sub}</span>
        <span style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 10, alignSelf: 'center' }}>
          pixverse CLI
        </span>
      </div>
    </div>
  );
}

function PVModelSelect({ t, args, models, defaultModel, onChange }) {
  const model = cliArg(args, '--model', defaultModel || models[0] || '');
  if (!models.length) return null;
  return (
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Model</SectionLabel>
      <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {models.map(m => (
          <div key={m} onClick={() => onChange(m)} style={{
            padding: '5px 9px',
            background: model === m ? t.accentBg : t.panel,
            border: `1px solid ${model === m ? t.accentBorder : t.border}`,
            color: model === m ? t.accent : t.textMid,
            borderRadius: 4, fontFamily: FONT_MONO, fontSize: 10, cursor: 'pointer',
          }}>{m}</div>
        ))}
      </div>
    </div>
  );
}

function PVQualityRatio({ t, args, setArg }) {
  const quality = cliArg(args, '--quality', '720p');
  const ratio = cliArg(args, '--aspect-ratio', '16:9');
  const QUALITY_OPTS = ['360p', '540p', '720p', '1080p'];
  const RATIO_OPTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
  return (<>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Quality</SectionLabel>
      <ChipSelect t={t} value={quality} options={QUALITY_OPTS} onChange={(v) => setArg('--quality', v)}/>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Aspect ratio</SectionLabel>
      <ChipSelect t={t} value={ratio} options={RATIO_OPTS} onChange={(v) => setArg('--aspect-ratio', v)}/>
    </div>
  </>);
}

function PVCliPreview({ t, node, args }) {
  return (
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Resolved command</SectionLabel>
      <div style={{
        marginTop: 6, padding: '8px 10px',
        background: t.panel, border: `1px solid ${t.border}`, borderRadius: 4,
        color: t.text, fontFamily: FONT_MONO, fontSize: 10, lineHeight: 1.55,
        wordBreak: 'break-word',
      }}>
        <div><span style={{ color: t.green }}>$</span> {node.cli?.cmd || 'pixverse'}</div>
        {args.map((a, i) => (
          <div key={i} style={{ paddingLeft: 10, color: t.textMid }}>{a}</div>
        ))}
      </div>
    </div>
  );
}

// ── Sub-panels for each PixVerse subcommand ───────────────────────────────────

function PVImagePanel({ t, node, args, sub, spec, setArg, setToggle, setExclusiveToggle, onPatch, dispatch, graph, patchArgs }) {
  const model = cliArg(args, '--model', 'qwen-image');
  const quality = cliArg(args, '--quality', '1080p');
  const ratio = cliArg(args, '--aspect-ratio', '16:9');
  const QUALITY_OPTS = ['360p', '540p', '720p', '1080p'];
  const RATIO_OPTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
  return (<>
    <PVCommandHeader t={t} node={node} sub="image" onPatch={onPatch} dispatch={dispatch}/>
    <PVModelSelect t={t} args={args} models={spec.models} defaultModel="qwen-image" onChange={(m) => setArg('--model', m)}/>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Quality</SectionLabel>
      <ChipSelect t={t} value={quality} options={QUALITY_OPTS} onChange={(v) => setArg('--quality', v)}/>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Aspect ratio</SectionLabel>
      <ChipSelect t={t} value={ratio} options={RATIO_OPTS} onChange={(v) => setArg('--aspect-ratio', v)}/>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Generation</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <NumberKV t={t} k="count" v={cliArg(args, '--count', '1')} min={1} onCommit={(v) => setArg('--count', v)}/>
        <KV t={t} k="seed" v={cliArg(args, '--seed', '')} onChange={(v) => setArg('--seed', v)}/>
        <KV t={t} k="detail" v={cliArg(args, '--detail-level', '')} onChange={(v) => setArg('--detail-level', v)}/>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Flags</SectionLabel>
      <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <ToggleChip t={t} active={hasCliFlag(args, '--no-wait')} onClick={() => setToggle('--no-wait', !hasCliFlag(args, '--no-wait'))}>no-wait</ToggleChip>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Advanced</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <KV t={t} k="timeout" v={cliArg(args, '--timeout', '300')} onChange={(v) => setArg('--timeout', v)}/>
        <KV t={t} k="idempotency" v={cliArg(args, '--idempotency-key', '')} onChange={(v) => setArg('--idempotency-key', v)}/>
      </div>
    </div>
    <PVCliPreview t={t} node={node} args={args}/>
  </>);
}

function PVVideoPanel({ t, node, args, sub, spec, setArg, setToggle, setExclusiveToggle, onPatch, dispatch }) {
  const quality = cliArg(args, '--quality', '720p');
  const ratio = cliArg(args, '--aspect-ratio', '16:9');
  const QUALITY_OPTS = ['360p', '540p', '720p', '1080p'];
  const RATIO_OPTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
  const DURATION_OPTS = ['3', '5', '8', '10'];
  return (<>
    <PVCommandHeader t={t} node={node} sub="video" onPatch={onPatch} dispatch={dispatch}/>
    <PVModelSelect t={t} args={args} models={spec.models} defaultModel="v6" onChange={(m) => setArg('--model', m)}/>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Quality</SectionLabel>
      <ChipSelect t={t} value={quality} options={QUALITY_OPTS} onChange={(v) => setArg('--quality', v)}/>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Aspect ratio</SectionLabel>
      <ChipSelect t={t} value={ratio} options={RATIO_OPTS} onChange={(v) => setArg('--aspect-ratio', v)}/>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Duration</SectionLabel>
      <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
        {DURATION_OPTS.map(d => {
          const cur = cliArg(args, '--duration', '5');
          const active = String(cur) === String(d);
          return (
            <div key={d} onClick={() => setArg('--duration', d)} style={{
              flex: 1, textAlign: 'center', padding: '5px 0',
              background: active ? t.accentBg : t.panel,
              border: `1px solid ${active ? t.accentBorder : t.border}`,
              color: active ? t.accent : t.text,
              borderRadius: 4, fontFamily: FONT_MONO, fontSize: 11, cursor: 'pointer',
            }}>{d}s</div>
          );
        })}
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Generation</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <NumberKV t={t} k="count" v={cliArg(args, '--count', '1')} min={1} onCommit={(v) => setArg('--count', v)}/>
        <KV t={t} k="seed" v={cliArg(args, '--seed', '')} onChange={(v) => setArg('--seed', v)}/>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Flags</SectionLabel>
      <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <ToggleChip t={t} active={hasCliFlag(args, '--audio')} onClick={() => setExclusiveToggle('--audio', '--no-audio')}>audio</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--no-audio')} onClick={() => setExclusiveToggle('--no-audio', '--audio')}>no-audio</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--multi-shot')} onClick={() => setExclusiveToggle('--multi-shot', '--no-multi-shot')}>multi-shot</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--no-multi-shot')} onClick={() => setExclusiveToggle('--no-multi-shot', '--multi-shot')}>no-multi</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--off-peak')} onClick={() => setToggle('--off-peak', !hasCliFlag(args, '--off-peak'))}>off-peak</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--no-wait')} onClick={() => setToggle('--no-wait', !hasCliFlag(args, '--no-wait'))}>no-wait</ToggleChip>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Advanced</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <KV t={t} k="timeout" v={cliArg(args, '--timeout', '600')} onChange={(v) => setArg('--timeout', v)}/>
        <KV t={t} k="idempotency" v={cliArg(args, '--idempotency-key', '')} onChange={(v) => setArg('--idempotency-key', v)}/>
      </div>
    </div>
    <PVCliPreview t={t} node={node} args={args}/>
  </>);
}

function PVTransitionPanel({ t, node, args, spec, setArg, setToggle, setExclusiveToggle, onPatch, dispatch }) {
  const quality = cliArg(args, '--quality', '720p');
  const QUALITY_OPTS = ['360p', '540p', '720p', '1080p'];
  const DURATION_OPTS = ['3', '5', '8', '10'];
  return (<>
    <PVCommandHeader t={t} node={node} sub="transition" onPatch={onPatch} dispatch={dispatch}/>
    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${t.border}` }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: t.textMute, lineHeight: 1.5 }}>
        <span style={{ color: t.text }}>from</span>（port 1）→ <span style={{ color: t.text }}>to</span>（port 2）：两帧之间生成过渡视频。<br/>
        展开为 <code style={{ color: t.text }}>--images from.jpg to.jpg</code>。<br/>
        Prompt 可用 <span style={{ color: t.accent }}>@image1</span> / <span style={{ color: t.accent }}>@image2</span> 引用两帧，引导过渡内容。
      </div>
    </div>
    <PVModelSelect t={t} args={args} models={spec.models} defaultModel="v6" onChange={(m) => setArg('--model', m)}/>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Quality</SectionLabel>
      <ChipSelect t={t} value={quality} options={QUALITY_OPTS} onChange={(v) => setArg('--quality', v)}/>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Duration</SectionLabel>
      <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
        {DURATION_OPTS.map(d => {
          const cur = cliArg(args, '--duration', '5');
          const active = String(cur) === String(d);
          return (
            <div key={d} onClick={() => setArg('--duration', d)} style={{
              flex: 1, textAlign: 'center', padding: '5px 0',
              background: active ? t.accentBg : t.panel,
              border: `1px solid ${active ? t.accentBorder : t.border}`,
              color: active ? t.accent : t.text,
              borderRadius: 4, fontFamily: FONT_MONO, fontSize: 11, cursor: 'pointer',
            }}>{d}s</div>
          );
        })}
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Generation</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <NumberKV t={t} k="count" v={cliArg(args, '--count', '1')} min={1} onCommit={(v) => setArg('--count', v)}/>
        <KV t={t} k="seed" v={cliArg(args, '--seed', '')} onChange={(v) => setArg('--seed', v)}/>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Flags</SectionLabel>
      <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <ToggleChip t={t} active={hasCliFlag(args, '--audio')} onClick={() => setExclusiveToggle('--audio', '--no-audio')}>audio</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--no-audio')} onClick={() => setExclusiveToggle('--no-audio', '--audio')}>no-audio</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--off-peak')} onClick={() => setToggle('--off-peak', !hasCliFlag(args, '--off-peak'))}>off-peak</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--no-wait')} onClick={() => setToggle('--no-wait', !hasCliFlag(args, '--no-wait'))}>no-wait</ToggleChip>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Advanced</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <KV t={t} k="timeout" v={cliArg(args, '--timeout', '600')} onChange={(v) => setArg('--timeout', v)}/>
        <KV t={t} k="idempotency" v={cliArg(args, '--idempotency-key', '')} onChange={(v) => setArg('--idempotency-key', v)}/>
      </div>
    </div>
    <PVCliPreview t={t} node={node} args={args}/>
  </>);
}

function PVReferencePanel({ t, node, args, spec, setArg, setToggle, setExclusiveToggle, onPatch, dispatch }) {
  const DURATION_OPTS = ['3', '5', '8', '10'];
  return (<>
    <PVCommandHeader t={t} node={node} sub="reference" onPatch={onPatch} dispatch={dispatch}/>
    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${t.border}` }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: t.textMute, lineHeight: 1.5 }}>
        接入最多 3 张角色图（img 1-3）+ 可选视频参考（vid ref，仅 seedance-2.0）+ Prompt。<br/>
        连接的图 / 视频按端口顺序展开为 <code style={{ color: t.text }}>--images p1 p2</code> / <code style={{ color: t.text }}>--videos v1</code>。<br/>
        Prompt 中可用 <span style={{ color: t.accent }}>@image1</span> <span style={{ color: t.accent }}>@image2</span> <span style={{ color: t.accent }}>@video1</span> 引用对应输入，例如：<br/>
        <span style={{ color: t.textMid }}>"@image1 follows the motion in @video1"</span>
      </div>
    </div>
    <PVModelSelect t={t} args={args} models={spec.models} defaultModel="v6" onChange={(m) => setArg('--model', m)}/>
    <PVQualityRatio t={t} args={args} setArg={setArg}/>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Duration</SectionLabel>
      <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
        {DURATION_OPTS.map(d => {
          const cur = cliArg(args, '--duration', '5');
          const active = String(cur) === String(d);
          return (
            <div key={d} onClick={() => setArg('--duration', d)} style={{
              flex: 1, textAlign: 'center', padding: '5px 0',
              background: active ? t.accentBg : t.panel,
              border: `1px solid ${active ? t.accentBorder : t.border}`,
              color: active ? t.accent : t.text,
              borderRadius: 4, fontFamily: FONT_MONO, fontSize: 11, cursor: 'pointer',
            }}>{d}s</div>
          );
        })}
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Generation</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <NumberKV t={t} k="count" v={cliArg(args, '--count', '1')} min={1} onCommit={(v) => setArg('--count', v)}/>
        <KV t={t} k="seed" v={cliArg(args, '--seed', '')} onChange={(v) => setArg('--seed', v)}/>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Flags</SectionLabel>
      <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <ToggleChip t={t} active={hasCliFlag(args, '--audio')} onClick={() => setExclusiveToggle('--audio', '--no-audio')}>audio</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--no-audio')} onClick={() => setExclusiveToggle('--no-audio', '--audio')}>no-audio</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--off-peak')} onClick={() => setToggle('--off-peak', !hasCliFlag(args, '--off-peak'))}>off-peak</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--no-wait')} onClick={() => setToggle('--no-wait', !hasCliFlag(args, '--no-wait'))}>no-wait</ToggleChip>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Advanced</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <KV t={t} k="timeout" v={cliArg(args, '--timeout', '600')} onChange={(v) => setArg('--timeout', v)}/>
        <KV t={t} k="idempotency" v={cliArg(args, '--idempotency-key', '')} onChange={(v) => setArg('--idempotency-key', v)}/>
      </div>
    </div>
    <PVCliPreview t={t} node={node} args={args}/>
  </>);
}

function PVMotionControlPanel({ t, node, args, spec, setArg, setToggle, onPatch, dispatch }) {
  const quality = cliArg(args, '--quality', '720p');
  // motion-control does NOT support --aspect-ratio or --duration
  const QUALITY_OPTS = ['360p', '540p', '720p', '1080p'];
  return (<>
    <PVCommandHeader t={t} node={node} sub="motion-control" onPatch={onPatch} dispatch={dispatch}/>
    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${t.border}` }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: t.textMute, lineHeight: 1.5 }}>
        <span style={{ color: t.text }}>char</span>（图像）+ <span style={{ color: t.text }}>motion</span>（参考视频）→ 人物按参考动作生成视频。<br/>
        模型固定为 <span style={{ color: t.accent }}>v5.6</span>，不支持 aspect-ratio / duration。
      </div>
    </div>
    <PVModelSelect t={t} args={args} models={spec.models} defaultModel="v5.6" onChange={(m) => setArg('--model', m)}/>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Quality</SectionLabel>
      <ChipSelect t={t} value={quality} options={QUALITY_OPTS} onChange={(v) => setArg('--quality', v)}/>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Generation</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <NumberKV t={t} k="count" v={cliArg(args, '--count', '1')} min={1} onCommit={(v) => setArg('--count', v)}/>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Flags</SectionLabel>
      <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <ToggleChip t={t} active={hasCliFlag(args, '--off-peak')} onClick={() => setToggle('--off-peak', !hasCliFlag(args, '--off-peak'))}>off-peak</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--no-wait')} onClick={() => setToggle('--no-wait', !hasCliFlag(args, '--no-wait'))}>no-wait</ToggleChip>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Advanced</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <KV t={t} k="timeout" v={cliArg(args, '--timeout', '600')} onChange={(v) => setArg('--timeout', v)}/>
        <KV t={t} k="idempotency" v={cliArg(args, '--idempotency-key', '')} onChange={(v) => setArg('--idempotency-key', v)}/>
      </div>
    </div>
    <PVCliPreview t={t} node={node} args={args}/>
  </>);
}

function PVExtendPanel({ t, node, args, spec, setArg, setToggle, setExclusiveToggle, onPatch, dispatch }) {
  const quality = cliArg(args, '--quality', '720p');
  const QUALITY_OPTS = ['360p', '540p', '720p', '1080p'];
  const DURATION_OPTS = ['3', '5', '8', '10'];
  return (<>
    <PVCommandHeader t={t} node={node} sub="extend" onPatch={onPatch} dispatch={dispatch}/>
    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${t.border}` }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: t.textMute, lineHeight: 1.5 }}>
        接入上游视频延长其时长。可选接 <span style={{ color: t.text }}>Prompt</span> 节点引导延长方向。<br/>
        视频云端 ID 自动从上游结果提取（<code>--video</code>）。
      </div>
    </div>
    <PVModelSelect t={t} args={args} models={spec.models} defaultModel="v6" onChange={(m) => setArg('--model', m)}/>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Quality</SectionLabel>
      <ChipSelect t={t} value={quality} options={QUALITY_OPTS} onChange={(v) => setArg('--quality', v)}/>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Duration (extension)</SectionLabel>
      <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
        {DURATION_OPTS.map(d => {
          const cur = cliArg(args, '--duration', '5');
          const active = String(cur) === String(d);
          return (
            <div key={d} onClick={() => setArg('--duration', d)} style={{
              flex: 1, textAlign: 'center', padding: '5px 0',
              background: active ? t.accentBg : t.panel,
              border: `1px solid ${active ? t.accentBorder : t.border}`,
              color: active ? t.accent : t.text,
              borderRadius: 4, fontFamily: FONT_MONO, fontSize: 11, cursor: 'pointer',
            }}>{d}s</div>
          );
        })}
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Generation</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <NumberKV t={t} k="count" v={cliArg(args, '--count', '1')} min={1} onCommit={(v) => setArg('--count', v)}/>
        <KV t={t} k="seed" v={cliArg(args, '--seed', '')} onChange={(v) => setArg('--seed', v)}/>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Flags</SectionLabel>
      <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <ToggleChip t={t} active={hasCliFlag(args, '--audio')} onClick={() => setExclusiveToggle('--audio', '--no-audio')}>audio</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--no-audio')} onClick={() => setExclusiveToggle('--no-audio', '--audio')}>no-audio</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--off-peak')} onClick={() => setToggle('--off-peak', !hasCliFlag(args, '--off-peak'))}>off-peak</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--no-wait')} onClick={() => setToggle('--no-wait', !hasCliFlag(args, '--no-wait'))}>no-wait</ToggleChip>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Advanced</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <KV t={t} k="timeout" v={cliArg(args, '--timeout', '600')} onChange={(v) => setArg('--timeout', v)}/>
        <KV t={t} k="idempotency" v={cliArg(args, '--idempotency-key', '')} onChange={(v) => setArg('--idempotency-key', v)}/>
      </div>
    </div>
    <PVCliPreview t={t} node={node} args={args}/>
  </>);
}

function PVUpscalePanel({ t, node, args, spec, setArg, onPatch, dispatch }) {
  const quality = cliArg(args, '--quality', '1080p');
  const QUALITY_OPTS = ['720p', '1080p', '2k', '4k'];
  return (<>
    <PVCommandHeader t={t} node={node} sub="upscale" onPatch={onPatch} dispatch={dispatch}/>
    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${t.border}` }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: t.textMute, lineHeight: 1.5 }}>
        Connect an upstream video to upscale its resolution.
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Target quality</SectionLabel>
      <ChipSelect t={t} value={quality} options={QUALITY_OPTS} onChange={(v) => setArg('--quality', v)}/>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Advanced</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <KV t={t} k="timeout" v={cliArg(args, '--timeout', '600')} onChange={(v) => setArg('--timeout', v)}/>
      </div>
    </div>
    <PVCliPreview t={t} node={node} args={args}/>
  </>);
}

function PVSpeechPanel({ t, node, args, spec, setArg, setToggle, onPatch, dispatch }) {
  const speakerId = cliArg(args, '--tts-speaker', '');
  return (<>
    <PVCommandHeader t={t} node={node} sub="speech" onPatch={onPatch} dispatch={dispatch}/>
    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${t.border}` }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: t.textMute, lineHeight: 1.5 }}>
        口型同步（Lip sync）：视频人物口型对齐 TTS 语音。<br/>
        接入 <span style={{ color: t.text }}>video</span>（人脸视频）+ <span style={{ color: t.text }}>script</span>（台词文字）。<br/>
        模型固定为 <span style={{ color: t.accent }}>v5</span>，使用 <code>--tts-text</code> 生成语音。
      </div>
    </div>
    <PVModelSelect t={t} args={args} models={spec.models} defaultModel="v5" onChange={(m) => setArg('--model', m)}/>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>TTS speaker (optional)</SectionLabel>
      <div style={{ marginTop: 6 }}>
        <KV t={t} k="speaker ID" v={speakerId} onChange={(v) => setArg('--tts-speaker', v)}/>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Generation</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <NumberKV t={t} k="count" v={cliArg(args, '--count', '1')} min={1} onCommit={(v) => setArg('--count', v)}/>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Flags</SectionLabel>
      <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <ToggleChip t={t} active={hasCliFlag(args, '--keep-original-sound')} onClick={() => setToggle('--keep-original-sound', !hasCliFlag(args, '--keep-original-sound'))}>keep-sound</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--off-peak')} onClick={() => setToggle('--off-peak', !hasCliFlag(args, '--off-peak'))}>off-peak</ToggleChip>
        <ToggleChip t={t} active={hasCliFlag(args, '--no-wait')} onClick={() => setToggle('--no-wait', !hasCliFlag(args, '--no-wait'))}>no-wait</ToggleChip>
      </div>
    </div>
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Advanced</SectionLabel>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <KV t={t} k="timeout" v={cliArg(args, '--timeout', '600')} onChange={(v) => setArg('--timeout', v)}/>
        <KV t={t} k="idempotency" v={cliArg(args, '--idempotency-key', '')} onChange={(v) => setArg('--idempotency-key', v)}/>
      </div>
    </div>
    <PVCliPreview t={t} node={node} args={args}/>
  </>);
}

// ── Main PixVerse settings dispatcher ─────────────────────────────────────────
function PixVerseSettings({ t, node, graph, onPatch, dispatch }) {
  const args = node.cli?.args || [];
  const sub = pixVerseSubcommand(node);
  const spec = pixVerseSpecFor(sub);
  const patchArgs = (nextArgs) => onPatch(pixVerseCliPatchFor(node, sub, nextArgs, graph));
  const setArg = (flag, value) => patchArgs(upsertCliArg(args, flag, value));
  const setToggle = (flag, enabled) => patchArgs(setCliToggle(args, flag, enabled));
  const setExclusiveToggle = (flag, opposite) => {
    const enabled = !hasCliFlag(args, flag);
    const withoutOpposite = setCliToggle(args, opposite, false);
    patchArgs(setCliToggle(withoutOpposite, flag, enabled));
  };

  const shared = { t, node, args, sub, spec, setArg, setToggle, setExclusiveToggle, onPatch, dispatch, graph, patchArgs };

  switch (sub) {
    case 'image':          return <PVImagePanel {...shared}/>;
    case 'video':          return <PVVideoPanel {...shared}/>;
    case 'transition':     return <PVTransitionPanel {...shared}/>;
    case 'reference':      return <PVReferencePanel {...shared}/>;
    case 'motion-control': return <PVMotionControlPanel {...shared}/>;
    case 'extend':         return <PVExtendPanel {...shared}/>;
    case 'upscale':        return <PVUpscalePanel {...shared}/>;
    case 'speech':         return <PVSpeechPanel {...shared}/>;
    default:               return <PVVideoPanel {...shared}/>;
  }
}

function Stat({ t, k, v, sub }) {
  return (
    <div>
      <div style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5, letterSpacing: 0.5, textTransform: 'uppercase' }}>{k}</div>
      <div style={{ color: t.text, fontFamily: FONT_MONO, fontSize: 13, marginTop: 2 }}>{v}</div>
      {sub && <div style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 10, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}
function SectionLabel({ t, children }) {
  return (
    <div style={{
      color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
      letterSpacing: 0.6, textTransform: 'uppercase',
    }}>{children}</div>
  );
}

function thumbSavePath(thumb) {
  if (!thumb || typeof thumb !== 'object') return '';
  const value =
    thumb.path ||
    thumb.local_path ||
    thumb.localPath ||
    thumb.file_path ||
    thumb.filePath ||
    thumb.file ||
    thumb.output ||
    thumb.video_url ||
    thumb.videoUrl ||
    thumb.image_url ||
    thumb.imageUrl ||
    thumb.url ||
    thumb.src ||
    '';
  const s = String(value || '').trim();
  if (!s || /^(https?:|data:|blob:)/i.test(s)) return '';
  if (/^(asset|atlasmedia):\/\/localhost/i.test(s)) {
    try {
      const pathname = new URL(s).pathname;
      const encoded = pathname.startsWith('/%2F') ? pathname.slice(1) : pathname;
      return decodeURIComponent(encoded);
    } catch (_) { return ''; }
  }
  return s;
}

function ProjectSaveDirectory({ t, project, dispatch }) {
  const setDir = (value) => dispatch({
    type: 'SET_PROJECT_OUTPUT_DIR',
    projectId: project.id,
    value,
  });
  return (
    <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
      <SectionLabel t={t}>Project save directory</SectionLabel>
      <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
        <input
          value={project.outputDir || ''}
          onChange={(e) => setDir(e.target.value)}
          spellCheck={false}
          placeholder="~/Desktop/Atlas outputs"
          style={{ ...inputStyle(t), flex: 1, minWidth: 0 }}
        />
        {typeof window.AtlasChooseOutputDir === 'function' && (
          <Btn size="sm" leftIcon="folder" theme="dark"
            style={{ flex: 'none' }}
            onClick={async () => {
              const dir = await window.AtlasChooseOutputDir(project.outputDir || '');
              if (dir) setDir(dir);
            }}
          >Browse</Btn>
        )}
      </div>
    </div>
  );
}

// ============ CONFIG MODAL ============
function ConfigModal({ t, state, dispatch }) {
  if (!state.ui.configOpen) return null;
  const close = () => dispatch({ type: 'UI_PATCH', patch: { configOpen: false } });
  return (
    <div
      onClick={close}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(8,11,16,0.72)',
        backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: FONT_UI,
      }}
    >
      <div onClick={(e) => e.stopPropagation()}
        style={{
          width: 560, maxHeight: '82vh',
          background: t.bg2, border: `1px solid ${t.borderStrong}`,
          borderRadius: 10,
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{
          padding: '14px 18px',
          borderBottom: `1px solid ${t.border}`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <Icon name="settings" size={14} color={t.accent}/>
          <span style={{ color: t.text, fontSize: 14, fontWeight: 600 }}>Config</span>
          <span style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 10 }}>stored on this machine</span>
          <div style={{ flex: 1 }}/>
          <div onClick={close} style={{
            width: 24, height: 24, borderRadius: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: t.textMid,
          }}
            onMouseEnter={(e) => e.currentTarget.style.background = t.panel2}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <Icon name="close" size={13} stroke={1.8}/>
          </div>
        </div>
        <div className="mg-scroll" style={{ flex: 1, overflow: 'auto', padding: '14px 18px' }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{
              color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
              letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8,
            }}>API keys</div>
            {Object.entries(PROVIDER_LABEL).map(([k, label]) => (
              <ConfigRow key={k} t={t}
                label={label}
                hint={`${k.toUpperCase()}_API_KEY`}
                value={state.config.apiKeys[k] || ''}
                mask
                onChange={(v) => dispatch({ type: 'SET_API_KEY', key: k, value: v })}
              />
            ))}
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{
              color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
              letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8,
            }}>Local CLI binaries</div>
            {Object.entries(state.config.binPaths).map(([k, v]) => (
              <ConfigRow key={k} t={t}
                label={k}
                hint="absolute or shell-resolved path"
                value={v}
                onChange={(nv) => dispatch({ type: 'SET_BIN_PATH', key: k, value: nv })}
              />
            ))}
            <div style={{
              marginTop: 4, color: t.textMute, fontFamily: FONT_MONO, fontSize: 10.5, lineHeight: 1.55,
            }}>
              Tip: in the future Tauri / Electron build, these resolve via shell PATH at runtime.
              Today they're stored verbatim and shown in node footers.
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{
              color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
              letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8,
            }}>Defaults</div>
            <ConfigRow t={t}
              label="Default model"
              hint="used by new generator nodes"
              value={state.config.defaultModel}
              onChange={(v) => dispatch({ type: 'SET_CONFIG', patch: { defaultModel: v } })}
            />
          </div>
        </div>
        <div style={{
          padding: '12px 18px',
          borderTop: `1px solid ${t.border}`,
          display: 'flex', alignItems: 'center', gap: 8,
          color: t.textMute, fontFamily: FONT_MONO, fontSize: 10,
        }}>
          <span>changes save automatically</span>
          <div style={{ flex: 1 }}/>
          <Btn primary theme="dark" onClick={close}>Done</Btn>
        </div>
      </div>
    </div>
  );
}

function ConfigRow({ t, label, hint, value, onChange, mask, placeholder, right }) {
  const [show, setShow] = React.useState(false);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
    }}>
      <div style={{ width: 120, flex: 'none' }}>
        <div style={{ color: t.text, fontSize: 12, fontWeight: 500 }}>{label}</div>
        <div style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 10, marginTop: 2 }}>{hint}</div>
      </div>
      <input
        type={mask && !show ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder={placeholder || (mask ? 'sk-…' : '')}
        style={{
          flex: 1, boxSizing: 'border-box',
          background: t.panel, border: `1px solid ${t.border}`,
          color: t.text, fontFamily: FONT_MONO, fontSize: 11,
          padding: '7px 9px', borderRadius: 5, outline: 'none',
        }}
      />
      {mask && (
        <div onClick={() => setShow(s => !s)}
          style={{ padding: 6, color: t.textMute, cursor: 'pointer' }}>
          <Icon name="eye" size={12}/>
        </div>
      )}
      {right}
    </div>
  );
}

window.TopBar = TopBar;
window.Palette = Palette;
window.Inspector = Inspector;
window.ConfigModal = ConfigModal;
