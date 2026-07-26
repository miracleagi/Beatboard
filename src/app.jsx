// Main app — DesignCanvas layout + Tweaks panel.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "cliStyle": "hybrid",
  "connectionStyle": "bezier",
  "previewStyle": "hybrid",
  "statusStyle": "border"
}/*EDITMODE-END*/;

// A bare-chrome static graph used inside the Scenarios section. No app header,
// no sidebars — just the canvas + nodes + edges so you can take in the whole
// shape at a glance. The interactive version at the top of the doc carries
// the full chrome.
function MiniGraph({ scenario, theme = 'dark', height = 460, cliStyle, connectionStyle, previewStyle, statusStyle, scale = 0.62 }) {
  const t = TOKENS[theme];

  // Compute graph bounding box for centered framing
  const bounds = React.useMemo(() => {
    let maxX = 0, maxY = 0;
    scenario.nodes.forEach(n => {
      maxX = Math.max(maxX, n.x + n.w);
      // Approximate node height: header + body
      maxY = Math.max(maxY, n.y + 200);
    });
    return { maxX: maxX + 60, maxY: maxY + 30 };
  }, [scenario]);

  return (
    <div style={{
      width: '100%', height,
      background: t.bg,
      backgroundImage: `radial-gradient(circle, ${t.grid} 1px, transparent 1px)`,
      backgroundSize: '24px 24px',
      position: 'relative',
      overflow: 'hidden',
      fontFamily: FONT_UI,
    }}>
      {/* Scenario name plate */}
      <div style={{
        position: 'absolute', top: 14, left: 14, zIndex: 5,
        padding: '6px 10px',
        background: t.panel, border: `1px solid ${t.border}`, borderRadius: 5,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <Icon name="layers" size={12} color={t.accent}/>
        <span style={{ color: t.text, fontSize: 12, fontWeight: 600 }}>{scenario.name}</span>
        <span style={{ color: t.textMute, fontFamily: FONT_MONO, fontSize: 10 }}>{scenario.nodes.length}n · {scenario.edges.length}e</span>
      </div>
      <div style={{
        position: 'absolute', top: 14, right: 14, zIndex: 5,
        color: t.textMute, fontFamily: FONT_MONO, fontSize: 10.5,
      }}>{scenario.desc}</div>

      {/* Scaled graph wrapper */}
      <div style={{
        position: 'absolute',
        left: '50%', top: '50%',
        width: bounds.maxX, height: bounds.maxY,
        transform: `translate(-50%, -50%) scale(${scale})`,
        transformOrigin: 'center center',
      }}>
        <Edges t={t} edges={scenario.edges} nodes={scenario.nodes}
          connectionStyle={connectionStyle} layout={scenario.layout}/>
        {scenario.nodes.map(n => (
          <Node key={n.id} t={t} node={n}
            cliStyle={cliStyle} previewStyle={previewStyle} statusStyle={statusStyle}
          />
        ))}
      </div>
    </div>
  );
}

function App() {
  const [tw, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const { theme, cliStyle, connectionStyle, previewStyle, statusStyle } = tw;
  const t = TOKENS[theme];

  // Section header utility
  const Note = ({ children }) => (
    <div style={{
      maxWidth: 760,
      color: '#5a4a2a',
      fontFamily: '-apple-system, system-ui, sans-serif',
      fontSize: 12.5, lineHeight: 1.55,
      padding: '0 4px',
    }}>{children}</div>
  );

  return (
    <>
      <DesignCanvas>
        <DCSection
          id="prototype"
          title="Beatboard · canvas — interactive prototype"
          subtitle="Drag asset chips from the left tray onto the canvas. Click any node to inspect. Double-click a CLI node to expand its command editor. Hit Run graph to watch progress sweep through."
        >
          <DCArtboard id="proto-main" label="Main · 1440 × 900 · interactive" width={1440} height={900}>
            <PipelinePrototype
              theme={theme}
              cliStyle={cliStyle}
              connectionStyle={connectionStyle}
              previewStyle={previewStyle}
              statusStyle={statusStyle}
              initialScenario="assembly"
            />
          </DCArtboard>
        </DCSection>

        <DCSection
          id="scenarios"
          title="Scenarios"
          subtitle="The same graph primitives compose into very different shapes. Three reference flows users would actually build."
        >
          <DCArtboard id="sc-iterate" label="Single image iteration · linear + side-branch" width={920} height={580}>
            <MiniGraph scenario={SCENARIO_ITERATE} theme={theme}
              cliStyle={cliStyle} connectionStyle={connectionStyle}
              previewStyle={previewStyle} statusStyle={statusStyle}
              height={580} scale={0.72}/>
          </DCArtboard>
          <DCArtboard id="sc-batch" label="Batch · fan-out, score with CLI, fan-in" width={920} height={580}>
            <MiniGraph scenario={SCENARIO_BATCH} theme={theme}
              cliStyle={cliStyle} connectionStyle={connectionStyle}
              previewStyle={previewStyle} statusStyle={statusStyle}
              height={580} scale={0.62}/>
          </DCArtboard>
          <DCArtboard id="sc-assembly" label="Full film · three shot chains converge into ffmpeg" width={1200} height={680}>
            <MiniGraph scenario={SCENARIO_ASSEMBLY} theme={theme}
              cliStyle={cliStyle} connectionStyle={connectionStyle}
              previewStyle={previewStyle} statusStyle={statusStyle}
              height={680} scale={0.62}/>
          </DCArtboard>
        </DCSection>

        <DCSection
          id="states"
          title="Interaction states"
          subtitle="Edge cases that have to feel good — connecting in flight, expanding CLI inline, recovering from error."
        >
          <DCArtboard id="st-drag" label="Connecting · drag from port" width={720} height={420}>
            <StateDragLine theme={theme}/>
          </DCArtboard>
          <DCArtboard id="st-expand" label="Expanded CLI editor · double-click" width={620} height={500}>
            <StateExpanded theme={theme}/>
          </DCArtboard>
          <DCArtboard id="st-error" label="Error · halt downstream + suggest fallback" width={760} height={420}>
            <StateError theme={theme}/>
          </DCArtboard>
        </DCSection>

        <DCSection
          id="anatomy"
          title="Anatomy of a node"
          subtitle="What every node has — and the rules for how each part communicates state, type, and progress."
        >
          <DCArtboard id="an-node" label="Node anatomy · callouts" width={680} height={500}>
            <NodeAnatomy theme={theme}/>
          </DCArtboard>
        </DCSection>

        <DCSection
          id="variants"
          title="Component variants — pick a direction per axis"
          subtitle="Each row shows three takes on the same component. Tweak panel mirrors these so the main prototype + scenarios update in real time."
        >
          <DCArtboard id="var-cli" label="CLI node · terminal vs form vs hybrid" width={1180} height={360}>
            <CliStyleRow theme={theme}/>
          </DCArtboard>
          <DCArtboard id="var-conn" label="Connection · bezier vs orthogonal vs straight" width={1180} height={320}>
            <ConnectionStyleRow theme={theme}/>
          </DCArtboard>
          <DCArtboard id="var-prev" label="Node preview · thumbnail vs text vs hybrid" width={1180} height={360}>
            <PreviewStyleRow theme={theme}/>
          </DCArtboard>
          <DCArtboard id="var-stat" label="Status indicator · border vs top bar vs ring" width={1180} height={340}>
            <StatusStyleRow theme={theme}/>
          </DCArtboard>
          <DCArtboard id="var-layout" label="Layout · horizontal vs vertical flow" width={1100} height={440}>
            <LayoutComparison theme={theme}/>
          </DCArtboard>
        </DCSection>
      </DesignCanvas>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Appearance">
          <TweakRadio
            label="Theme"
            value={theme}
            onChange={(v) => setTweak('theme', v)}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
          />
        </TweakSection>
        <TweakSection label="Node component">
          <TweakSelect
            label="CLI block"
            value={cliStyle}
            onChange={(v) => setTweak('cliStyle', v)}
            options={[
              { value: 'terminal', label: 'Terminal' },
              { value: 'form', label: 'Form' },
              { value: 'hybrid', label: 'Hybrid' },
            ]}
          />
          <TweakSelect
            label="Preview"
            value={previewStyle}
            onChange={(v) => setTweak('previewStyle', v)}
            options={[
              { value: 'thumb', label: 'Thumbnail' },
              { value: 'text', label: 'Text' },
              { value: 'hybrid', label: 'Hybrid' },
            ]}
          />
          <TweakSelect
            label="Status indicator"
            value={statusStyle}
            onChange={(v) => setTweak('statusStyle', v)}
            options={[
              { value: 'border', label: 'Border tint' },
              { value: 'bar', label: 'Top bar' },
              { value: 'ring', label: 'Header ring' },
            ]}
          />
        </TweakSection>
        <TweakSection label="Graph">
          <TweakRadio
            label="Connection"
            value={connectionStyle}
            onChange={(v) => setTweak('connectionStyle', v)}
            options={[
              { value: 'bezier', label: 'Bezier' },
              { value: 'ortho', label: 'Ortho' },
              { value: 'straight', label: 'Line' },
            ]}
          />
        </TweakSection>
      </TweaksPanel>
    </>
  );
}

const root = ReactDOM.createRoot(document.getElementById('app'));
root.render(<App/>);
