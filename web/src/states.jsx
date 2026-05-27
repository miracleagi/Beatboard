// Static interaction-state snapshots.
//  - Drag connection in-flight
//  - Expanded CLI editor
//  - Error state

// A small canvas wrapper shared by all snapshots
const SnapCanvas = ({ t, w, h, children, caption }) => (
  <div style={{
    width: w, height: h,
    background: t.bg,
    backgroundImage: `radial-gradient(circle, ${t.grid} 1px, transparent 1px)`,
    backgroundSize: '24px 24px',
    position: 'relative',
    overflow: 'hidden',
    fontFamily: FONT_UI,
  }}>
    {children}
    {caption && (
      <div style={{
        position: 'absolute', bottom: 12, left: 12,
        padding: '4px 8px',
        background: t.bg2, border: `1px solid ${t.border}`,
        borderRadius: 4,
        color: t.textMid, fontFamily: FONT_MONO, fontSize: 10.5,
      }}>{caption}</div>
    )}
  </div>
);

// ---------- DRAG LINE IN PROGRESS ----------
function StateDragLine({ theme = 'dark' }) {
  const t = TOKENS[theme];
  const nodes = [
    {
      id: 'g0', title: 'Flux.1-dev', kind: 'gen', x: 40, y: 60, w: 220, badge: 'api · 4×',
      thumbs: [{ seed: 'a1' }, { seed: 'a2', chosen: true }, { seed: 'a3' }, { seed: 'a4' }],
      ports: [
        { kind: 'text', side: 'left', top: 56 },
        { kind: 'image', side: 'right', top: 58, label: '·1' },
        { kind: 'image', side: 'right', top: 80, label: '·2' },
        { kind: 'image', side: 'right', top: 102, label: '·3' },
        { kind: 'image', side: 'right', top: 124, label: '·4' },
      ],
      footer: { left: 'seed 2174', right: '3.2s' },
      state: 'done',
    },
    {
      id: 'cli', title: 'real-esrgan', kind: 'cli', x: 400, y: 200, w: 220, badge: 'cli · local',
      cli: {
        cmd: 'realesrgan-ncnn-vulkan',
        args: ['-i {in}', '-o {out}', '-n realesrgan-x4plus', '-s 4'],
      },
      ports: [
        { kind: 'image', side: 'left', top: 56 },
        { kind: 'image', side: 'right', top: 56 },
      ],
      footer: { left: 'awaiting input', right: 'idle' },
    },
  ];
  // dangling drag line from g0's port (out·2, right side) toward mouse
  const dragFrom = { x: 40 + 220, y: 60 + 80, kind: 'image', side: 'right' };
  const dragTo = { x: 400 + 6, y: 200 + 56, side: 'left' };
  return (
    <SnapCanvas t={t} w={'100%'} h={'100%'} caption="drag from a port → highlights compatible targets">
      {/* Floating hint near cursor */}
      <div style={{
        position: 'absolute', left: 420, top: 226, zIndex: 5,
        padding: '4px 8px',
        background: t.panel, border: `1px solid ${t.accent}`,
        borderRadius: 4,
        color: t.accent, fontFamily: FONT_MONO, fontSize: 10,
      }}>image → image</div>

      <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0, width: '100%', height: '100%' }}>
        <path d={edgePath('bezier', dragFrom, dragTo, 'h')}
          fill="none" stroke={t.accent} strokeWidth="1.8"
          strokeDasharray="4 3"
        />
        <circle cx={dragFrom.x} cy={dragFrom.y} r="5" fill={t.bg} stroke={t.accent} strokeWidth="1.6"/>
        <circle cx={dragTo.x} cy={dragTo.y} r="6" fill={t.accentBg} stroke={t.accent} strokeWidth="1.5">
          <animate attributeName="r" values="5;9;5" dur="1.4s" repeatCount="indefinite"/>
        </circle>
      </svg>

      {/* Render nodes; mark cli's port as compatible (animated halo via Port.animate) */}
      {nodes.map(n => (
        <Node key={n.id} t={t} node={{
          ...n,
          ports: n.ports.map((p, i) => {
            if (n.id === 'cli' && i === 0) return { ...p, label: '✓' };
            return p;
          }),
        }} previewStyle="hybrid" statusStyle="border"/>
      ))}
    </SnapCanvas>
  );
}

