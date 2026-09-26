// Task nodes — provider-neutral generation nodes (docs/design/multi-provider.md).
//
//   { kind: 'task', capability: 'video.generate', provider: 'pixverse',
//     model: 'v6', params: { duration_s: 5, resolution: '720p', … },
//     provider_params: { timeout: 600, off_peak: true, … },
//     ports: [{ kind: 'image', side: 'left', slot: 'image', … }, …] }
//
// This file converts legacy PixVerse nodes (`kind: 'cli'` argv templates and
// the older `kind: 'gen' | 'motion'` provider nodes) into task nodes. The Rust
// PixVerse provider (src-tauri/src/providers/pixverse/args.rs) turns a task
// node back into argv; golden fixtures generated from this file
// (scripts/gen-pixverse-fixtures.mjs) prove both paths produce the same argv.
//
// Plain JS on purpose: loaded by the app and by Node for fixture generation.

// PixVerse subcommand → capability, input-port slots, and the placeholder
// each input flag must carry for the node to migrate to typed params.
const PV_TASK_SPECS = {
  'image': {
    capability: 'image.generate',
    slots: { image: 'images', text: 'prompt' },
    inputs: { '--prompt': '{prompt}', '--image': '{image}', '--images': '{images}' },
  },
  'video': {
    capability: 'video.generate',
    slots: { image: 'image', text: 'prompt' },
    inputs: { '--prompt': '{prompt}', '--image': '{image}' },
  },
  'transition': {
    capability: 'video.transition',
    slots: { image: 'frames', text: 'prompt' },
    inputs: { '--images': '{images}', '--prompt': '{prompt}' },
  },
  'reference': {
    capability: 'video.reference',
    slots: { image: 'images', video: 'videos', audio: 'audios', text: 'prompt' },
    inputs: { '--images': '{images}', '--videos': '{videos}', '--audios': '{audios}', '--prompt': '{prompt}' },
  },
  'motion-control': {
    capability: 'video.motion_control',
    slots: { image: 'character', video: 'motion' },
    inputs: { '--image': '{from}', '--video': '{to}' },
  },
  'extend': {
    capability: 'video.extend',
    slots: { video: 'video', text: 'prompt' },
    inputs: { '--video': '{video_id}', '--prompt': '{prompt}' },
  },
  'upscale': {
    capability: 'video.upscale',
    slots: { video: 'video' },
    inputs: { '--video': '{video_id}' },
  },
  'modify': {
    capability: 'video.modify',
    slots: { video: 'video', image: 'images', text: 'prompt' },
    inputs: { '--video': '{video_id}', '--images': '{images}', '--prompt': '{prompt}' },
  },
  'voice': {
    capability: 'audio.speech',
    slots: { text: 'text' },
    inputs: { '--text': '{prompt}' },
  },
  'music': {
    capability: 'audio.music',
    slots: { image: 'image', text: 'prompt' },
    inputs: { '--prompt': '{prompt}', '--image': '{images}' },
  },
  'template': {
    capability: 'provider.template',
    slots: { image: 'images', video: 'video', text: 'prompt' },
    inputs: { '--image': '{images}', '--video': '{video}', '--prompt': '{prompt}' },
  },
};

// Value flags → [bucket, key]. `duration` is subcommand-specific (see below).
const PV_VALUE_FLAGS = {
  '--quality': ['params', 'resolution'],
  '--aspect-ratio': ['params', 'aspect_ratio'],
  '--count': ['params', 'count'],
  '--seed': ['params', 'seed'],
  '--timeout': ['provider_params', 'timeout'],
  '--detail-level': ['provider_params', 'detail_level'],
  '--keyframe-time': ['provider_params', 'keyframe_time'],
  '--template-id': ['provider_params', 'template_id'],
  '--lyrics': ['provider_params', 'lyrics'],
  '--voice-id': ['provider_params', 'voice_id'],
  '--provider-voice-id': ['provider_params', 'provider_voice_id'],
  '--language': ['provider_params', 'language'],
  '--stability': ['provider_params', 'stability'],
  '--similarity-boost': ['provider_params', 'similarity_boost'],
  '--style': ['provider_params', 'style'],
  '--speed': ['provider_params', 'speed'],
  '--volume': ['provider_params', 'volume'],
  '--pitch': ['provider_params', 'pitch'],
  '--emotion': ['provider_params', 'emotion'],
  '--idempotency-key': ['provider_params', 'idempotency_key'],
  '--client-request-id': ['provider_params', 'client_request_id'],
  '--output': ['provider_params', 'output'],
};

