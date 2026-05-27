// Shared design tokens, primitives, icons, placeholders.
// All four variations share this visual vocabulary.

const TOKENS = {
  dark: {
    bg: '#0f141c',
    bg2: '#0b0f16',
    panel: '#171f2b',
    panel2: '#1d2737',
    panelHi: '#222e42',
    border: '#283449',
    borderStrong: '#3a4a66',
    text: '#e3ebf5',
    textMid: '#9aa9c2',
    textMute: '#5f7396',
    accent: '#7fc8ff',
    accentBg: 'rgba(127,200,255,0.12)',
    accentBorder: 'rgba(127,200,255,0.45)',
    amber: '#f4c47a',
    amberBg: 'rgba(244,196,122,0.12)',
    green: '#8ed4a8',
    greenBg: 'rgba(142,212,168,0.12)',
    red: '#e5917a',
    grid: 'rgba(120,150,200,0.05)',
  },
  light: {
    bg: '#eef0f3',
    bg2: '#e4e7ec',
    panel: '#ffffff',
    panel2: '#f6f7f9',
    panelHi: '#eef1f5',
    border: '#d6dce5',
    borderStrong: '#aab4c4',
    text: '#1a2030',
    textMid: '#4b5872',
    textMute: '#7a8aa4',
    accent: '#2a6fb5',
    accentBg: 'rgba(42,111,181,0.10)',
    accentBorder: 'rgba(42,111,181,0.4)',
    amber: '#b07a26',
    amberBg: 'rgba(176,122,38,0.12)',
    green: '#3a8a5e',
    greenBg: 'rgba(58,138,94,0.12)',
    red: '#b3553a',
    grid: 'rgba(40,60,90,0.05)',
  },
};

const FONT_UI = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
const FONT_MONO = "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace";

// Inject Google Fonts once
if (typeof document !== 'undefined' && !document.getElementById('mg-fonts')) {
  const link = document.createElement('link');
  link.id = 'mg-fonts';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap';
  document.head.appendChild(link);
  const css = document.createElement('style');
  css.textContent = `
    .mg-scroll::-webkit-scrollbar{width:6px;height:6px}
    .mg-scroll::-webkit-scrollbar-thumb{background:#3a4a66;border-radius:3px}
    .mg-scroll::-webkit-scrollbar-track{background:transparent}
    .mg-btn{transition:background .12s, border-color .12s, color .12s}
    .mg-card{transition:box-shadow .15s, border-color .12s, transform .15s}
    .mg-card:hover{border-color:#3a4a66}
    .mg-tab{transition:background .12s, color .12s}
    @keyframes mg-pulse {0%,100%{opacity:.55}50%{opacity:1}}
    @keyframes mg-shimmer {0%{background-position:-200% 0}100%{background-position:200% 0}}
    @keyframes mg-spin {to{transform:rotate(360deg)}}
    @keyframes mg-dash {to{stroke-dashoffset:-20}}
    .mg-pulse{animation:mg-pulse 1.6s ease-in-out infinite}
    .mg-spin{animation:mg-spin 1s linear infinite}
  `;
  document.head.appendChild(css);
}