// ---------- EXPANDED CLI EDITOR ----------
function StateExpanded({ theme = 'dark' }) {
  const t = TOKENS[theme];
  const node = {
    id: 'cli', title: 'ffmpeg · compose', kind: 'cli', x: 100, y: 28, w: 380, badge: 'cli · local',
    cli: {
      cmd: 'ffmpeg',
      args: ['-i shot01.mp4', '-i shot02.mp4', '-i shot03.mp4', '-filter_complex xfade=dissolve', '-c:v libx264 -crf 18', '{out}.mp4'],
    },
    ports: [
      { kind: 'video', side: 'left', top: 36, label: 's1' },
      { kind: 'video', side: 'left', top: 60, label: 's2' },
      { kind: 'video', side: 'left', top: 84, label: 's3' },
      { kind: 'file', side: 'left', top: 108, label: 'aud' },
      { kind: 'video', side: 'right', top: 70 },
    ],
    footer: { left: 'watches 3 inputs', right: 'idle' },
  };
  return (
    <SnapCanvas t={t} w={'100%'} h={'100%'} caption="double-click → command template expands inline">
      <Node t={t} node={node} previewStyle="hybrid" statusStyle="border" expanded selected/>
    </SnapCanvas>
  );
}

// ---------- ERROR STATE ----------
function StateError({ theme = 'dark' }) {
  const t = TOKENS[theme];
  const errored = {
    id: 'cli', title: 'kling-1.6', kind: 'motion', x: 220, y: 90, w: 240, badge: 'api · 5s',
    thumbs: [{ seed: 'err', label: 'failed', status: undefined }],
    ports: [
      { kind: 'image', side: 'left', top: 36 },
      { kind: 'video', side: 'right', top: 50 },
    ],
    footer: { left: 'request 429', right: 'rate limited' },
    state: 'error',
  };
  return (
    <SnapCanvas t={t} w={'100%'} h={'100%'} caption="error halts downstream; one-click retry or fork to fallback">
      <Node t={t} node={errored} previewStyle="hybrid" statusStyle="border"/>

      {/* Inline error popover */}
      <div style={{
        position: 'absolute', left: 470, top: 84,
        width: 220,
        background: t.panel, border: `1px solid ${t.red}`,
        borderRadius: 6,
        padding: 10,
        fontFamily: FONT_UI, fontSize: 11,
        color: t.text,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
          color: t.red, fontWeight: 600,
        }}>
          <Icon name="close" size={11}/>
          <span>RATE_LIMIT · 429</span>
        </div>
        <div style={{ color: t.textMid, fontFamily: FONT_MONO, fontSize: 10.5, lineHeight: 1.5 }}>
          piapi.kling rejected after 3 retries.
          Suggest fallback or wait 38s.
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 5 }}>
          <button style={{
            flex: 1, padding: '5px 8px',
            background: t.red, color: t.bg, border: 0, borderRadius: 4,
            fontFamily: FONT_UI, fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}>Retry</button>
          <button style={{
            flex: 1, padding: '5px 8px',
            background: t.panel2, color: t.text, border: `1px solid ${t.border}`, borderRadius: 4,
            fontFamily: FONT_UI, fontSize: 11, cursor: 'pointer',
          }}>Use Wan 2.1</button>
        </div>
      </div>

      {/* Downstream queued node, dimmed */}
      <div style={{ opacity: 0.45 }}>
        <Node t={t} node={{
          id: 'ff', title: 'ffmpeg · compose', kind: 'cli', x: 470, y: 230, w: 220, badge: 'cli',
          cli: { cmd: 'ffmpeg', args: ['-i ...'] },
          ports: [
            { kind: 'video', side: 'left', top: 56, label: 's2' },
            { kind: 'video', side: 'right', top: 56 },
          ],
          footer: { left: 'waiting on s02', right: 'blocked' },
          state: 'queued',
        }} previewStyle="hybrid" statusStyle="border"/>
      </div>

      <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', width: '100%', height: '100%' }}>
        <path d={edgePath('bezier', { x: 220+240, y: 90+50 }, { x: 470, y: 230+56 }, 'h')}
          fill="none" stroke={t.red} strokeWidth="1.6" strokeDasharray="3 3" opacity="0.6"/>
      </svg>
    </SnapCanvas>
  );
}

window.StateDragLine = StateDragLine;
window.StateExpanded = StateExpanded;
window.StateError = StateError;
