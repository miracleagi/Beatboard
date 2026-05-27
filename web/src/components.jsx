// Component artboards: anatomy + side-by-side variant comparisons.

const COMP_CANVAS = (t) => ({
  background: t.bg,
  backgroundImage: `radial-gradient(circle, ${t.grid} 1px, transparent 1px)`,
  backgroundSize: '24px 24px',
});

function VariantSlot({ t, title, subtitle, children }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      flex: 1, minWidth: 0,
      padding: '14px 16px',
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        marginBottom: 14, color: t.text,
      }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
        {subtitle && <span style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 10.5 }}>{subtitle}</span>}
      </div>
      <div style={{
        flex: 1, position: 'relative',
        background: COMP_CANVAS(t).background,
        backgroundImage: COMP_CANVAS(t).backgroundImage,
        backgroundSize: COMP_CANVAS(t).backgroundSize,
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        padding: 16,
        overflow: 'hidden',
      }}>
        {children}
      </div>
    </div>
  );
}

// ---------- NODE ANATOMY ----------
function NodeAnatomy({ theme = 'dark' }) {
  const t = TOKENS[theme];
  const node = {
    id: 'demo', title: 'real-esrgan', kind: 'cli', x: 180, y: 110, w: 240, badge: 'cli · local',
    cli: {
      cmd: 'realesrgan-ncnn-vulkan',
      args: ['-i {in}', '-o {out}', '-n realesrgan-x4plus', '-s 4'],
      fields: [
        { k: 'in', v: '{pick.out}' }, { k: 'out', v: '4k/' },
        { k: 'model', v: 'x4plus' }, { k: 's', v: '4' },
      ],
    },
    ports: [
      { kind: 'image', side: 'left', top: 56 },
      { kind: 'image', side: 'right', top: 56 },
    ],
    footer: { left: '~/bin/realesrgan', right: '12.4s' },
    state: 'running', progress: 0.45,
  };

  const calls = [
    { x: 30, y: 100, dx: 145, label: 'kind dot', detail: 'amber = cli\nblue = api\ngreen = output' },
    { x: 30, y: 145, dx: 145, label: 'title + badge', detail: 'node name · runtime tags' },
    { x: 30, y: 220, dx: 145, label: 'command + args', detail: '{} = port-bound var\nyellow = literal' },
    { x: 460, y: 100, dx: -25, label: 'status (right)', detail: 'idle / queued / run /\ndone / error' },
    { x: 460, y: 165, dx: -10, label: 'output ports', detail: 'colored by type\ndrag → connect' },
    { x: 30, y: 320, dx: 145, label: 'footer', detail: 'env path · elapsed' },
    { x: 460, y: 290, dx: -25, label: 'border state', detail: 'border = current\nphase color' },
  ];

  return (
    <div style={{
      width: '100%', height: '100%',
      position: 'relative',
      ...COMP_CANVAS(t),
      fontFamily: FONT_UI,
    }}>
      <Node t={t} node={node} cliStyle="hybrid" previewStyle="hybrid" statusStyle="border" selected/>

      {/* Callouts */}
      {calls.map((c, i) => (
        <React.Fragment key={i}>
          <div style={{
            position: 'absolute', left: c.x, top: c.y,
            width: 130,
            color: t.text, fontSize: 11.5, fontWeight: 600,
            textAlign: c.dx > 0 ? 'right' : 'left',
          }}>
            {c.label}
            <div style={{
              marginTop: 2, color: t.textMute, fontFamily: FONT_MONO,
              fontSize: 10, fontWeight: 400, lineHeight: 1.5,
              whiteSpace: 'pre',
            }}>{c.detail}</div>
          </div>
          <svg style={{
            position: 'absolute',
            left: Math.min(c.x + (c.dx > 0 ? 130 : 0), c.x + (c.dx > 0 ? 130 : 0) + c.dx),
            top: c.y + 8,
            width: Math.abs(c.dx),
            height: 1,
            overflow: 'visible',
          }}>
            <line x1="0" y1="0" x2={Math.abs(c.dx)} y2="0" stroke={t.borderStrong} strokeWidth="1" strokeDasharray="2 2"/>
            <circle cx={c.dx > 0 ? Math.abs(c.dx) : 0} cy="0" r="2" fill={t.accent}/>
          </svg>
        </React.Fragment>
      ))}

      {/* legend */}
      <div style={{
        position: 'absolute', bottom: 16, left: 16,
        padding: '8px 12px',
        background: t.panel, border: `1px solid ${t.border}`,
        borderRadius: 5,
        display: 'flex', gap: 12, alignItems: 'center',
        fontFamily: FONT_MONO, fontSize: 10, color: t.textMid,
      }}>
        <span style={{ color: t.textMute, letterSpacing: 0.4 }}>PORT TYPES</span>
        {Object.entries(PORT_COLORS).map(([k, v]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: v }}/>
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------- CLI VARIANT ROW ----------
function CliStyleRow({ theme = 'dark' }) {
  const t = TOKENS[theme];
  const base = {
    id: 'demo', title: 'real-esrgan', kind: 'cli', y: 22, w: 220, badge: 'cli · local',
    cli: {
      cmd: 'realesrgan-ncnn-vulkan',
      args: ['-i {in}', '-o {out}', '-n realesrgan-x4plus', '-s 4'],
      fields: [
        { k: 'in', v: '{pick.out}' }, { k: 'out', v: '4k/' },
        { k: 'model', v: 'x4plus' }, { k: 's', v: '4' },
      ],
    },
    ports: [
      { kind: 'image', side: 'left', top: 56 },
      { kind: 'image', side: 'right', top: 56 },
    ],
    footer: { left: '~/bin/realesrgan', right: '12.4s' },
    state: 'done', progress: 1,
  };
  const variants = [
    { style: 'terminal', label: 'Terminal',
      subtitle: 'reads like a script · max literal',
    },
    { style: 'form', label: 'Form',
      subtitle: 'fielded · easiest to skim',
    },
    { style: 'hybrid', label: 'Hybrid',
      subtitle: 'cmd headline + fields below',
    },
  ];
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', background: t.bg2 }}>
      {variants.map(v => (
        <VariantSlot key={v.style} t={t} title={v.label} subtitle={v.subtitle}>
          <Node t={t} node={{ ...base, x: 24 }} cliStyle={v.style} previewStyle={v.style === 'terminal' ? 'text' : v.style === 'form' ? 'text' : 'hybrid'} statusStyle="border"/>
          {v.style === 'hybrid' && (
            <div style={{
              position: 'absolute', bottom: 12, right: 12,
              padding: '2px 6px',
              background: t.accentBg, border: `1px solid ${t.accentBorder}`, borderRadius: 3,
              color: t.accent, fontFamily: FONT_MONO, fontSize: 9.5, fontWeight: 600,
            }}>RECOMMENDED</div>
          )}
        </VariantSlot>
      ))}
    </div>
  );
}

// ---------- CONNECTION STYLE ROW ----------
function ConnectionStyleRow({ theme = 'dark' }) {
  const t = TOKENS[theme];
  // Two stub nodes per slot, connected
  const drawStub = (id, x, y, side, kind) => ({
    id, title: id, kind: 'gen', x, y, w: 86,
    summary: '', ports: [{ kind, side, top: 30 }],
  });
  const variants = [
    { style: 'bezier', label: 'Bezier', subtitle: 'organic · default · spatial' },
    { style: 'ortho',  label: 'Orthogonal', subtitle: 'grid-aligned · diagram-like' },
    { style: 'straight', label: 'Straight', subtitle: 'pure data · most minimal' },
  ];
  const A = { x: 24, y: 30 };
  const B = { x: 200, y: 130 };
  const fromPt = { x: A.x + 86, y: A.y + 30 };
  const toPt = { x: B.x, y: B.y + 30 };
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', background: t.bg2 }}>
      {variants.map(v => (
        <VariantSlot key={v.style} t={t} title={v.label} subtitle={v.subtitle}>
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            <path d={edgePath(v.style, fromPt, toPt, 'h')}
              fill="none" stroke={PORT_COLORS.image} strokeWidth="1.8" opacity="0.85"/>
          </svg>
          {/* Stub A */}
          <div style={{
            position: 'absolute', left: A.x, top: A.y, width: 86, height: 60,
            background: t.panel, border: `1px solid ${t.border}`, borderRadius: 6,
            color: t.text, fontFamily: FONT_MONO, fontSize: 10.5,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>flux</div>
          <Port t={t} kind="image" side="right" top={30 + A.y - A.y} />
          {/* manual port dot for stubs */}
          <div style={{ position: 'absolute', left: A.x + 86 - 5, top: A.y + 30 - 5,
            width: 10, height: 10, borderRadius: '50%', background: PORT_COLORS.image,
            border: `2px solid ${t.bg2}`, boxShadow: `0 0 0 1px ${PORT_COLORS.image}` }}/>
          {/* Stub B */}
          <div style={{
            position: 'absolute', left: B.x, top: B.y, width: 86, height: 60,
            background: t.panel, border: `1px solid ${t.border}`, borderRadius: 6,
            color: t.text, fontFamily: FONT_MONO, fontSize: 10.5,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>upscale</div>
          <div style={{ position: 'absolute', left: B.x - 5, top: B.y + 30 - 5,
            width: 10, height: 10, borderRadius: '50%', background: PORT_COLORS.image,
            border: `2px solid ${t.bg2}`, boxShadow: `0 0 0 1px ${PORT_COLORS.image}` }}/>
        </VariantSlot>
      ))}
    </div>
  );
}

// ---------- PREVIEW STYLE ROW ----------
function PreviewStyleRow({ theme = 'dark' }) {
  const t = TOKENS[theme];
  const base = {
    id: 'demo', title: 'Flux.1-dev', kind: 'gen', y: 22, w: 220, badge: 'api · 4×',
    thumbs: [{ seed: 'a1' }, { seed: 'a2', chosen: true }, { seed: 'a3' }, { seed: 'a4' }],
    summary: '4 outputs · pick #2',
    subSummary: '1024² · 3.2s ea',
    ports: [
      { kind: 'text', side: 'left', top: 36 },
      { kind: 'image', side: 'right', top: 60, label: '·1' },
      { kind: 'image', side: 'right', top: 84, label: '·2' },
      { kind: 'image', side: 'right', top: 108, label: '·3' },
      { kind: 'image', side: 'right', top: 132, label: '·4' },
    ],
    footer: { left: 'seed 2174', right: '★ 2' },
    state: 'done',
  };
  const variants = [
    { style: 'thumb', label: 'Thumbnail', subtitle: 'visual · scan by image' },
    { style: 'text', label: 'Text', subtitle: 'dense · scan by name/seed' },
    { style: 'hybrid', label: 'Hybrid', subtitle: 'compact image + counts' },
  ];
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', background: t.bg2 }}>
      {variants.map(v => (
        <VariantSlot key={v.style} t={t} title={v.label} subtitle={v.subtitle}>
          <Node t={t} node={{ ...base, x: 24 }} previewStyle={v.style} statusStyle="border"/>
        </VariantSlot>
      ))}
    </div>
  );
}

// ---------- STATUS INDICATOR ROW ----------
function StatusStyleRow({ theme = 'dark' }) {
  const t = TOKENS[theme];
  const base = {
    id: 'demo', title: 'kling-1.6', kind: 'motion', y: 22, w: 220, badge: 'img→vid · 5s',
    thumbs: [{ seed: 'kk' }],
    ports: [
      { kind: 'image', side: 'left', top: 36 },
      { kind: 'video', side: 'right', top: 50 },
    ],
    footer: { left: 'dolly forward', right: '01:18' },
    state: 'running', progress: 0.55,
  };
  const variants = [
    { style: 'border', label: 'Border tint', subtitle: 'subtle · always-on glance' },
    { style: 'bar', label: 'Top bar', subtitle: 'progress-first · loud' },
    { style: 'ring', label: 'Header ring', subtitle: 'compact · works at small scale' },
  ];
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', background: t.bg2 }}>
      {variants.map(v => (
        <VariantSlot key={v.style} t={t} title={v.label} subtitle={v.subtitle}>
          <Node t={t} node={{ ...base, x: 24 }} previewStyle="hybrid" statusStyle={v.style}/>
        </VariantSlot>
      ))}
    </div>
  );
}

// ---------- LAYOUT (HORIZONTAL VS VERTICAL) ----------
function LayoutComparison({ theme = 'dark' }) {
  const t = TOKENS[theme];

  // Tiny 4-node chain used twice
  const chain = (orient) => {
    const isH = orient === 'h';
    const positions = isH
      ? [{x:8,y:60},{x:122,y:30},{x:236,y:60},{x:350,y:30}]
      : [{x:80,y:14},{x:180,y:104},{x:80,y:194},{x:180,y:284}];
    const nodes = positions.map((p, i) => ({
      id: `n${i}`, kind: ['prompt','gen','cli','output'][i],
      title: ['prompt','flux','real-esrgan','out.png'][i],
      badge: '',
      x: p.x, y: p.y, w: isH ? 110 : 130,
      thumbs: i === 1 ? [{seed:'h1'},{seed:'h2',chosen:true},{seed:'h3'},{seed:'h4'}] : (i === 3 ? [{seed:'h2'}] : undefined),
      cli: i === 2 ? { cmd: 'realesrgan', args: ['-s 4'] } : undefined,
      prompt: i === 0 ? '**neon** alley' : undefined,
      ports: i === 0 ? [{kind:'text', side: isH?'right':'bottom', top: isH?28:undefined}]
        : i === 3 ? [{kind:'image', side: isH?'left':'top', top: isH?28:undefined}]
        : [{kind: i===1?'text':'image', side: isH?'left':'top', top: isH?28:undefined},
           {kind: 'image', side: isH?'right':'bottom', top: isH?28:undefined}],
      state: i < 2 ? 'done' : i === 2 ? 'running' : 'queued', progress: i === 2 ? 0.6 : 0,
    }));
    // Stubbed simple boxes (Node component uses left/right ports; for vertical we just draw stub boxes)
    return { nodes, isH };
  };

  const renderStub = (n, isH) => (
    <div key={n.id} style={{
      position: 'absolute', left: n.x, top: n.y, width: n.w,
      background: t.panel, border: `1px solid ${n.state === 'running' ? t.amber : n.state === 'done' ? t.green : t.border}`,
      borderRadius: 6,
      padding: '7px 8px', fontFamily: FONT_UI, fontSize: 11,
      color: t.text,
      boxShadow: n.state === 'running' ? `0 0 0 1px ${t.amber}55` : 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
        <div style={{ width: 5, height: 5, borderRadius: 1.5,
          background: n.kind === 'cli' ? t.amber : n.kind === 'output' ? t.green : t.accent }}/>
        <span style={{ fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.title}</span>
      </div>
      <div style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5 }}>
        {n.kind === 'cli' ? 'cli · local' : n.kind === 'output' ? 'output' : n.kind === 'gen' ? 'api · 4×' : 'text'}
      </div>
    </div>
  );

  const Hslot = () => {
    const c = chain('h');
    return (
      <VariantSlot t={t} title="Horizontal flow" subtitle="left → right · reads like a pipeline">
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {c.nodes.slice(0, -1).map((n, i) => {
            const next = c.nodes[i+1];
            const from = { x: n.x + n.w, y: n.y + 28 };
            const to = { x: next.x, y: next.y + 28 };
            return <path key={i} d={edgePath('bezier', from, to, 'h')}
              fill="none" stroke={PORT_COLORS.image} strokeWidth="1.5" opacity="0.7"/>;
          })}
        </svg>
        {c.nodes.map(n => renderStub(n, true))}
      </VariantSlot>
    );
  };
  const Vslot = () => {
    const c = chain('v');
    return (
      <VariantSlot t={t} title="Vertical flow" subtitle="top → bottom · reads like a recipe">
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {c.nodes.slice(0, -1).map((n, i) => {
            const next = c.nodes[i+1];
            const from = { x: n.x + n.w/2, y: n.y + 56 };
            const to = { x: next.x + next.w/2, y: next.y };
            return <path key={i} d={edgePath('bezier', from, to, 'v')}
              fill="none" stroke={PORT_COLORS.image} strokeWidth="1.5" opacity="0.7"/>;
          })}
        </svg>
        {c.nodes.map(n => renderStub(n, false))}
      </VariantSlot>
    );
  };

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', background: t.bg2 }}>
      <Hslot/>
      <Vslot/>
    </div>
  );
}

window.NodeAnatomy = NodeAnatomy;
window.CliStyleRow = CliStyleRow;
window.ConnectionStyleRow = ConnectionStyleRow;
window.PreviewStyleRow = PreviewStyleRow;
window.StatusStyleRow = StatusStyleRow;
window.LayoutComparison = LayoutComparison;
