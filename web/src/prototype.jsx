// Interactive Pipeline prototype.
//
// Click a node → inspector updates. Click "Run graph" → nodes animate through
// queued → running → done in topological order, edges light up between them.
// Double-click a CLI node → inline command editor expands. Drag an asset chip
// from the bottom tray → a new asset node lands where you drop it.

const TOPO = {
  iterate: ['p0', 'g0', 'pk0', 'cli0', 'g1', 'out'],
  batch:   ['p0', 'g0', 'g1', 'g2', 'g3', 'cli0', 'pk0', 'cli1', 'out'],
  assembly:['p1', 'p2', 'p3', 'g1', 'g2', 'g3', 'm1', 'm2', 'aud', 'm3', 'ff', 'out'],
};

const ASSET_TRAY = [
  { id: 'ref-portrait', kind: 'image', label: 'ref · portrait', seed: 'ref1' },
  { id: 'ref-mood', kind: 'image', label: 'ref · mood board', seed: 'ref2' },
  { id: 'lora-style', kind: 'file', label: 'cyber-noir.lora', seed: 'lora' },
  { id: 'audio-bg', kind: 'file', label: 'score.mp3', seed: 'audio' },
  { id: 'mask', kind: 'image', label: 'mask.png', seed: 'mask' },
];

