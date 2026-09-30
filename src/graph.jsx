// Parameterized node-graph renderer for the Pipeline study.
// Exposes building blocks that respond to design tweaks:
//   - cliStyle:        'terminal' | 'form' | 'hybrid'
//   - connectionStyle: 'bezier'   | 'ortho' | 'straight'
//   - previewStyle:    'thumb'    | 'text'  | 'hybrid'
//   - statusStyle:     'border'   | 'bar'   | 'ring'
//   - layout:          'h' (left→right) | 'v' (top→bottom)
//
// Plus interactive primitives: dragging a connection in flight,
// running animation hook, double-click-to-expand CLI editor.

// ---------- PORT TYPES ----------
const PORT_COLORS = {
  text:   '#c98ad9',
  image:  '#7fc8ff',
  video:  '#f4c47a',
  audio:  '#d7a6ff',
  number: '#8ed4a8',
  file:   '#9aa9c2',
  asset:  '#e5917a',
};

const PORT_LABEL = { text: 'txt', image: 'img', video: 'vid', audio: 'aud', number: 'num', file: 'file', asset: 'ast' };

// ---------- EDGE PATHS ----------
function edgePath(style, from, to, dir = 'h') {
  if (style === 'straight') {
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  }
  if (style === 'ortho') {
    // Manhattan path with a single elbow
    if (dir === 'h') {
      const mx = (from.x + to.x) / 2;
      return `M ${from.x} ${from.y} L ${mx} ${from.y} L ${mx} ${to.y} L ${to.x} ${to.y}`;
    } else {
      const my = (from.y + to.y) / 2;
      return `M ${from.x} ${from.y} L ${from.x} ${my} L ${to.x} ${my} L ${to.x} ${to.y}`;
    }
  }
  // bezier (default)
  if (dir === 'h') {
    const dx = Math.abs(to.x - from.x);
    const off = Math.max(40, dx * 0.5);
    return `M ${from.x} ${from.y} C ${from.x + off} ${from.y}, ${to.x - off} ${to.y}, ${to.x} ${to.y}`;
  } else {
    const dy = Math.abs(to.y - from.y);
    const off = Math.max(30, dy * 0.5);
    return `M ${from.x} ${from.y} C ${from.x} ${from.y + off}, ${to.x} ${to.y - off}, ${to.x} ${to.y}`;
  }
}

// ---------- STATUS INDICATORS ----------
const Status = ({ kind = 'border', t, state, progress = 0, color }) => {
  // state: 'idle' | 'queued' | 'running' | 'done' | 'error'
  const accent = color || (
    state === 'error' ? t.red :
    state === 'running' ? t.amber :
    state === 'done' ? t.green :
    state === 'queued' ? t.textMute :
    t.border
  );
  if (kind === 'bar') {
    return (
      <div style={{
        height: 2, background: t.border, position: 'relative',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          width: `${state === 'done' ? 100 : state === 'running' ? progress * 100 : 0}%`,
          background: accent,
          transition: 'width .25s linear',
        }}/>
        {state === 'running' && (
          <div style={{
            position: 'absolute', top: 0, bottom: 0,
            left: `${progress * 100 - 8}%`, width: 8,
            background: `linear-gradient(90deg, transparent, ${t.amber})`,
            opacity: 0.6,
          }}/>
        )}
      </div>
    );
  }
  if (kind === 'ring') {
    // Compact ring shown in the header right
    const size = 14;
    const r = 5.5;
    const C = 2 * Math.PI * r;
    const p = state === 'done' ? 1 : state === 'running' ? progress : 0;
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" style={{ display: 'block' }}>
        <circle cx="7" cy="7" r={r} fill="none" stroke={t.border} strokeWidth="1.5"/>
        <circle cx="7" cy="7" r={r} fill="none" stroke={accent} strokeWidth="1.5"
          strokeDasharray={`${C * p} ${C}`}
          strokeDashoffset={C * 0.25}
          transform="rotate(-90 7 7)"
          style={{ transition: 'stroke-dasharray .25s linear' }}
        />
        {state === 'done' && (
          <path d="M4 7l2 2 4-4" fill="none" stroke={accent} strokeWidth="1.5" strokeLinecap="round"/>
        )}
        {state === 'error' && (
          <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" fill="none" stroke={accent} strokeWidth="1.5" strokeLinecap="round"/>
        )}
      </svg>
    );
  }
  // border (returned as null; the Node component reads `state` and recolors its border directly)
  return null;
};