// Boolean flags → [bucket, key, value].
const PV_BOOL_FLAGS = {
  '--audio': ['params', 'audio', true],
  '--no-audio': ['params', 'audio', false],
  '--multi-shot': ['provider_params', 'multi_shot', true],
  '--no-multi-shot': ['provider_params', 'multi_shot', false],
  '--use-speaker-boost': ['provider_params', 'use_speaker_boost', true],
  '--no-use-speaker-boost': ['provider_params', 'use_speaker_boost', false],
  '--off-peak': ['provider_params', 'off_peak', true],
  '--instrumental': ['provider_params', 'instrumental', true],
  '--auto-lyrics': ['provider_params', 'auto_lyrics', true],
  '--no-duration-auto': ['provider_params', 'no_duration_auto', true],
  '--no-wait': ['provider_params', 'no_wait', true],
};

// Integer-valued keys stored as numbers when that round-trips exactly.
const PV_NUMERIC_KEYS = new Set(['count', 'seed', 'duration_s', 'timeout', 'keyframe_time']);

function pvTypedValue(key, raw) {
  if (PV_NUMERIC_KEYS.has(key) && /^-?\d+$/.test(raw) && String(Number(raw)) === raw) return Number(raw);
  return raw;
}

function pvCliName(node) {
  const raw = node?.cli?.cmd || node?.cli?.bin || '';
  return String(raw).trim().split(/\s+/)[0].split(/[\\/]/).pop();
}

function isLegacyPixVerseNode(node) {
  return (node?.kind === 'cli' && pvCliName(node) === 'pixverse') ||
    ((node?.kind === 'gen' || node?.kind === 'motion') && node?.provider === 'pixverse');
}

function isTaskNode(node) {
  return node?.kind === 'task';
}

function withSlots(ports, spec) {
  return (ports || []).map(port => {
    if (port.side !== 'left' || !spec) return port;
    const slot = spec.slots[port.kind];
    return slot ? { ...port, slot } : port;
  });
}

function slotPortCount(ports, slot) {
  return ports.filter(p => p.side === 'left' && p.slot === slot).length;
}

// Parse a PixVerse argv template into typed task fields.
// Returns null when the template cannot be expressed losslessly.
function parsePixVerseArgs(args, spec, sub, ports) {
  if (!spec || args[0] !== 'create' || args[1] !== sub) return null;
  const out = { model: undefined, params: {}, provider_params: {} };
  const seen = new Set();
  let sawJson = false;
  const claim = key => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  for (let i = 2; i < args.length; i += 1) {
    const flag = String(args[i]);
    if (!flag.startsWith('--')) return null;
    if (flag === '--json') {
      if (sawJson) return null;
      sawJson = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(spec.inputs, flag)) {
      if (args[i + 1] !== spec.inputs[flag] || !claim(`input:${spec.inputs[flag]}`)) return null;
      i += 1;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(PV_BOOL_FLAGS, flag)) {
      const [bucket, key, value] = PV_BOOL_FLAGS[flag];
      if (!claim(key)) return null;
      out[bucket][key] = value;
      continue;
    }
    let target = PV_VALUE_FLAGS[flag];
    if (flag === '--model') target = ['model', 'model'];
    if (flag === '--duration' && sub !== 'music') target = ['params', 'duration_s'];
    if (flag === '--duration-seconds' && sub === 'music') target = ['params', 'duration_s'];
    if (!target) return null;
    const value = args[i + 1];
    if (value == null || String(value).startsWith('--') || String(value).includes('{')) return null;
    const [bucket, key] = target;
    if (!claim(key)) return null;
    if (bucket === 'model') out.model = String(value);
    else out[bucket][key] = pvTypedValue(key, String(value));
    i += 1;
  }
  if (!sawJson) return null;

  // `create image` picks --image vs --images from the number of image ports
  // (see Input::ByPorts in args.rs); the template must agree with that rule.
  if (sub === 'image') {
    const multi = slotPortCount(ports, 'images') > 1;
    if (seen.has('input:{image}') && multi) return null;
    if (seen.has('input:{images}') && !multi) return null;
    if (seen.has('input:{image}') && seen.has('input:{images}')) return null;
  }
  return out;
}