// ---------- ICONS (16px, stroke-based) ----------
const Icon = ({ name, size = 16, color = 'currentColor', stroke = 1.5 }) => {
  const c = { fill: 'none', stroke: color, strokeWidth: stroke, strokeLinecap: 'round', strokeLinejoin: 'round' };
  const paths = {
    plus: <><path d="M8 3v10M3 8h10" {...c}/></>,
    close: <><path d="M4 4l8 8M12 4l-8 8" {...c}/></>,
    play: <><path d="M5 3l8 5-8 5z" {...c} fill={color}/></>,
    pause: <><path d="M5 3v10M11 3v10" {...c}/></>,
    sparkle: <><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.5 4.5l1.5 1.5M10 10l1.5 1.5M4.5 11.5l1.5-1.5M10 6l1.5-1.5" {...c}/></>,
    image: <><rect x="2" y="3" width="12" height="10" rx="1.5" {...c}/><circle cx="6" cy="7" r="1.2" {...c}/><path d="M3 11l3-3 3 3 2-2 2 2" {...c}/></>,
    film: <><rect x="2" y="3" width="12" height="10" rx="1" {...c}/><path d="M2 6h12M2 10h12M5 3v10M11 3v10" {...c}/></>,
    layers: <><path d="M8 2l6 3-6 3-6-3z" {...c}/><path d="M2 8l6 3 6-3M2 11l6 3 6-3" {...c}/></>,
    grid: <><rect x="2.5" y="2.5" width="4" height="4" {...c}/><rect x="9.5" y="2.5" width="4" height="4" {...c}/><rect x="2.5" y="9.5" width="4" height="4" {...c}/><rect x="9.5" y="9.5" width="4" height="4" {...c}/></>,
    folder: <><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6L7.5 4.5h5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" {...c}/></>,
    cmd: <><path d="M5 5h6v6H5z" {...c}/><path d="M5 5V3.5A1.5 1.5 0 1 0 3.5 5zM11 5h1.5A1.5 1.5 0 1 0 11 3.5zM5 11v1.5A1.5 1.5 0 1 1 3.5 11zM11 11v1.5A1.5 1.5 0 1 0 12.5 11z" {...c}/></>,
    terminal: <><rect x="2" y="3" width="12" height="10" rx="1" {...c}/><path d="M5 6l2 2-2 2M9 10h3" {...c}/></>,
    settings: <><circle cx="8" cy="8" r="2" {...c}/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M3.3 12.7l1.4-1.4M11.3 4.7l1.4-1.4" {...c}/></>,
    chevDown: <><path d="M4 6l4 4 4-4" {...c}/></>,
    chevRight: <><path d="M6 4l4 4-4 4" {...c}/></>,
    chevLeft: <><path d="M10 4l-4 4 4 4" {...c}/></>,
    check: <><path d="M3 8l3 3 7-7" {...c}/></>,
    dots: <><circle cx="4" cy="8" r=".8" fill={color}/><circle cx="8" cy="8" r=".8" fill={color}/><circle cx="12" cy="8" r=".8" fill={color}/></>,
    seed: <><circle cx="8" cy="8" r="5" {...c}/><path d="M8 3v10M3 8h10" {...c}/></>,
    upscale: <><path d="M3 3h4M3 3v4M13 3h-4M13 3v4M3 13h4M3 13v-4M13 13h-4M13 13v-4" {...c}/></>,
    vary: <><circle cx="5" cy="5" r="2" {...c}/><circle cx="11" cy="5" r="2" {...c}/><circle cx="5" cy="11" r="2" {...c}/><circle cx="11" cy="11" r="2" {...c}/></>,
    branch: <><path d="M4 3v7a2 2 0 0 0 2 2h6" {...c}/><circle cx="4" cy="3" r="1.3" {...c}/><circle cx="12" cy="12" r="1.3" {...c}/></>,
    download: <><path d="M8 2v9M4 7l4 4 4-4M3 13h10" {...c}/></>,
    eye: <><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" {...c}/><circle cx="8" cy="8" r="2" {...c}/></>,
    motion: <><path d="M2 8h3l1-3 2 6 2-4 1 3h3" {...c}/></>,
    search: <><circle cx="7" cy="7" r="4" {...c}/><path d="M10 10l3 3" {...c}/></>,
    history: <><circle cx="8" cy="8" r="5.5" {...c}/><path d="M8 5v3l2 1.5" {...c}/></>,
    bolt: <><path d="M8 1l-4 8h3l-1 6 5-8h-3z" {...c}/></>,
    link: <><path d="M7 9a3 3 0 0 0 4 0l1.5-1.5a3 3 0 0 0-4-4L7.5 5M9 7a3 3 0 0 0-4 0L3.5 8.5a3 3 0 0 0 4 4L8.5 11" {...c}/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block', flex: 'none' }}>{paths[name]}</svg>;
};

// ---------- IMAGE PLACEHOLDER ----------
// Diagonal stripe pattern + mono label. Different "hues" via hash of seed.
function Placeholder({ label, seed = 'a', w, h, status, selected, dim, theme = 'dark', radius = 6, footer, badge, onClick }) {
  const t = TOKENS[theme];
  // hash seed → hue
  let s = 0; for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) | 0;
  const hue = Math.abs(s) % 360;
  const sat = theme === 'dark' ? 18 : 22;
  const light1 = theme === 'dark' ? 22 : 78;
  const light2 = theme === 'dark' ? 17 : 84;
  const stripe = theme === 'dark' ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.04)';
  const isRunning = status === 'running';
  const isQueued = status === 'queued';
  return (
    <div
      onClick={onClick}
      className="mg-card"
      style={{
        position: 'relative',
        width: w, height: h,
        borderRadius: radius,
        background: `linear-gradient(135deg, hsl(${hue} ${sat}% ${light1}%), hsl(${(hue+30)%360} ${sat}% ${light2}%))`,
        backgroundImage: `repeating-linear-gradient(45deg, ${stripe} 0 1px, transparent 1px 9px), linear-gradient(135deg, hsl(${hue} ${sat}% ${light1}%), hsl(${(hue+30)%360} ${sat}% ${light2}%))`,
        border: `1px solid ${selected ? t.accent : t.border}`,
        boxShadow: selected ? `0 0 0 1px ${t.accent}, 0 0 0 4px ${t.accentBg}` : 'none',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        opacity: dim ? 0.45 : 1,
        flex: 'none',
      }}
    >
      {/* label */}
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: theme === 'dark' ? 'rgba(227,235,245,0.42)' : 'rgba(26,32,48,0.42)',
        fontFamily: FONT_MONO, fontSize: 10.5, letterSpacing: 0.4,
      }}>
        [{label}]
      </div>

      {isRunning && (
        <div style={{
          position: 'absolute', inset: 0,
          background: `linear-gradient(110deg, transparent 30%, ${t.accentBg} 50%, transparent 70%)`,
          backgroundSize: '200% 100%',
          animation: 'mg-shimmer 1.8s linear infinite',
          mixBlendMode: 'screen',
        }}/>
      )}

      {isQueued && (
        <div style={{
          position: 'absolute', top: 6, left: 6,
          padding: '2px 6px', background: t.panel, border: `1px solid ${t.border}`,
          borderRadius: 4, color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5, letterSpacing: 0.4,
        }}>QUEUED</div>
      )}
      {isRunning && (
        <div style={{
          position: 'absolute', top: 6, left: 6, display: 'flex', alignItems: 'center', gap: 5,
          padding: '2px 6px 2px 5px', background: t.panel, border: `1px solid ${t.amberBg}`,
          borderRadius: 4, color: t.amber, fontFamily: FONT_MONO, fontSize: 9.5, letterSpacing: 0.4,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.amber }} className="mg-pulse"/>
          GENERATING
        </div>
      )}
      {badge}
      {footer && (
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          padding: '6px 8px',
          background: `linear-gradient(180deg, transparent, ${theme === 'dark' ? 'rgba(15,20,28,0.85)' : 'rgba(255,255,255,0.92)'})`,
          color: t.textMid, fontFamily: FONT_MONO, fontSize: 10,
          display: 'flex', justifyContent: 'space-between', alignItems: 'end', gap: 6,
        }}>
          {footer}
        </div>
      )}
    </div>
  );
}

