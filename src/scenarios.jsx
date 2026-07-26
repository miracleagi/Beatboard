// Default scenario graphs — all use only supported nodes (PixVerse + ffmpeg).

// ── Scenario 1: Single image ────────────────────────────────────────────────
// Prompt → PixVerse image → Pick → Output
const SCENARIO_ITERATE = {
  id: 'single_image',
  name: 'Single image',
  desc: 'Generate an image with PixVerse, pick the best, export',
  layout: 'h',
  nodes: [
    {
      id: 'p0', kind: 'prompt', title: 'Prompt', x: 40, y: 130, w: 196, badge: 'text',
      prompt: 'rain-slicked neon alleyway, hong kong, low angle, anamorphic flare, 35mm',
      ports: [{ kind: 'text', side: 'right', top: 52 }],
      footer: { left: 'edit me', right: '·' },
    },
    {
      id: 'pv0', kind: 'cli', title: 'PixVerse image', x: 280, y: 110, w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        args: ['create', 'image', '--prompt', '{prompt}', '--image', '{image}', '--model', 'gpt-image-2.0',
               '--quality', '1080p', '--aspect-ratio', '16:9', '--count', '1',
               '--timeout', '300', '--json'],
        fields: [{ k: 'mode', v: 'T2I/I2I' }, { k: 'model', v: 'gpt-image-2.0' },
                 { k: 'quality', v: '1080p' }, { k: 'ratio', v: '16:9' }],
      },
      ports: [
        { kind: 'image', side: 'left', top: 44, label: 'src' },
        { kind: 'text', side: 'left', top: 68, label: 'prompt' },
        { kind: 'image', side: 'right', top: 58 },
      ],
      footer: { left: 'pixverse create image', right: '— idle' },
    },
    {
      id: 'pk0', kind: 'select', title: 'Pick', x: 568, y: 120, w: 188, badge: 'manual',
      thumbs: [],
      ports: [
        { kind: 'image', side: 'left', top: 96, label: 'in' },
        { kind: 'image', side: 'right', top: 96, label: 'out' },
      ],
      footer: { left: 'pick #—', right: '★' },
    },
    {
      id: 'out', kind: 'output', title: 'Single Image 01', x: 794, y: 130, w: 196, badge: 'output',
      thumbs: [],
      ports: [{ kind: 'image', side: 'left', top: 60 }],
      footer: { left: '1920 × 1080', right: '— idle' },
    },
  ],
  edges: [
    { from: { node: 'p0', port: 0 }, to: { node: 'pv0', port: 1 } },
    { from: { node: 'pv0', port: 2 }, to: { node: 'pk0', port: 0 } },
    { from: { node: 'pk0', port: 1 }, to: { node: 'out', port: 0 } },
  ],
};