function taskBase(node) {
  const { cli, provider, model, quality, aspectRatio, count, duration, audio, offPeak, timeout, ...rest } = node;
  return rest;
}

function migrateCliNode(node) {
  const args = (node.cli?.args || []).map(String);
  const sub = args[0] === 'create' ? args[1] : undefined;
  const spec = PV_TASK_SPECS[sub];
  const ports = withSlots(node.ports, spec);
  const parsed = parsePixVerseArgs(args, spec, sub, ports);
  const base = { ...taskBase(node), kind: 'task', provider: 'pixverse', ports };
  if (!parsed) {
    // Keep the exact template; the provider resolves it with legacy rules.
    return {
      ...base,
      capability: spec ? spec.capability : 'pixverse.raw',
      params: {},
      provider_params: { _raw_args: args },
    };
  }
  return {
    ...base,
    capability: spec.capability,
    ...(parsed.model ? { model: parsed.model } : {}),
    params: parsed.params,
    provider_params: parsed.provider_params,
  };
}

// Older provider nodes (kind gen/motion, provider pixverse) — mirrors
// build_provider_args in src-tauri/src/providers/pixverse/legacy.rs.
function migrateProviderNode(node) {
  const video = node.kind === 'motion';
  const spec = PV_TASK_SPECS[video ? 'video' : 'image'];
  // gen nodes always sent a single --image: route every image port to one
  // slot and keep a single-port shape by giving only the first port the slot.
  let imageSlotted = false;
  const ports = (node.ports || []).map(port => {
    if (port.side !== 'left') return port;
    if (port.kind === 'image') {
      if (imageSlotted) return port;
      imageSlotted = true;
      return { ...port, slot: video ? 'image' : 'images' };
    }
    const slot = spec.slots[port.kind];
    return slot ? { ...port, slot } : port;
  });
  const params = {
    resolution: node.quality || (video ? '720p' : '1080p'),
    aspect_ratio: node.aspectRatio || '16:9',
  };
  if (Number.isInteger(node.count) && node.count >= 0) params.count = node.count;
  const provider_params = { timeout: Number.isInteger(node.timeout) && node.timeout >= 0 ? node.timeout : (video ? 600 : 300) };
  if (video) {
    params.duration_s = Number.isInteger(node.duration) && node.duration >= 0 ? node.duration : 5;
    if (node.audio === true) params.audio = true;
    if (node.offPeak === true) provider_params.off_peak = true;
  }
  return {
    ...taskBase(node),
    kind: 'task',
    provider: 'pixverse',
    capability: spec.capability,
    model: node.model || (video ? 'v6' : 'gpt-image-2.0'),
    ports,
    params,
    provider_params,
  };
}

// Legacy PixVerse node → task node. Other nodes are returned unchanged.
function migrateLegacyPixVerseNode(node) {
  if (!isLegacyPixVerseNode(node)) return node;
  return node.kind === 'cli' ? migrateCliNode(node) : migrateProviderNode(node);
}

const TaskModel = { PV_TASK_SPECS, isTaskNode, isLegacyPixVerseNode, migrateLegacyPixVerseNode };

if (typeof window !== 'undefined') Object.assign(window, TaskModel);
if (typeof module !== 'undefined' && module.exports) module.exports = TaskModel;