// ---------- SMALL UI PRIMITIVES ----------
function Pill({ children, color, bg, border, mono = true, size = 'sm' }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: size === 'sm' ? '2px 6px' : '3px 8px',
      borderRadius: 3,
      background: bg || 'transparent',
      border: border ? `1px solid ${border}` : 'none',
      color: color,
      fontFamily: mono ? FONT_MONO : FONT_UI,
      fontSize: size === 'sm' ? 10 : 11,
      fontWeight: 500,
      letterSpacing: mono ? 0.3 : 0,
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function Btn({ children, primary, onClick, size = 'md', leftIcon, rightIcon, theme = 'dark', style = {} }) {
  const t = TOKENS[theme];
  const padV = size === 'sm' ? 4 : 6;
  const padH = size === 'sm' ? 8 : 12;
  return (
    <button
      onClick={onClick}
      className="mg-btn"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: `${padV}px ${padH}px`,
        background: primary ? t.accent : t.panel2,
        color: primary ? t.bg : t.text,
        border: `1px solid ${primary ? t.accent : t.border}`,
        borderRadius: 5,
        fontFamily: FONT_UI, fontSize: size === 'sm' ? 11 : 12,
        fontWeight: 500, cursor: 'pointer',
        ...style,
      }}
    >
      {leftIcon && <Icon name={leftIcon} size={13}/>}
      {children}
      {rightIcon && <Icon name={rightIcon} size={13}/>}
    </button>
  );
}