// ── Scenario 2: Image → video ────────────────────────────────────────────────
// Prompt → PixVerse image → PixVerse video → Output
const SCENARIO_BATCH = {
  id: 'image_to_video',
  name: 'Image to video',
  desc: 'Generate a still with PixVerse, then animate it into a video clip',
  layout: 'h',
  nodes: [
    {
      id: 'p0', kind: 'prompt', title: 'Prompt', x: 40, y: 130, w: 196, badge: 'text',
      prompt: 'neon-lit protagonist stands in a rain-soaked alley, cinematic, 16:9',
      ports: [{ kind: 'text', side: 'right', top: 52 }],
      footer: { left: 'edit me', right: '·' },
    },
    {
      id: 'pv_img', kind: 'cli', title: 'PixVerse image', x: 280, y: 110, w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        args: ['create', 'image', '--prompt', '{prompt}', '--image', '{image}', '--model', 'gpt-image-2.0',
               '--quality', '1080p', '--aspect-ratio', '16:9', '--count', '1',
               '--timeout', '300', '--json'],
        fields: [{ k: 'mode', v: 'T2I/I2I' }, { k: 'model', v: 'gpt-image-2.0' },
                 { k: 'quality', v: '1080p' }, { k: 'ratio', v: '16:9' }],
      },
      ports: [
        { kind: 'image', side: 'left', top: 44, label: 'src' },
        { kind: 'text', side: 'left', top: 68, label: 'prompt' },
        { kind: 'image', side: 'right', top: 58 },
      ],
      footer: { left: 'pixverse create image', right: '— idle' },
    },
    {
      id: 'pv_vid', kind: 'cli', title: 'PixVerse video', x: 570, y: 90, w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        args: ['create', 'video', '--prompt', '{prompt}', '--image', '{image}',
               '--model', 'v6', '--duration', '5', '--quality', '720p',
               '--aspect-ratio', '16:9', '--count', '1', '--timeout', '600', '--json'],
        fields: [{ k: 'mode', v: 'T2V/I2V' }, { k: 'model', v: 'v6' },
                 { k: 'duration', v: '5s' }, { k: 'ratio', v: '16:9' }],
      },
      ports: [
        { kind: 'image', side: 'left', top: 44, label: 'src' },
        { kind: 'text', side: 'left', top: 68, label: 'prompt' },
        { kind: 'video', side: 'right', top: 58 },
      ],
      footer: { left: 'pixverse create video', right: '— idle' },
    },
    {
      id: 'out', kind: 'output', title: 'Image to Video 01', x: 860, y: 120, w: 196, badge: 'output',
      thumbs: [],
      ports: [{ kind: 'image', side: 'left', top: 60 }],
      footer: { left: '1280 × 720', right: '— idle' },
    },
  ],
  edges: [
    { from: { node: 'p0', port: 0 }, to: { node: 'pv_img', port: 1 } },
    { from: { node: 'pv_img', port: 2 }, to: { node: 'pv_vid', port: 0 } },
    { from: { node: 'p0', port: 0 }, to: { node: 'pv_vid', port: 1 }, dashed: true },
    { from: { node: 'pv_vid', port: 2 }, to: { node: 'out', port: 0 } },
  ],
};