// ---------- PORT ----------
const Port = ({ t, kind, side, top, label, animate }) => (
  <div style={{
    position: 'absolute',
    [side]: -5,
    top: top - 5,
    display: 'flex', alignItems: 'center',
    flexDirection: side === 'left' ? 'row' : 'row-reverse',
    gap: 5,
    pointerEvents: 'none',
    zIndex: 2,
  }}>
    <div style={{
      width: 10, height: 10, borderRadius: '50%',
      background: PORT_COLORS[kind],
      border: `2px solid ${t.bg}`,
      boxShadow: `0 0 0 1px ${PORT_COLORS[kind]}${animate ? ', 0 0 0 4px ' + PORT_COLORS[kind] + '40' : ''}`,
    }} className={animate ? 'mg-pulse' : ''}/>
    {label && (
      <div style={{
        fontFamily: FONT_MONO, fontSize: 9, color: t.textMute, letterSpacing: 0.3,
      }}>{label}</div>
    )}
  </div>
);

// ---------- CLI BLOCKS (3 styles) ----------
const CliTerminal = ({ t, cmd, args = [], small }) => (
  <div style={{
    background: t.bg2,
    border: `1px solid ${t.border}`,
    borderRadius: 4,
    padding: small ? '6px 8px' : '8px 10px',
    fontFamily: FONT_MONO, fontSize: small ? 10 : 10.5,
    color: t.text, lineHeight: 1.55,
  }}>
    <div><span style={{ color: t.green }}>$</span> {cmd} <span style={{ color: t.textMute }}>\</span></div>
    {args.map((a, i) => (
      <div key={i} style={{ paddingLeft: 10, color: t.textMid }}>
        {a.split(' ').map((tok, j) => {
          if (tok.startsWith('{')) return <span key={j} style={{ color: t.accent }}>{tok} </span>;
          if (tok.match(/^-?\d+(\.\d+)?$/)) return <span key={j} style={{ color: t.amber }}>{tok} </span>;
          return <span key={j}>{tok} </span>;
        })} {i < args.length - 1 && <span style={{ color: t.textMute }}>\</span>}
      </div>
    ))}
  </div>
);

const CliForm = ({ t, cmd, fields = [] }) => (
  <div style={{
    background: t.bg2,
    border: `1px solid ${t.border}`,
    borderRadius: 4,
    overflow: 'hidden',
  }}>
    <div style={{
      padding: '5px 9px',
      background: t.panelHi,
      borderBottom: `1px solid ${t.border}`,
      fontFamily: FONT_MONO, fontSize: 10, color: t.amber,
      display: 'flex', alignItems: 'center', gap: 5,
    }}>
      <Icon name="terminal" size={10}/>
      {cmd}
    </div>
    {fields.map((f, i) => (
      <div key={i} style={{
        padding: '4px 9px',
        display: 'flex', alignItems: 'center', gap: 6,
        borderTop: i > 0 ? `1px solid ${t.border}` : 'none',
        fontFamily: FONT_MONO, fontSize: 10,
      }}>
        <span style={{ color: t.textMute, minWidth: 38 }}>{f.k}</span>
        <span style={{ color: t.text }}>{f.v}</span>
      </div>
    ))}
  </div>
);