// Left palette: node groups + asset tray at the bottom.
function PaletteRail({ t, onDragAsset, dragging }) {
  const groups = [
    { name: 'Generators', items: [
      { i: 'sparkle', label: 'Flux.1', meta: 'api' },
      { i: 'sparkle', label: 'SDXL local', meta: 'local' },
      { i: 'sparkle', label: 'Imagen 3', meta: 'api' },
    ]},
    { name: 'Modifiers', items: [
      { i: 'upscale', label: 'Upscale', meta: 'cli' },
      { i: 'image', label: 'Inpaint', meta: 'local' },
      { i: 'vary', label: 'Vary region', meta: 'api' },
    ]},
    { name: 'Motion', items: [
      { i: 'motion', label: 'Kling 1.6', meta: 'api' },
      { i: 'motion', label: 'Runway gen4', meta: 'api' },
      { i: 'motion', label: 'Wan 2.1', meta: 'local' },
    ]},
    { name: 'CLI / Scripts', items: [
      { i: 'terminal', label: 'ffmpeg', meta: 'cli' },
      { i: 'terminal', label: 'real-esrgan', meta: 'cli' },
      { i: 'terminal', label: 'rife (frame int.)', meta: 'cli' },
      { i: 'terminal', label: 'custom .sh', meta: 'cli' },
    ]},
  ];
  return (
    <div style={{
      width: 168, flex: 'none',
      background: t.bg2, borderRight: `1px solid ${t.border}`,
      display: 'flex', flexDirection: 'column',
      fontFamily: FONT_UI,
    }}>
      <div style={{
        padding: '10px 12px', borderBottom: `1px solid ${t.border}`,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <Icon name="grid" size={12} color={t.accent}/>
        <span style={{ color: t.text, fontSize: 11.5, fontWeight: 600 }}>Nodes</span>
      </div>
      <div className="mg-scroll" style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {groups.map((g) => (
          <div key={g.name} style={{ marginBottom: 6 }}>
            <div style={{
              padding: '6px 12px',
              color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
              letterSpacing: 0.6, textTransform: 'uppercase',
            }}>{g.name}</div>
            {g.items.map((item, i) => (
              <div key={i} style={{
                padding: '5px 12px',
                display: 'flex', alignItems: 'center', gap: 8,
                color: t.text, fontSize: 11.5,
                cursor: 'grab',
              }}>
                <Icon name={item.i} size={12} color={item.meta === 'cli' ? t.amber : t.accent}/>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                {item.meta && (
                  <span style={{
                    color: item.meta === 'cli' ? t.amber : item.meta === 'local' ? t.green : t.textMute,
                    fontFamily: FONT_MONO, fontSize: 9, letterSpacing: 0.4,
                  }}>{item.meta.toUpperCase()}</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      {/* Asset tray */}
      <div style={{ borderTop: `1px solid ${t.border}`, padding: '8px 0' }}>
        <div style={{
          padding: '0 12px 6px',
          color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
          letterSpacing: 0.6, textTransform: 'uppercase',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          Asset tray
          <span style={{ color: t.accent, textTransform: 'none', letterSpacing: 0.2 }}>← drag onto canvas</span>
        </div>
        {ASSET_TRAY.map(a => (
          <div
            key={a.id}
            onMouseDown={(e) => onDragAsset(a, e)}
            style={{
              padding: '5px 12px',
              display: 'flex', alignItems: 'center', gap: 8,
              color: t.text, fontSize: 11.5,
              cursor: 'grab',
              opacity: dragging && dragging.id === a.id ? 0.4 : 1,
            }}
          >
            <div style={{
              width: 22, height: 22, borderRadius: 3, flex: 'none',
              background: PORT_COLORS[a.kind] + '33',
              border: `1px solid ${PORT_COLORS[a.kind]}66`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: PORT_COLORS[a.kind],
            }}>
              <Icon name={a.kind === 'image' ? 'image' : 'folder'} size={11}/>
            </div>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Scenario picker pill bar — sits inside the canvas toolbar
function ScenarioPicker({ t, scenario, setScenario }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 2,
      padding: 2, background: t.panel, border: `1px solid ${t.border}`,
      borderRadius: 6,
    }}>
      {SCENARIOS.map(s => (
        <div
          key={s.id}
          onClick={() => setScenario(s.id)}
          style={{
            padding: '4px 10px',
            background: scenario === s.id ? t.accentBg : 'transparent',
            color: scenario === s.id ? t.accent : t.textMid,
            border: `1px solid ${scenario === s.id ? t.accentBorder : 'transparent'}`,
            borderRadius: 4, fontSize: 11, fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {s.name.split(' ')[0]}
        </div>
      ))}
    </div>
  );
}

function PrototypeInspector({ t, selectedNode, scenario }) {
  if (!selectedNode) {
    return (
      <div style={{
        width: 288, flex: 'none',
        background: t.bg2, borderLeft: `1px solid ${t.border}`,
        display: 'flex', flexDirection: 'column',
        fontFamily: FONT_UI,
      }}>
        <div style={{
          padding: '10px 14px', borderBottom: `1px solid ${t.border}`,
          color: t.textMid, fontSize: 12, fontWeight: 600,
        }}>
          Graph
        </div>
        <div style={{ padding: '12px 14px' }}>
          <SectionLabel t={t}>Scenario</SectionLabel>
          <div style={{ marginTop: 6, color: t.text, fontSize: 12 }}>{scenario.name}</div>
          <div style={{ marginTop: 3, color: t.textMute, fontFamily: FONT_MONO, fontSize: 10.5, lineHeight: 1.5 }}>{scenario.desc}</div>
        </div>
        <div style={{ padding: '12px 14px', borderTop: `1px solid ${t.border}` }}>
          <SectionLabel t={t}>Health</SectionLabel>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              { l: 'flux.1-dev · replicate', s: 'ok', d: '198ms' },
              { l: 'kling-1.6 · piapi', s: 'ok', d: '342ms' },
              { l: '~/bin/realesrgan', s: 'ok', d: 'cached' },
              { l: '~/bin/ffmpeg', s: 'ok', d: '6.0' },
              { l: 'wan-2.1 · local gpu', s: 'busy', d: '1 queued' },
            ].map((r,i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT_MONO, fontSize: 10.5 }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: r.s === 'ok' ? t.green : r.s === 'busy' ? t.amber : t.red,
                }}/>
                <span style={{ color: t.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.l}</span>
                <span style={{ color: t.textMute }}>{r.d}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const node = selectedNode;
  const isCli = node.kind === 'cli';

  return (
    <div style={{
      width: 288, flex: 'none',
      background: t.bg2, borderLeft: `1px solid ${t.border}`,
      display: 'flex', flexDirection: 'column',
      fontFamily: FONT_UI,
    }}>
      <div style={{
        padding: '10px 14px', borderBottom: `1px solid ${t.border}`,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <div style={{
          width: 6, height: 6, borderRadius: 2,
          background: isCli ? t.amber : node.kind === 'output' ? t.green : t.accent,
        }}/>
        <span style={{ color: t.text, fontSize: 12, fontWeight: 600 }}>{node.title}</span>
        <Pill bg={isCli ? t.amberBg : t.accentBg} color={isCli ? t.amber : t.accent} border={isCli ? t.amberBg : t.accentBorder}>
          {(node.badge || node.kind).toUpperCase()}
        </Pill>
      </div>
      <div className="mg-scroll" style={{ flex: 1, overflow: 'auto' }}>
        {isCli && (
          <>
            <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
              <SectionLabel t={t}>Binary</SectionLabel>
              <div style={{
                marginTop: 6, padding: '6px 8px',
                background: t.panel, border: `1px solid ${t.border}`, borderRadius: 4,
                color: t.text, fontFamily: FONT_MONO, fontSize: 11,
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{ color: t.textMute }}>~/bin/</span>
                <span>{node.cli.cmd.split(' ')[0]}</span>
                <div style={{ flex: 1 }}/>
                <span style={{ color: t.green, fontSize: 10 }}>✓ found</span>
              </div>
            </div>
            <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
              <SectionLabel t={t}>Args (template)</SectionLabel>
              <div style={{
                marginTop: 6, padding: '8px 10px',
                background: t.panel, border: `1px solid ${t.border}`, borderRadius: 4,
                color: t.text, fontFamily: FONT_MONO, fontSize: 11,
                lineHeight: 1.55,
              }}>
                <div><span style={{ color: t.green }}>$</span> {node.cli.cmd}</div>
                {node.cli.args.map((a, i) => (
                  <div key={i} style={{ paddingLeft: 10, color: t.textMid }}>
                    {a.split(' ').map((tok, j) => {
                      if (tok.startsWith('{')) return <span key={j} style={{ color: t.accent }}>{tok} </span>;
                      if (tok.match(/^-?\d+(\.\d+)?$/)) return <span key={j} style={{ color: t.amber }}>{tok} </span>;
                      return <span key={j}>{tok} </span>;
                    })}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
              <SectionLabel t={t}>Inputs</SectionLabel>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(node.ports || []).filter(p => p.side === 'left').map((p, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 9px',
                    background: t.panel, border: `1px solid ${t.border}`,
                    borderRadius: 4,
                  }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: PORT_COLORS[p.kind],
                    }}/>
                    <span style={{ color: t.textMid, fontFamily: FONT_MONO, fontSize: 10.5 }}>{p.label || p.kind}</span>
                    <div style={{ flex: 1 }}/>
                    <span style={{ color: t.text, fontFamily: FONT_MONO, fontSize: 10.5 }}>{PORT_LABEL[p.kind]}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ padding: '14px' }}>
              <Btn primary leftIcon="play" theme="dark" style={{ width: '100%', justifyContent: 'center' }}>
                Run this node
              </Btn>
              <div style={{
                marginTop: 8, color: t.textMute,
                fontFamily: FONT_MONO, fontSize: 10, textAlign: 'center',
              }}>
                double-click node to edit inline
              </div>
            </div>
          </>
        )}

        {!isCli && (
          <>
            {node.thumbs && node.thumbs.length > 0 && (
              <div style={{ padding: 14, borderBottom: `1px solid ${t.border}` }}>
                <Placeholder theme="dark" w={260} h={160} label={node.title} seed={node.thumbs[0].seed} radius={5}/>
              </div>
            )}
            {node.prompt && (
              <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
                <SectionLabel t={t}>Prompt</SectionLabel>
                <div style={{
                  marginTop: 6, padding: 9,
                  background: t.panel, border: `1px solid ${t.border}`, borderRadius: 4,
                  color: t.text, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.5,
                }}>
                  {node.prompt.split(/(\*\*[^*]+\*\*)/).map((s, i) =>
                    s.startsWith('**') ? <span key={i} style={{ color: t.accent }}>{s.slice(2, -2)}</span> : <span key={i}>{s}</span>
                  )}
                </div>
              </div>
            )}
            <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
              <SectionLabel t={t}>State</SectionLabel>
              <div style={{
                marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px',
              }}>
                <Stat t={t} k="state" v={(node.state || 'idle').toUpperCase()}/>
                <Stat t={t} k="progress" v={`${Math.round((node.progress || 0) * 100)}%`}/>
                <Stat t={t} k="ports" v={`${(node.ports || []).length}`}/>
                <Stat t={t} k="kind" v={node.kind}/>
              </div>
            </div>
            <div style={{ padding: '14px' }}>
              <Btn primary leftIcon="play" theme="dark" style={{ width: '100%', justifyContent: 'center' }}>
                Run from this node
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ t, k, v }) {
  return (
    <div>
      <div style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5, letterSpacing: 0.5, textTransform: 'uppercase' }}>{k}</div>
      <div style={{ color: t.text, fontFamily: FONT_MONO, fontSize: 11, marginTop: 2 }}>{v}</div>
    </div>
  );
}

function SectionLabel({ children, t }) {
  return (
    <div style={{
      color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
      letterSpacing: 0.6, textTransform: 'uppercase',
    }}>{children}</div>
  );
}

// ============ MAIN PROTOTYPE ============
function PipelinePrototype({
  theme = 'dark',
  cliStyle = 'hybrid',
  connectionStyle = 'bezier',
  previewStyle = 'hybrid',
  statusStyle = 'border',
  initialScenario = 'assembly',
  height = 900,
}) {
  const t = TOKENS[theme];
  const [scenarioId, setScenarioId] = React.useState(initialScenario);
  const scenario = SCENARIO_BY_ID[scenarioId];
  const [selectedId, setSelectedId] = React.useState(scenarioId === 'assembly' ? 'ff' : (scenarioId === 'iterate' ? 'cli0' : 'cli0'));
  const [expandedId, setExpandedId] = React.useState(null);
  const [extraAssets, setExtraAssets] = React.useState([]);
  const [dragAsset, setDragAsset] = React.useState(null); // { asset, x, y }

  // Run animation state — when null, scenarios use their baked states. When
  // present, we override per-node state by topological progress.
  const [run, setRun] = React.useState(null); // { stepIdx, t (0..1) }
  const runReqRef = React.useRef(null);

  React.useEffect(() => {
    // Reset selection & assets when scenario changes
    setSelectedId(scenarioId === 'assembly' ? 'ff' : 'cli0');
    setExpandedId(null);
    setExtraAssets([]);
    setRun(null);
  }, [scenarioId]);

  // Run animation loop
  React.useEffect(() => {
    if (!run) return;
    const STEP_MS = 700;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = (now - last) / STEP_MS;
      last = now;
      setRun(r => {
        if (!r) return null;
        const order = TOPO[scenarioId];
        let nt = r.t + dt;
        let nIdx = r.stepIdx;
        if (nt >= 1) { nt = 0; nIdx += 1; }
        if (nIdx >= order.length) return null; // done
        return { stepIdx: nIdx, t: nt };
      });
      runReqRef.current = requestAnimationFrame(tick);
    };
    runReqRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(runReqRef.current);
  }, [run, scenarioId]);

  // Resolve nodes (with run overrides + extra assets)
  const nodes = React.useMemo(() => {
    const baseline = [...scenario.nodes, ...extraAssets];
    if (!run) return baseline;
    const order = TOPO[scenarioId];
    return baseline.map(n => {
      const idx = order.indexOf(n.id);
      if (idx === -1) return n;
      if (idx < run.stepIdx) return { ...n, state: 'done', progress: 1 };
      if (idx === run.stepIdx) return { ...n, state: 'running', progress: run.t };
      return { ...n, state: 'queued', progress: 0 };
    });
  }, [scenario.nodes, extraAssets, run, scenarioId]);

  const edges = React.useMemo(() => {
    if (!run) return scenario.edges;
    const order = TOPO[scenarioId];
    return scenario.edges.map(e => {
      const fromIdx = order.indexOf(e.from.node);
      const toIdx = order.indexOf(e.to.node);
      const running = toIdx === run.stepIdx && fromIdx < run.stepIdx;
      return { ...e, running };
    });
  }, [scenario.edges, run, scenarioId]);

  const selectedNode = nodes.find(n => n.id === selectedId);

  // ---- Asset drag handlers ----
  const canvasRef = React.useRef(null);
  const onDragAssetStart = (asset, e) => {
    e.preventDefault();
    setDragAsset({ asset, x: e.clientX, y: e.clientY });
    const onMove = (ev) => setDragAsset(d => d ? { ...d, x: ev.clientX, y: ev.clientY } : null);
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Compute drop point in canvas coords
      const rect = canvasRef.current && canvasRef.current.getBoundingClientRect();
      if (rect && ev.clientX > rect.left && ev.clientX < rect.right && ev.clientY > rect.top && ev.clientY < rect.bottom) {
        const x = ev.clientX - rect.left - 90;
        const y = ev.clientY - rect.top - 30;
        setExtraAssets(arr => [...arr, {
          id: `asset-${Date.now()}`,
          title: asset.label,
          kind: 'asset', badge: 'asset',
          x, y, w: 180,
          thumbs: [{ seed: asset.seed, label: asset.label }],
          ports: [{ kind: asset.kind, side: 'right', top: 36 }],
          footer: { left: 'dropped · just now', right: 'ready' },
          state: 'done',
        }]);
      }
      setDragAsset(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div style={{
      width: '100%', height,
      background: t.bg, color: t.text,
      display: 'flex', flexDirection: 'column',
      fontFamily: FONT_UI,
      overflow: 'hidden',
    }}>
      <AppHeader theme={theme} tabs={[
        { id: 'cyber', name: 'Cyber Noir', count: 47, color: '#7fc8ff' },
        { id: 'arch', name: 'Architecture R&D', count: 18, color: '#f4c47a' },
        { id: 'brand', name: 'Q3 Brand Film', count: 124, color: '#8ed4a8' },
      ]} activeTab="cyber"/>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <PaletteRail t={t} onDragAsset={onDragAssetStart} dragging={dragAsset && dragAsset.asset}/>

        {/* Canvas */}
        <div
          ref={canvasRef}
          onClick={() => { setSelectedId(null); setExpandedId(null); }}
          style={{
            flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden',
            background: t.bg,
            backgroundImage: `radial-gradient(circle, ${t.grid} 1px, transparent 1px)`,
            backgroundSize: '24px 24px',
          }}
        >
          {/* Top toolbar */}
          <div style={{
            position: 'absolute', top: 12, left: 12, right: 12,
            display: 'flex', alignItems: 'center', gap: 10,
            zIndex: 4, pointerEvents: 'none',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'auto' }}>
              <div style={{
                padding: '4px 10px', background: t.panel, border: `1px solid ${t.border}`,
                borderRadius: 5, color: t.text, fontSize: 11,
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <Icon name="folder" size={12} color={t.textMid}/>
                <span>cyber-noir</span>
                <Icon name="chevRight" size={10} color={t.textMute}/>
                <span style={{ color: t.text }}>{scenario.id}.flow</span>
                {run && <span style={{ color: t.amber, fontFamily: FONT_MONO, fontSize: 10 }}>● running</span>}
              </div>
              <ScenarioPicker t={t} scenario={scenarioId} setScenario={setScenarioId}/>
            </div>
            <div style={{ flex: 1 }}/>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, pointerEvents: 'auto' }}>
              {run ? (
                <Btn size="sm" leftIcon="pause" theme="dark" onClick={(e) => { e.stopPropagation(); setRun(null); }}>Stop</Btn>
              ) : (
                <Btn size="sm" primary leftIcon="play" theme="dark" onClick={(e) => { e.stopPropagation(); setRun({ stepIdx: 0, t: 0 }); }}>Run graph</Btn>
              )}
              <Btn size="sm" leftIcon="branch" theme="dark" onClick={(e) => e.stopPropagation()}>Fork</Btn>
              <div style={{
                padding: '4px 8px', background: t.panel, border: `1px solid ${t.border}`,
                borderRadius: 5, color: t.textMid, fontFamily: FONT_MONO, fontSize: 10.5,
              }}>67%</div>
            </div>
          </div>

          {/* Edges */}
          <Edges t={t} edges={edges} nodes={nodes} connectionStyle={connectionStyle} layout={scenario.layout}/>

          {/* Nodes */}
          {nodes.map(n => (
            <Node
              key={n.id}
              t={t} node={n}
              selected={selectedId === n.id}
              expanded={expandedId === n.id}
              cliStyle={cliStyle}
              previewStyle={previewStyle}
              statusStyle={statusStyle}
              onSelect={(id) => setSelectedId(id)}
              onExpand={(id) => setExpandedId(x => x === id ? null : id)}
            />
          ))}

          {/* Log strip at bottom */}
          <div style={{
            position: 'absolute', left: 12, right: 12, bottom: 12,
            background: t.bg2,
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            padding: '8px 12px',
            display: 'flex', alignItems: 'center', gap: 12,
            fontFamily: FONT_MONO, fontSize: 10.5,
            zIndex: 4,
            color: t.textMid,
          }}>
            <Icon name="terminal" size={12} color={t.accent}/>
            <span style={{ color: t.text }}>log</span>
            <span style={{ color: t.textMute }}>·</span>
            {run ? (
              <span><span style={{ color: t.amber }}>[run]</span> step {run.stepIdx + 1}/{TOPO[scenarioId].length} · {TOPO[scenarioId][run.stepIdx]}</span>
            ) : (
              <span><span style={{ color: t.green }}>[ok]</span> graph idle · last run 2m ago</span>
            )}
            <div style={{ flex: 1 }}/>
            <span style={{ color: t.textMute }}>⌘K · search · double-click CLI · run ⏎</span>
          </div>
        </div>

        <PrototypeInspector t={t} selectedNode={selectedNode} scenario={scenario}/>
      </div>

      {/* Floating drag asset ghost */}
      {dragAsset && (
        <div style={{
          position: 'fixed', left: dragAsset.x - 90, top: dragAsset.y - 22,
          width: 180,
          background: t.panel,
          border: `1px dashed ${t.accent}`,
          borderRadius: 6,
          padding: '6px 8px',
          fontFamily: FONT_MONO, fontSize: 10.5, color: t.text,
          pointerEvents: 'none', zIndex: 9999,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <div style={{
            width: 18, height: 18, borderRadius: 3,
            background: PORT_COLORS[dragAsset.asset.kind] + '33',
            border: `1px solid ${PORT_COLORS[dragAsset.asset.kind]}66`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: PORT_COLORS[dragAsset.asset.kind],
          }}>
            <Icon name={dragAsset.asset.kind === 'image' ? 'image' : 'folder'} size={10}/>
          </div>
          <span>{dragAsset.asset.label}</span>
        </div>
      )}
    </div>
  );
}

window.PipelinePrototype = PipelinePrototype;