// ── Scenario 3: Short film assembly ─────────────────────────────────────────
// 2 shots (Prompt → PV image → PV video) joined by ffmpeg concat → Output
const SCENARIO_ASSEMBLY = {
  id: 'short_film',
  name: 'Short film',
  desc: 'Two shots each generated and animated, then composed with ffmpeg',
  layout: 'h',
  nodes: [
    // Shot 1
    {
      id: 'p1', kind: 'prompt', title: 'Shot 01 · prompt', x: 40, y: 50, w: 196, badge: 'text',
      prompt: 'wide drone shot, neon skyline at dusk, cinematic',
      ports: [{ kind: 'text', side: 'right', top: 44 }],
      footer: { left: 'edit me', right: '·' },
    },
    {
      id: 'img1', kind: 'cli', title: 'PixVerse image', x: 280, y: 40, w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        args: ['create', 'image', '--prompt', '{prompt}', '--image', '{image}', '--model', 'gpt-image-2.0',
               '--quality', '1080p', '--aspect-ratio', '16:9', '--count', '1',
               '--timeout', '300', '--json'],
        fields: [{ k: 'mode', v: 'T2I/I2I' }, { k: 'ratio', v: '16:9' }],
      },
      ports: [
        { kind: 'image', side: 'left', top: 44, label: 'src' },
        { kind: 'text', side: 'left', top: 68, label: 'prompt' },
        { kind: 'image', side: 'right', top: 58 },
      ],
      footer: { left: 'pixverse create image', right: '— idle' },
    },
    {
      id: 'vid1', kind: 'cli', title: 'PixVerse video', x: 570, y: 30, w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        args: ['create', 'video', '--prompt', '{prompt}', '--image', '{image}',
               '--model', 'v6', '--duration', '5', '--quality', '720p',
               '--aspect-ratio', '16:9', '--count', '1', '--timeout', '600', '--json'],
        fields: [{ k: 'mode', v: 'T2V/I2V' }, { k: 'duration', v: '5s' }],
      },
      ports: [
        { kind: 'image', side: 'left', top: 44, label: 'src' },
        { kind: 'text', side: 'left', top: 68, label: 'prompt' },
        { kind: 'video', side: 'right', top: 58 },
      ],
      footer: { left: 'pixverse create video', right: '— idle' },
    },

    // Shot 2
    {
      id: 'p2', kind: 'prompt', title: 'Shot 02 · prompt', x: 40, y: 280, w: 196, badge: 'text',
      prompt: 'protagonist enters alley, low angle, rain, neon reflections',
      ports: [{ kind: 'text', side: 'right', top: 44 }],
      footer: { left: 'edit me', right: '·' },
    },
    {
      id: 'img2', kind: 'cli', title: 'PixVerse image', x: 280, y: 270, w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        args: ['create', 'image', '--prompt', '{prompt}', '--image', '{image}', '--model', 'gpt-image-2.0',
               '--quality', '1080p', '--aspect-ratio', '16:9', '--count', '1',
               '--timeout', '300', '--json'],
        fields: [{ k: 'mode', v: 'T2I/I2I' }, { k: 'ratio', v: '16:9' }],
      },
      ports: [
        { kind: 'image', side: 'left', top: 44, label: 'src' },
        { kind: 'text', side: 'left', top: 68, label: 'prompt' },
        { kind: 'image', side: 'right', top: 58 },
      ],
      footer: { left: 'pixverse create image', right: '— idle' },
    },
    {
      id: 'vid2', kind: 'cli', title: 'PixVerse video', x: 570, y: 260, w: 244, badge: 'cli · pixverse',
      cli: {
        bin: 'pixverse', cmd: 'pixverse',
        args: ['create', 'video', '--prompt', '{prompt}', '--image', '{image}',
               '--model', 'v6', '--duration', '5', '--quality', '720p',
               '--aspect-ratio', '16:9', '--count', '1', '--timeout', '600', '--json'],
        fields: [{ k: 'mode', v: 'T2V/I2V' }, { k: 'duration', v: '5s' }],
      },
      ports: [
        { kind: 'image', side: 'left', top: 44, label: 'src' },
        { kind: 'text', side: 'left', top: 68, label: 'prompt' },
        { kind: 'video', side: 'right', top: 58 },
      ],
      footer: { left: 'pixverse create video', right: '— idle' },
    },

    // Assembly
    {
      id: 'ff', kind: 'cli', title: 'ffmpeg · compose', x: 860, y: 160, w: 244, badge: 'cli · local',
      cli: {
        bin: 'ffmpeg', cmd: 'ffmpeg',
        args: ['connected videos', '-filter_complex concat', '-c:v h264_videotoolbox (mpeg4 fallback)'],
        fields: [{ k: 'in', v: 'multi' }, { k: 'mode', v: 'concat' },
                 { k: 'codec', v: 'VideoToolbox / MPEG-4' }, { k: 'fps', v: '24' }],
      },
      ports: [
        { kind: 'video', side: 'left', top: 60, label: 'clips' },
        { kind: 'file', side: 'left', top: 96, label: 'aud' },
        { kind: 'video', side: 'right', top: 72 },
      ],
      footer: { left: 'watches inputs', right: '— idle' },
    },
    {
      id: 'out', kind: 'output', title: 'Short Film 01', x: 1150, y: 185, w: 196, badge: 'output',
      thumbs: [],
      ports: [{ kind: 'image', side: 'left', top: 60 }],
      footer: { left: '1280 × 720 · 24fps', right: '— idle' },
    },
  ],
  edges: [
    { from: { node: 'p1', port: 0 }, to: { node: 'img1', port: 1 } },
    { from: { node: 'img1', port: 2 }, to: { node: 'vid1', port: 0 } },
    { from: { node: 'p1', port: 0 }, to: { node: 'vid1', port: 1 }, dashed: true },
    { from: { node: 'p2', port: 0 }, to: { node: 'img2', port: 1 } },
    { from: { node: 'img2', port: 2 }, to: { node: 'vid2', port: 0 } },
    { from: { node: 'p2', port: 0 }, to: { node: 'vid2', port: 1 }, dashed: true },
    { from: { node: 'vid1', port: 2 }, to: { node: 'ff', port: 0 } },
    { from: { node: 'vid2', port: 2 }, to: { node: 'ff', port: 0 } },
    { from: { node: 'ff', port: 2 }, to: { node: 'out', port: 0 } },
  ],
};

const SCENARIOS = [SCENARIO_ITERATE, SCENARIO_BATCH, SCENARIO_ASSEMBLY];
const SCENARIO_BY_ID = Object.fromEntries(SCENARIOS.map(s => [s.id, s]));

Object.assign(window, { SCENARIOS, SCENARIO_BY_ID, SCENARIO_ITERATE, SCENARIO_BATCH, SCENARIO_ASSEMBLY });