const CliHybrid = ({ t, cmd, args = [], fields = [] }) => (
  <div style={{
    background: t.bg2,
    border: `1px solid ${t.border}`,
    borderRadius: 4,
    overflow: 'hidden',
  }}>
    <div style={{
      padding: '6px 9px',
      borderBottom: `1px solid ${t.border}`,
      fontFamily: FONT_MONO, fontSize: 10.5, color: t.text,
      display: 'flex', alignItems: 'center', gap: 4,
    }}>
      <span style={{ color: t.green }}>$</span>
      <span>{cmd}</span>
      <span style={{ color: t.textMute }}>{args.length} args</span>
    </div>
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0',
    }}>
      {fields.slice(0, 4).map((f, i) => (
        <div key={i} style={{
          padding: '4px 9px',
          borderTop: `1px solid ${t.border}`,
          borderLeft: i % 2 === 1 ? `1px solid ${t.border}` : 'none',
          fontFamily: FONT_MONO, fontSize: 9.5,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          <span style={{ color: t.textMute }}>{f.k}</span>
          <span style={{ color: t.text, marginLeft: 5 }}>{f.v}</span>
        </div>
      ))}
    </div>
  </div>
);

const CliBlock = (allProps) => {
  const { style } = allProps;
  const props = withoutKeys(allProps, ['style']);
  if (style === 'form') return <CliForm {...props}/>;
  if (style === 'hybrid') return <CliHybrid {...props}/>;
  return <CliTerminal {...props}/>;
};

// ---------- NODE PREVIEW (3 styles) ----------
const NodePreview = ({ t, style, kind, node }) => {
  // For gen nodes: show 2x2 or 1xN image thumbs; for cli: show command; for motion: video thumb; etc.
  // 'thumb' = images only, 'text' = text only, 'hybrid' = both.
  if (kind === 'cli') {
    if (style === 'text') return <CliBlock style="terminal" t={t} cmd={node.cli.cmd} args={node.cli.args}/>;
    if (style === 'thumb') return (
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <div style={{
          width: 28, height: 28, borderRadius: 4,
          background: t.bg2, border: `1px solid ${t.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: t.amber, flex: 'none',
        }}><Icon name="terminal" size={14}/></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            color: t.text, fontFamily: FONT_MONO, fontSize: 10.5,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{node.cli.cmd}</div>
          <div style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 9 }}>
            {node.cli.args.length} args · local
          </div>
        </div>
      </div>
    );
    return <CliBlock style="hybrid" t={t} cmd={node.cli.cmd} args={node.cli.args} fields={node.cli.fields || []}/>;
  }
  if (kind === 'prompt') {
    return (
      <div style={{
        fontFamily: FONT_MONO, fontSize: 11, color: t.text, lineHeight: 1.5,
      }}>
        {node.prompt.split(/(\*\*[^*]+\*\*)/).map((s, i) =>
          s.startsWith('**')
            ? <span key={i} style={{ color: t.accent }}>{s.slice(2, -2)}</span>
            : <span key={i}>{s}</span>
        )}
      </div>
    );
  }
  if (kind === 'gen' || kind === 'motion' || kind === 'select' || kind === 'asset' || kind === 'output') {
    const imgs = node.thumbs || [];
    if (style === 'text') {
      return (
        <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: t.textMid, lineHeight: 1.5 }}>
          <div style={{ color: t.text }}>{node.summary || `${imgs.length} output${imgs.length === 1 ? '' : 's'}`}</div>
          <div>{node.subSummary}</div>
        </div>
      );
    }
    if (imgs.length === 0) return null;
    if (imgs.length === 1) {
      const im = imgs[0];
      return (
        <Placeholder
          theme="dark" w={'100%'} h={style === 'hybrid' ? 60 : 76}
          label={im.label} seed={im.seed}
          radius={3} selected={im.chosen}
          status={im.status}
        />
      );
    }
    // multi
    const cols = imgs.length === 2 ? 2 : imgs.length <= 4 ? 2 : 3;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 4 }}>
        {imgs.map((im, i) => (
          <Placeholder
            key={i}
            theme="dark" w={'100%'} h={style === 'hybrid' ? 36 : 44}
            label="" seed={im.seed}
            radius={3} selected={im.chosen}
            status={im.status}
          />
        ))}
      </div>
    );
  }
  return null;
};

// ---------- NODE ----------
const Node = ({
  t, node, selected, expanded,
  cliStyle = 'hybrid', previewStyle = 'hybrid', statusStyle = 'border',
  onSelect, onExpand, onPortDown,
}) => {
  const headerColor = {
    prompt: t.accent, gen: t.accent, cli: t.amber, motion: t.amber,
    select: t.green, output: t.green, asset: PORT_COLORS.asset, error: t.red,
  }[node.kind] || t.accent;

  const state = node.state || 'idle';
  const isRunning = state === 'running';
  const isError = state === 'error';
  const isDone = state === 'done';

  // border color from state if statusStyle is 'border'
  let borderColor = t.border;
  if (selected) borderColor = t.accent;
  else if (statusStyle === 'border') {
    if (isError) borderColor = t.red;
    else if (isRunning) borderColor = t.amber;
    else if (isDone) borderColor = t.green;
    else if (state === 'queued') borderColor = t.textMute;
  }

  const eff = expanded || node.expanded;

  return (
    <div
      onClick={(e) => { e.stopPropagation(); onSelect && onSelect(node.id); }}
      onDoubleClick={() => onExpand && onExpand(node.id)}
      style={{
        position: 'absolute', left: node.x, top: node.y, width: node.w,
        background: t.panel,
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        boxShadow: selected
          ? `0 0 0 1px ${t.accent}, 0 8px 24px rgba(0,0,0,0.5)`
          : isRunning
            ? `0 0 0 1px ${t.amber}55, 0 8px 20px rgba(0,0,0,0.4)`
            : '0 4px 14px rgba(0,0,0,0.3)',
        fontFamily: FONT_UI,
        cursor: 'pointer',
        zIndex: selected ? 3 : (isRunning ? 2 : 1),
        transition: 'box-shadow .15s, border-color .15s',
      }}
    >
      {/* Status bar (top) */}
      {statusStyle === 'bar' && (
        <Status kind="bar" t={t} state={state} progress={node.progress || 0}/>
      )}

      {/* Header */}
      <div style={{
        padding: '7px 10px',
        display: 'flex', alignItems: 'center', gap: 6,
        borderBottom: `1px solid ${t.border}`,
        background: t.panel2,
        borderRadius: statusStyle === 'bar' ? '0' : '7px 7px 0 0',
      }}>
        <div style={{
          width: 6, height: 6, borderRadius: 2, background: headerColor,
        }}/>
        <span style={{ color: t.text, fontSize: 11.5, fontWeight: 600 }}>{node.title}</span>
        {node.badge && (
          <Pill bg={t.bg2} color={t.textMute} border={t.border}>{node.badge}</Pill>
        )}
        <div style={{ flex: 1 }}/>
        {statusStyle === 'ring' && (
          <Status kind="ring" t={t} state={state} progress={node.progress || 0}/>
        )}
        {statusStyle !== 'ring' && state === 'running' && (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.amber }} className="mg-pulse"/>
        )}
        {statusStyle !== 'ring' && state === 'done' && (
          <Icon name="check" size={11} color={t.green}/>
        )}
        {statusStyle !== 'ring' && isError && (
          <Icon name="close" size={11} color={t.red}/>
        )}
      </div>

      {/* Body */}
      <div style={{ padding: node.kind === 'asset' ? 6 : 10 }}>
        <NodePreview t={t} style={previewStyle} kind={node.kind} node={node}/>
      </div>

      {/* Expanded CLI editor */}
      {eff && node.kind === 'cli' && (
        <div style={{
          borderTop: `1px solid ${t.border}`,
          background: t.bg2,
          padding: '10px 12px',
        }}>
          <div style={{
            color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
            letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6,
          }}>Command template</div>
          <div style={{
            background: t.bg, border: `1px solid ${t.border}`, borderRadius: 4,
            padding: '8px 10px',
            fontFamily: FONT_MONO, fontSize: 11, color: t.text,
            lineHeight: 1.55,
          }}>
            <div><span style={{ color: t.green }}>$</span> {node.cli.cmd}</div>
            {node.cli.args.map((a, i) => (
              <div key={i} style={{ paddingLeft: 10, color: t.textMid }}>
                {a}
              </div>
            ))}
          </div>
          <div style={{
            marginTop: 8, display: 'flex', gap: 6,
            color: t.textMute, fontFamily: FONT_MONO, fontSize: 10,
          }}>
            <span>watches: {(node.ports || []).filter(p => p.side === 'left').length} inputs</span>
            <span>·</span>
            <span style={{ color: t.green }}>✓ binary found</span>
          </div>
        </div>
      )}

      {/* Footer */}
      {node.footer && (
        <div style={{
          padding: '5px 10px',
          borderTop: `1px solid ${t.border}`,
          color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: t.bg2,
          borderRadius: '0 0 7px 7px',
        }}>
          <span>{node.footer.left}</span>
          <span style={{
            color: state === 'running' ? t.amber : state === 'done' ? t.green : isError ? t.red : t.textMute,
          }}>{node.footer.right}</span>
        </div>
      )}

      {/* Ports */}
      {(node.ports || []).map((p, i) => (
        <Port key={i} t={t} {...p}
          animate={node.state === 'done' && p.side === 'right'}
        />
      ))}
    </div>
  );
};

// ---------- EDGES ----------
const Edges = ({ t, edges, nodes, connectionStyle = 'bezier', layout = 'h', dragLine }) => {
  // Resolve port positions by looking up nodes
  const portPoint = (nodeId, portIdx) => {
    const n = nodes.find(x => x.id === nodeId);
    if (!n) return null;
    const p = (n.ports || [])[portIdx];
    if (!p) return null;
    return {
      x: n.x + (p.side === 'left' ? 0 : n.w),
      y: n.y + p.top,
      side: p.side,
      kind: p.kind,
    };
  };

  return (
    <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0, width: '100%', height: '100%' }}>
      {edges.map((e, i) => {
        const f = portPoint(e.from.node, e.from.port);
        const u = portPoint(e.to.node, e.to.port);
        if (!f || !u) return null;
        const c = e.color || PORT_COLORS[f.kind] || t.accent;
        return (
          <g key={i}>
            <path d={edgePath(connectionStyle, f, u, layout)}
              fill="none" stroke={c} strokeWidth="1.6" opacity="0.78"
              strokeDasharray={e.dashed ? '4 3' : 'none'}
            />
            {e.running && (
              <path d={edgePath(connectionStyle, f, u, layout)}
                fill="none" stroke={t.amber} strokeWidth="2" opacity="1"
                strokeDasharray="3 7"
                style={{ animation: 'mg-dash 0.7s linear infinite' }}
              />
            )}
          </g>
        );
      })}
      {dragLine && (
        <g>
          <path d={edgePath(connectionStyle, dragLine.from, dragLine.to, layout)}
            fill="none" stroke={t.accent} strokeWidth="1.6"
            strokeDasharray="4 3"
          />
          <circle cx={dragLine.to.x} cy={dragLine.to.y} r="4"
            fill={t.bg} stroke={t.accent} strokeWidth="1.5"/>
        </g>
      )}
    </svg>
  );
};

// Add dash animation CSS once
if (typeof document !== 'undefined' && !document.getElementById('mg-graph-css')) {
  const s = document.createElement('style');
  s.id = 'mg-graph-css';
  s.textContent = `
    @keyframes mg-dash { to { stroke-dashoffset: -20; } }
  `;
  document.head.appendChild(s);
}

Object.assign(window, {
  PORT_COLORS, PORT_LABEL, edgePath,
  Status, Port, CliBlock, CliTerminal, CliForm, CliHybrid,
  NodePreview, Node, Edges,
});
