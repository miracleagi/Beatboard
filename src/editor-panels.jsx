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
        <span style={{ color: t.text, fontSize: 12, fontWeight: 600, letterSpacing: -0.1 }}>Beatboard</span>
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
  const isAud = isAudioThumb(thumb, src);
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
      {isAud ? (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', padding: 6, boxSizing: 'border-box' }}>
          <audio src={src} controls preload="metadata" style={{ width: '100%' }} onError={() => setFailed(true)}/>
        </div>
      ) : isVid ? (
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
      const isAud = isAudioThumb(item.thumb, s);
      return {
        kind: 'asset',
        title: item.thumb?.label || (isAud ? 'imported.mp3' : isVid ? 'imported.mp4' : 'imported.png'),
        w: 180, badge: 'asset',
        thumbs: [{ ...item.thumb, chosen: true }],
        ports: [{ kind: isAud ? 'audio' : isVid ? 'video' : 'image', side: 'right', top: 36 }],
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
        const isAud = isAudioThumb(dragItem.thumb, s);
        return (
          <div style={{
            position: 'fixed', left: dragPos.x - 50, top: dragPos.y - 36,
            width: 100, height: 60, borderRadius: 5,
            border: `1.5px dashed ${t.accent}`,
            pointerEvents: 'none', zIndex: 9999, overflow: 'hidden',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}>
            {isAud
              ? <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: t.panel, color: t.textMid, fontFamily: FONT_MONO, fontSize: 10 }}>audio</div>
              : isVid
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
    paletteTemplates().forEach((tpl, i) => {
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
                      item.kind === 'task' ? (item.group === 'Video' ? 'motion' : 'sparkle') :
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
            <SectionLabel t={t}>Providers</SectionLabel>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {providerCatalogList().map(m => (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT_MONO, fontSize: 10.5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.accent }}/>
                  <span style={{ color: t.text, flex: 1 }}>{m.name}</span>
                  <span style={{ color: t.textMute }}>{Object.keys(m.capabilities || {}).length} node types</span>
                </div>
              ))}
              <div style={{ height: 4 }}/>
              <SectionLabel t={t}>Runtime overrides</SectionLabel>
              {Object.entries(state.config.binPaths).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT_MONO, fontSize: 10.5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.green }}/>
                  <span style={{ color: t.text, flex: 1 }}>{k}</span>
                  <span style={{ color: t.textMute, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{v || 'managed'}</span>
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
  const isTask = node.kind === 'task';
  const onPatch = (patch) => dispatch({ type: 'PATCH_GRAPH', fn: g => ({
    ...g, nodes: g.nodes.map(n => n.id === node.id ? { ...n, ...patch } : n),
  })});

  // For output nodes: compute ProjectName_01.ext preview name used in both
  // the inspector header and the "Output file" section below.
  let outputPreviewName = null;
  if (node.kind === 'output') {
    const outputResult = result;
    const thumb = outputResult?.thumbs?.find(t => thumbSavePath(t)) || outputResult?.thumbs?.[0];
    const outputPath = thumbSavePath(thumb) || null;
    if (outputPath) {
      const srcExt = (outputPath.split('.').pop() || 'mp4').toLowerCase();
      const safeName = (project.name || 'Output')
        .trim()
        .replace(/[^a-zA-Z0-9 \-]/g, '_')
        .trim()
        .split(/\s+/).join('_');
      outputPreviewName = `${safeName}_01.${srcExt}`;
    }
  }
  const inputPortStatuses = nodeInputPortStatuses(graph, node.id, id => project.runResults[id]);
  const ownOutputReady = nodeHasUsableOutput(node, result);

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
        <Pill bg={isCli ? t.amberBg : isTask ? t.accentBg : t.panel}
          color={isCli ? t.amber : isTask ? t.accent : t.textMute}
          border={isCli ? t.amberBg : isTask ? t.accentBorder : t.border}>
          {(node.badge || node.kind).toUpperCase()}
        </Pill>
      </div>

      <div className="mg-scroll" style={{ flex: 1, overflow: 'auto' }}>
        {/* Run result preview */}
        {result && (
          <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
            <SectionLabel t={t}>Last run</SectionLabel>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: result.state === 'done' ? t.green : result.state === 'error' || result.state === 'blocked' ? t.red : t.textMute }}/>
              <span style={{ color: t.text, fontFamily: FONT_MONO, fontSize: 11, flexShrink: 0 }}>{result.state}</span>
              {result.error && (
                <span
                  title={result.error}
                  style={{
                    color: t.red, fontFamily: FONT_MONO, fontSize: 10.5, marginLeft: 'auto',
                    flex: 1, minWidth: 0, textAlign: 'right',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                >{result.error}</span>
              )}
              {result.error && (
                <span
                  onClick={() => dispatch({ type: 'UI_PATCH', patch: {
                    errorModal: { errors: [{ nodeId: node.id, title: node.title || node.id, error: result.error }] },
                  }})}
                  style={{
                    flexShrink: 0, cursor: 'pointer', color: t.textMid,
                    border: `1px solid ${t.border}`, borderRadius: 4,
                    padding: '1px 7px', fontFamily: FONT_MONO, fontSize: 10,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = t.red; e.currentTarget.style.borderColor = t.red; }}
                  onMouseLeave={e => { e.currentTarget.style.color = t.textMid; e.currentTarget.style.borderColor = t.border; }}
                >详情</span>
              )}
            </div>
          </div>
        )}

        {isTask && <TaskInspector t={t} node={node} onPatch={onPatch} dispatch={dispatch}/>}

        {isCli && (
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

        {node.kind === 'output' && <ProjectSaveDirectory t={t} project={project} dispatch={dispatch}/>}

        {/* ── Output node: download result to local folder ───────────────── */}
        {node.kind === 'output' && (() => {
          if (!outputPreviewName) return null;
          // Save only the output node's own completed result. Upstream media is
          // intentionally not exposed until this node has run successfully.
          const outputResult = result;
          const thumb = outputResult?.thumbs?.find(t => thumbSavePath(t)) || outputResult?.thumbs?.[0];
          const outputPath = thumbSavePath(thumb) || null;
          if (!outputPath) return null;
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
                      const dest = await window.AtlasDownloadOutputFile(outputPath, project.name, outputDir);
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
                          ports: [{ kind: file.type === 'audio' ? 'audio' : file.type === 'video' ? 'video' : 'image', side: 'right', top: 36 }],
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
                      const isAud = isAudioThumb(item.thumb, s);
                      const isCurrent = currentThumb && (
                        mediaSrc(currentThumb) === s ||
                        (currentThumb.seed && currentThumb.seed === item.thumb?.seed)
                      );
                      return (
                        <div key={item.id}
                          onClick={() => {
                            onPatch({
                              thumbs: [{ ...item.thumb, chosen: true }],
                              ports: [{ kind: isAud ? 'audio' : isVid ? 'video' : 'image', side: 'right', top: 36 }],
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
            {(node.ports || []).map((p, i) => {
              const inputStatus = p.side === 'left' ? inputPortStatuses[i]?.state : null;
              const status = p.side === 'right'
                ? (ownOutputReady ? 'ready' : result?.state === 'error' || result?.state === 'blocked' ? result.state : 'no output')
                : inputStatus === 'unconnected' ? 'open' : inputStatus;
              const statusColor = status === 'ready' ? t.green
                : status === 'waiting' ? t.amber
                : status === 'blocked' || status === 'error' ? t.red
                : t.textMute;
              return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontFamily: FONT_MONO, fontSize: 10.5,
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', background: PORT_COLORS[p.kind],
                  boxShadow: `0 0 0 1px ${statusColor}`,
                }}/>
                <span style={{ color: t.textMid, flex: 1 }}>{p.label || p.kind}</span>
                <span style={{ color: t.textMute }}>{p.side === 'left' ? 'in' : 'out'} · {PORT_LABEL[p.kind]}</span>
                <span style={{ color: statusColor, minWidth: 54, textAlign: 'right' }}>{status || '—'}</span>
              </div>
            )})}
          </div>
        </div>

        <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Btn size="sm" leftIcon="vary" theme="dark" style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => {
              const newId = makeNodeId(graph, nodeIdPrefix(node.kind));
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

// ── Generator (task) node settings ────────────────────────────────────────────
// Everything here is driven by the provider manifest (src/providers/*.json):
// the model list, which params exist, their widgets, options and defaults.

function sectionBox(t) {
  return { padding: '12px 14px', borderBottom: `1px solid ${t.border}` };
}

// Text / integer field that commits on blur or Enter. Empty clears the param.
function ParamInput({ t, spec, value, onCommit }) {
  const shown = value === undefined || value === null ? '' : String(value);
  const [draft, setDraft] = React.useState(shown);
  React.useEffect(() => { setDraft(shown); }, [shown]);
  const commit = () => {
    const raw = draft.trim();
    if (raw === '') { if (shown !== '') onCommit(undefined); return; }
    if (spec.type === 'int') {
      const n = Number(raw);
      if (!Number.isInteger(n) || (spec.min != null && n < spec.min) || (spec.max != null && n > spec.max)) {
        setDraft(shown);
        return;
      }
      if (n !== value) onCommit(n);
      return;
    }
    if (raw !== shown) onCommit(raw);
  };
  const placeholder = spec.default != null ? String(spec.default) : (spec.placeholder || '');
  return (
    <div>
      <div style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5, letterSpacing: 0.5, textTransform: 'uppercase' }}>{spec.label || spec.key}</div>
      <input
        value={draft}
        placeholder={placeholder}
        inputMode={spec.type === 'int' ? 'numeric' : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        spellCheck={false}
        style={{ ...inputStyle(t), marginTop: 2 }}
      />
    </div>
  );
}

function TaskParamSection({ t, node, name, specs, onSet }) {
  const enums = specs.filter(s => s.type === 'enum');
  const fields = specs.filter(s => s.type === 'int' || s.type === 'string');
  const toggles = specs.filter(s => s.type === 'bool' || s.type === 'tri');
  return (<>
    {enums.map(spec => {
      const value = taskParamValue(node, spec);
      const numeric = (spec.options || []).some(o => typeof o === 'number');
      return (
        <div key={spec.key} style={sectionBox(t)}>
          <SectionLabel t={t}>{spec.label || spec.key}</SectionLabel>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
            {(spec.options || []).map(opt => {
              const active = String(value) === String(opt);
              return (
                <div key={opt} onClick={() => onSet(spec, numeric ? Number(opt) : opt)} style={{
                  padding: '4px 8px',
                  background: active ? t.accentBg : t.panel,
                  border: `1px solid ${active ? t.accentBorder : t.border}`,
                  color: active ? t.accent : t.textMid,
                  borderRadius: 4, fontFamily: FONT_MONO, fontSize: 10,
                  cursor: 'pointer', userSelect: 'none',
                }}>{opt}{spec.unit || ''}</div>
              );
            })}
          </div>
        </div>
      );
    })}
    {(fields.length > 0 || toggles.length > 0) && (
      <div style={sectionBox(t)}>
        <SectionLabel t={t}>{name}</SectionLabel>
        {fields.length > 0 && (
          <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {fields.map(spec => (
              <ParamInput key={spec.key} t={t} spec={spec}
                value={node[spec.bucket]?.[spec.key]}
                onCommit={(v) => onSet(spec, v)}/>
            ))}
          </div>
        )}
        {toggles.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {toggles.flatMap(spec => {
              const value = node[spec.bucket]?.[spec.key];
              if (spec.type === 'bool') {
                return [<ToggleChip key={spec.key} t={t} active={value === true}
                  onClick={() => onSet(spec, value === true ? undefined : true)}>{spec.label || spec.key}</ToggleChip>];
              }
              const [on, off] = spec.labels || [spec.key, `no ${spec.key}`];
              return [
                <ToggleChip key={`${spec.key}:on`} t={t} active={value === true}
                  onClick={() => onSet(spec, value === true ? undefined : true)}>{on}</ToggleChip>,
                <ToggleChip key={`${spec.key}:off`} t={t} active={value === false}
                  onClick={() => onSet(spec, value === false ? undefined : false)}>{off}</ToggleChip>,
              ];
            })}
          </div>
        )}
      </div>
    )}
  </>);
}

// The command the provider will run, with inputs shown as <port label>.
function TaskCommandPreview({ t, node }) {
  const [argv, setArgv] = React.useState(null);
  const [error, setError] = React.useState('');
  const key = JSON.stringify([node.capability, node.provider, node.model, node.params, node.provider_params, node.ports, node.prompt]);
  React.useEffect(() => {
    if (!window.__TAURI__) return;
    let live = true;
    window.__TAURI__.tauri.invoke('preview_task', { node })
      .then(v => { if (live) { setArgv(v); setError(''); } })
      .catch(e => { if (live) { setArgv(null); setError(String(e)); } });
    return () => { live = false; };
  }, [key]);
  if (!window.__TAURI__ || (!argv && !error)) return null;
  return (
    <div style={sectionBox(t)}>
      <SectionLabel t={t}>Resolved command</SectionLabel>
      <div style={{
        marginTop: 6, padding: '8px 10px',
        background: t.panel, border: `1px solid ${error ? t.red : t.border}`, borderRadius: 4,
        color: error ? t.red : t.text, fontFamily: FONT_MONO, fontSize: 10, lineHeight: 1.55,
        wordBreak: 'break-word',
      }}>
        {error || (<>
          <div><span style={{ color: t.green }}>$</span> {argv[0]}</div>
          {argv.slice(1).map((a, i) => (
            <div key={i} style={{ paddingLeft: 10, color: t.textMid }}>{a}</div>
          ))}
        </>)}
      </div>
    </div>
  );
}

function TaskInspector({ t, node, onPatch, dispatch }) {
  const providers = providersFor(node.capability);
  const entry = providerCapability(node.provider, node.capability);
  const specs = taskParamSpecs(node.provider, node.capability);
  const raw = node.provider_params?._raw_args;

  // Write back the fields a task edit can change (undefined removes `model`).
  const commit = (next) => onPatch({
    provider: next.provider, model: next.model,
    params: next.params, provider_params: next.provider_params,
    title: next.title, badge: next.badge, footer: next.footer,
  });
  const [notice, setNotice] = React.useState('');
  React.useEffect(() => { setNotice(''); }, [node.id]);

  if (!entry) {
    return (
      <div style={sectionBox(t)}>
        <div style={{ color: t.red, fontFamily: FONT_MONO, fontSize: 10.5, lineHeight: 1.5 }}>
          Provider “{node.provider}” does not offer {node.capability}.
        </div>
      </div>
    );
  }

  const sections = [];
  specs.forEach(spec => {
    const name = spec.section || 'Settings';
    let group = sections.find(g => g.name === name);
    if (!group) sections.push(group = { name, specs: [] });
    group.specs.push(spec);
  });
  const models = entry.models || [];
  const customModel = node.model && !models.includes(node.model);

  return (<>
    <div style={sectionBox(t)}>
      <SectionLabel t={t}>Provider</SectionLabel>
      <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
        <select
          value={node.provider}
          disabled={providers.length < 2}
          onChange={(e) => {
            const { node: next, dropped } = switchTaskProvider(node, e.target.value);
            commit(next);
            setNotice(dropped.length ? `Removed settings ${providerName(next.provider)} doesn't support: ${dropped.join(', ')}` : '');
          }}
          style={{ ...selectStyle(t), flex: 1 }}
        >
          {providers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <Btn size="sm" theme="dark" leftIcon="settings"
          onClick={() => dispatch({ type: 'UI_PATCH', patch: { configOpen: true } })}>Config</Btn>
      </div>
      {notice && (
        <div style={{ marginTop: 6, color: t.amber, fontFamily: FONT_MONO, fontSize: 10, lineHeight: 1.5 }}>{notice}</div>
      )}
    </div>

    {raw && (
      <div style={sectionBox(t)}>
        <SectionLabel t={t}>Custom command</SectionLabel>
        <div style={{ marginTop: 6, color: t.amber, fontFamily: FONT_MONO, fontSize: 10, lineHeight: 1.5 }}>
          This node was created with a hand-edited {providerName(node.provider)} command that could not be
          converted to settings. It still runs exactly as before; reset it to edit settings here.
        </div>
        <div style={{
          marginTop: 6, padding: '6px 8px', background: t.panel, border: `1px solid ${t.border}`,
          borderRadius: 4, color: t.textMid, fontFamily: FONT_MONO, fontSize: 10, wordBreak: 'break-word',
        }}>{raw.join(' ')}</div>
        <Btn size="sm" theme="dark" style={{ marginTop: 8 }}
          onClick={() => {
            const fresh = spawnTaskNode(node.capability, node.provider);
            commit({ ...node, ...fresh, footer: { ...fresh.footer, right: node.footer?.right || '— idle' } });
          }}>Reset to standard settings</Btn>
      </div>
    )}

    {!raw && models.length > 0 && (
      <div style={sectionBox(t)}>
        <SectionLabel t={t}>Model</SectionLabel>
        <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {[...models, ...(customModel ? [node.model] : [])].map(m => {
            const active = node.model === m;
            return (
              <div key={m} title={m} onClick={() => commit(setTaskModel(node, m))} style={{
                padding: '5px 9px',
                background: active ? t.accentBg : t.panel,
                border: `1px solid ${active ? t.accentBorder : t.border}`,
                color: active ? t.accent : t.textMid,
                borderRadius: 4, fontFamily: FONT_MONO, fontSize: 10, cursor: 'pointer',
              }}>{m}{m === node.model && customModel ? ' (custom)' : ''}</div>
            );
          })}
        </div>
      </div>
    )}

    {entry.help && (
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${t.border}` }}>
        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: t.textMute, lineHeight: 1.5 }}>{entry.help}</div>
      </div>
    )}

    {!raw && sections.map(section => (
      <TaskParamSection key={section.name} t={t} node={node} name={section.name} specs={section.specs}
        onSet={(spec, value) => commit(setTaskParam(node, spec, value))}/>
    ))}

    <TaskCommandPreview t={t} node={node}/>
  </>);
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
          placeholder="~/Desktop/Beatboard outputs"
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
function ManagedRuntimePanel({ t, state }) {
  const [status, setStatus] = React.useState(null);
  const [busy, setBusy] = React.useState('');
  const [message, setMessage] = React.useState('');

  const refresh = React.useCallback(async () => {
    if (!window.__TAURI__) return;
    try {
      const next = await window.__TAURI__.tauri.invoke('runtime_status', { config: state.config });
      setStatus(next);
    } catch (error) {
      setMessage(String(error));
    }
  }, [state.config]);

  React.useEffect(() => { refresh(); }, [refresh]);

  const runAction = async (kind) => {
    if (!window.__TAURI__ || busy) return;
    setBusy(kind);
    setMessage('');
    try {
      if (kind === 'install') {
        await window.__TAURI__.tauri.invoke('install_pixverse_runtime', {
          force: status?.pixverse?.source === 'managed',
        });
        setMessage('PixVerse runtime installed. Sign in once to connect your account.');
      } else {
        await window.__TAURI__.tauri.invoke('pixverse_auth_login', { config: state.config });
        setMessage('PixVerse sign-in completed.');
      }
      await refresh();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy('');
    }
  };

  const rows = [
    { key: 'ffmpeg', label: 'FFmpeg', fallback: 'bundled with Beatboard' },
    { key: 'pixverse', label: 'PixVerse CLI', fallback: 'managed by Beatboard' },
  ];

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
        letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8,
      }}>Managed runtimes</div>
      <div style={{
        background: t.panel, border: `1px solid ${t.border}`, borderRadius: 7,
        padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 9,
      }}>
        {rows.map(row => {
          const tool = status?.[row.key];
          const ready = !!tool?.available;
          return (
            <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: ready ? t.green : t.amber }}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: t.text, fontSize: 11.5, fontWeight: 500 }}>{row.label}</div>
                <div style={{
                  color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {tool ? `${tool.source} · ${tool.version || (ready ? 'ready' : 'unavailable')}` : row.fallback}
                </div>
              </div>
              <Pill color={ready ? t.green : t.amber} bg={ready ? t.greenBg : t.amberBg}>
                {ready ? 'READY' : 'SETUP'}
              </Pill>
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 7, paddingTop: 2 }}>
          <Btn size="sm" primary theme="dark" leftIcon="download"
            style={{ opacity: busy ? 0.55 : 1 }}
            onClick={() => runAction('install')}>
            {busy === 'install' ? 'Installing…' : status?.pixverse?.source === 'managed' ? 'Reinstall runtime' : 'Install PixVerse'}
          </Btn>
          <Btn size="sm" theme="dark" leftIcon="link"
            style={{ opacity: busy || !status?.pixverse?.available ? 0.55 : 1 }}
            onClick={() => status?.pixverse?.available && runAction('login')}>
            {busy === 'login' ? 'Waiting for sign-in…' : 'Sign in to PixVerse'}
          </Btn>
          <Btn size="sm" theme="dark" onClick={refresh}>Refresh</Btn>
        </div>
        {message && (
          <div style={{ color: message.includes('completed') || message.includes('installed') ? t.green : t.amber, fontFamily: FONT_MONO, fontSize: 9.5, lineHeight: 1.45 }}>
            {message}
          </div>
        )}
      </div>
    </div>
  );
}

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
          <ManagedRuntimePanel t={t} state={state}/>

          <div style={{ marginBottom: 16 }}>
            <div style={{
              color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
              letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8,
            }}>Advanced runtime overrides</div>
            {['ffmpeg', 'pixverse'].map(k => (
              <ConfigRow key={k} t={t}
                label={k}
                hint="optional custom path"
                value={state.config.binPaths[k] || ''}
                placeholder="leave empty to use Beatboard runtime"
                onChange={(nv) => dispatch({ type: 'SET_BIN_PATH', key: k, value: nv })}
              />
            ))}
            <div style={{
              marginTop: 4, color: t.textMute, fontFamily: FONT_MONO, fontSize: 10.5, lineHeight: 1.55,
            }}>
              Beatboard uses a custom path first, then its bundled/managed runtime, then the system PATH.
            </div>
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