// ---------- APP LOGO MARK ----------
// Three-node triangle: evokes the letter "A" + the graph/pipeline concept.
function AtlasLogo({ size = 18, t }) {
  const accent = t?.accent || '#7fc8ff';
  const amber  = t?.amber  || '#f4c47a';
  // Node positions: top-centre, bottom-left, bottom-right
  const top = [10, 5];
  const bl  = [4.5, 15.5];
  const br  = [15.5, 15.5];
  const r   = 2;
  const lineProps = { stroke: 'rgba(255,255,255,0.70)', strokeWidth: 1.35, strokeLinecap: 'round' };
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" style={{ display: 'block', flex: 'none' }}>
      <defs>
        <linearGradient id="atlas-lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={accent}/>
          <stop offset="100%" stopColor={amber}/>
        </linearGradient>
      </defs>
      {/* Rounded-square background */}
      <rect width="20" height="20" rx="5" fill="url(#atlas-lg)"/>
      {/* Edges first (drawn beneath nodes) */}
      <line x1={top[0]} y1={top[1]+r} x2={bl[0]+r*0.6} y2={bl[1]-r} {...lineProps}/>
      <line x1={top[0]} y1={top[1]+r} x2={br[0]-r*0.6} y2={br[1]-r} {...lineProps}/>
      <line x1={bl[0]+r} y1={bl[1]} x2={br[0]-r} y2={br[1]} {...lineProps}/>
      {/* Nodes */}
      <circle cx={top[0]} cy={top[1]} r={r} fill="rgba(255,255,255,0.95)"/>
      <circle cx={bl[0]}  cy={bl[1]}  r={r} fill="rgba(255,255,255,0.95)"/>
      <circle cx={br[0]}  cy={br[1]}  r={r} fill="rgba(255,255,255,0.95)"/>
    </svg>
  );
}

// ---------- HEADER (shared across all variations) ----------
function AppHeader({ theme = 'dark', tabs, activeTab, onTabClick }) {
  const t = TOKENS[theme];
  return (
    <div style={{
      height: 40, flex: 'none',
      background: t.bg2,
      borderBottom: `1px solid ${t.border}`,
      display: 'flex', alignItems: 'stretch',
      fontFamily: FONT_UI,
      position: 'relative',
      zIndex: 5,
    }}>
      {/* App mark */}
      <div style={{
        width: 120, display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 14px', borderRight: `1px solid ${t.border}`,
      }}>
        <AtlasLogo size={18} t={t}/>
        <span style={{ color: t.text, fontSize: 12, fontWeight: 600, letterSpacing: -0.1 }}>Atlas</span>
        <span style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 9, marginLeft: 'auto' }}>v0.4</span>
      </div>

      {/* Project tabs */}
      <div style={{ display: 'flex', alignItems: 'stretch', flex: 1, minWidth: 0, overflow: 'hidden' }}>
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <div
              key={tab.id}
              onClick={() => onTabClick && onTabClick(tab.id)}
              className="mg-tab"
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '0 14px',
                borderRight: `1px solid ${t.border}`,
                background: active ? t.bg : 'transparent',
                color: active ? t.text : t.textMid,
                fontSize: 12,
                cursor: 'pointer',
                position: 'relative',
                minWidth: 0,
              }}
            >
              {active && <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, height: 2,
                background: t.accent,
              }}/>}
              <span style={{
                width: 8, height: 8, borderRadius: 2,
                background: tab.color || t.textMute,
                flex: 'none',
              }}/>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {tab.name}
              </span>
              <span style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 10 }}>{tab.count}</span>
              {active && <Icon name="close" size={11} color={t.textMute}/>}
            </div>
          );
        })}
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '0 10px',
          color: t.textMute,
          cursor: 'pointer',
        }}>
          <Icon name="plus" size={13}/>
        </div>
      </div>

      {/* Right side: queue indicator, user */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '0 14px',
        borderLeft: `1px solid ${t.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: t.textMid, fontSize: 11 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', background: t.amber,
          }} className="mg-pulse"/>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10.5 }}>3 running</span>
          <span style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 10.5 }}>· 7 queued</span>
        </div>
        <div style={{ width: 1, height: 16, background: t.border }}/>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 20, height: 20, borderRadius: '50%',
            background: `linear-gradient(135deg, ${t.accent}, ${t.amber})`,
          }}/>
        </div>
      </div>
    </div>
  );
}

// Expose to other Babel scripts
Object.assign(window, { TOKENS, FONT_UI, FONT_MONO, Icon, AtlasLogo, Placeholder, Pill, Btn, AppHeader });
