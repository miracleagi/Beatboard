#!/usr/bin/env node
// Generates golden fixtures for the PixVerse task-node migration.
//
// Every PixVerse node Beatboard can create (palette templates, built-in
// scenarios, legacy gen/motion nodes), plus edited and unmigratable variants,
// is paired with several upstream-dependency shapes. For each case the fixture
// stores the legacy node, its migrated task node, and the deps. The Rust test
// src-tauri/src/providers/pixverse/golden.rs asserts both resolve to the same
// PixVerse argv.
//
//   node scripts/gen-pixverse-fixtures.mjs          # rewrite the fixture
//   node scripts/gen-pixverse-fixtures.mjs --check  # fail if it is stale

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src-tauri/tests/fixtures/pixverse_task_migration.json');

// ── Load the app's plain-JS modules into one shared global scope ────────────
const context = vm.createContext({ console, Math, JSON, Date, Number, String, Object, Array, Set, Map });
context.window = context;
for (const file of ['src/scenarios.jsx', 'src/state.jsx', 'src/task-model.jsx']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}
const { NODE_TEMPLATES, SCENARIOS, normalizeGraphPorts, migrateLegacyPixVerseNode, isLegacyPixVerseNode } = context;
const plain = value => JSON.parse(JSON.stringify(value));

// ── Source nodes ─────────────────────────────────────────────────────────────
const sources = [];
NODE_TEMPLATES.forEach((template, i) => {
  const node = { id: `tpl${i}`, x: 0, y: 0, ...template.spawn() };
  if (!isLegacyPixVerseNode(node)) return;
  sources.push({ name: `template:${template.title}`, node: normalizeGraphPorts({ nodes: [node], edges: [] }).nodes[0], pristine: true });
});
const scenarioList = Array.isArray(SCENARIOS) ? SCENARIOS : Object.values(SCENARIOS);
scenarioList.forEach(scenario => {
  normalizeGraphPorts({ nodes: scenario.nodes, edges: scenario.edges }).nodes
    .filter(isLegacyPixVerseNode)
    .forEach(node => sources.push({ name: `scenario:${scenario.id}:${node.id}`, node, pristine: true }));
});

// Edits the Inspector / MCP can make: flags are upserted before --json.
function upsert(args, flag, value) {
  const next = [...args];
  const i = next.indexOf(flag);
  if (i >= 0) {
    if (value === undefined) next.splice(i, 1);
    else next[i + 1] = value;
    return next;
  }
  const j = next.indexOf('--json');
  next.splice(j >= 0 ? j : next.length, 0, ...(value === undefined ? [flag] : [flag, value]));
  return next;
}
const EDITS = {
  'image': [['--seed', '42'], ['--detail-level', 'high'], ['--idempotency-key', 'k-1'], ['--model', 'seedream-5.0-lite']],
  'video': [['--seed', '7'], ['--no-audio'], ['--multi-shot'], ['--off-peak'], ['--duration', '8'], ['--model', 'kling-3.0-pro']],
  'transition': [['--duration', '5'], ['--count', '2'], ['--audio']],
  'reference': [['--duration', '10'], ['--seed', '3'], ['--no-audio']],
  'motion-control': [['--count', '2'], ['--off-peak']],
  'extend': [['--quality', '1080p'], ['--duration', '5'], ['--audio']],
  'upscale': [['--no-wait']],
  'modify': [['--seed', '9'], ['--keyframe-time', '1500']],
  'voice': [['--voice-id', 'v-12'], ['--stability', '0.5'], ['--no-use-speaker-boost'], ['--pitch', '-3'], ['--speed', '1.2']],
  'music': [['--auto-lyrics'], ['--lyrics', 'la la'], ['--no-duration-auto'], ['--duration-seconds', '30']],
  'template': [['--template-id', '315'], ['--duration', '5'], ['--aspect-ratio', '9:16'], ['--seed', '1']],
};
const pristineCount = sources.length;
for (const source of sources.slice(0, pristineCount)) {
  const args = source.node.cli.args;
  const sub = args[1];
  let edited = [...args];
  for (const [flag, value] of EDITS[sub] || []) edited = upsert(edited, flag, value);
  if (sub === 'music') edited = edited.filter(a => a !== '--instrumental');
  sources.push({ name: `${source.name}+edited`, node: { ...source.node, cli: { ...source.node.cli, args: edited } }, pristine: false });
}
// Templates that cannot be typed losslessly → raw fallback.
const tplImage = sources.find(s => s.name.startsWith('template:') && s.node.cli.args[1] === 'image').node;
const tplVideo = sources.find(s => s.name.startsWith('template:') && s.node.cli.args[1] === 'video').node;
const withArgs = (node, args) => ({ ...node, cli: { ...node.cli, args } });
sources.push(
  { name: 'raw:unknown-flag', node: withArgs(tplVideo, upsert(tplVideo.cli.args, '--frobnicate', 'yes')), raw: true },
  { name: 'raw:literal-prompt', node: withArgs(tplVideo, tplVideo.cli.args.map(a => a === '{prompt}' ? 'a literal prompt' : a)), raw: true },
  { name: 'raw:image-flag-shape', node: withArgs(tplImage, tplImage.cli.args.map(a => a === '--images' ? '--image' : a === '{images}' ? '{image}' : a)), raw: true },
  { name: 'raw:no-json', node: withArgs(tplVideo, tplVideo.cli.args.filter(a => a !== '--json')), raw: true },
);
// Legacy provider nodes.
const genPorts = [
  { kind: 'image', side: 'left', top: 44, label: 'src' },
  { kind: 'text', side: 'left', top: 68, label: 'prompt' },
];
sources.push(
  { name: 'legacy:gen', node: { id: 'g1', kind: 'gen', provider: 'pixverse', title: 'gen', ports: [...genPorts, { kind: 'image', side: 'right', top: 58 }] }, legacyProvider: true },
  { name: 'legacy:gen+params', node: { id: 'g2', kind: 'gen', provider: 'pixverse', model: 'flux-2', quality: '720p', aspectRatio: '1:1', count: 3, timeout: 120, ports: [...genPorts, { kind: 'image', side: 'right', top: 58 }] }, legacyProvider: true },
  { name: 'legacy:motion', node: { id: 'm1', kind: 'motion', provider: 'pixverse', motionPrompt: 'slow push-in', ports: [...genPorts, { kind: 'video', side: 'right', top: 58 }] }, legacyProvider: true },
  { name: 'legacy:motion+params', node: { id: 'm2', kind: 'motion', provider: 'pixverse', duration: 8, audio: true, offPeak: true, quality: '1080p', ports: [...genPorts, { kind: 'video', side: 'right', top: 58 }] }, legacyProvider: true },
);

// ── Dependency shapes ────────────────────────────────────────────────────────
function mediaThumb(kind, n, { id = true } = {}) {
  const ext = { image: 'png', video: 'mp4', audio: 'mp3' }[kind];
  const p = `/Users/demo/media/${kind}-${n}.${ext}`;
  return {
    seed: p, label: kind, type: kind, path: p,
    url: `atlasmedia://localhost/${encodeURIComponent(p)}`,
    ...(id ? { id: `pv-${kind}-${n}` } : {}),
  };
}

function depFor(nodeId, portIndex, port, n, shape) {
  const edge = { from: { node: `src${n}`, port: 0 }, to: { node: nodeId, port: portIndex } };
  if (port.kind === 'text') {
    return { edge, from: { id: `src${n}`, kind: 'prompt', prompt: `shot ${n}: rain on neon glass` }, result: { state: 'done' } };
  }
  if (!['image', 'video', 'audio'].includes(port.kind)) return null;
  const thumb = mediaThumb(port.kind, n, { id: shape !== 'no-ids' });
  if (shape === 'pick' || shape === 'pick-stale') {
    // A Pick node forwards every candidate with `chosen` marking the choice.
    // The rejected candidate is numbered n+100 so tests can assert it never
    // reaches the argv. 'pick-stale' mimics a re-run: the runner's graph
    // snapshot still holds the previous choice, the run result the new one.
    const candidates = [mediaThumb(port.kind, n + 100), thumb].map((t, i) => ({ ...t, chosen: i === 1 }));
    const from = shape === 'pick-stale'
      ? { id: `src${n}`, kind: 'select', selectedIndex: 0, thumbs: candidates.map((t, i) => ({ ...t, chosen: i === 0 })) }
      : { id: `src${n}`, kind: 'select', selectedIndex: 1, thumbs: candidates };
    return { edge, from, result: { selectedIndex: 1, thumbs: candidates, state: 'done' } };
  }
  if (shape === 'cached') {
    return { edge, from: { id: `src${n}`, kind: 'asset', thumbs: [thumb] }, result: undefined };
  }
  return { edge, from: { id: `src${n}`, kind: 'cli' }, result: { thumbs: [{ ...thumb, chosen: true }], state: 'done' } };
}

function depSets(node) {
  const left = (node.ports || []).map((port, i) => ({ port, i })).filter(({ port }) => port.side === 'left');
  const firstOfKind = new Set();
  const firsts = left.filter(({ port }) => !firstOfKind.has(port.kind) && firstOfKind.add(port.kind));
  const build = (entries, shape) => entries.map(({ port, i }) => depFor(node.id, i, port, i + 1, shape)).filter(Boolean);
  return {
    all: build(left, 'result'),
    first: build(firsts, 'result'),
    none: [],
    'text-only': build(left.filter(({ port }) => port.kind === 'text'), 'result'),
    'media-only': build(left.filter(({ port }) => port.kind !== 'text'), 'result'),
    'no-ids': build(left, 'no-ids'),
    cached: build(left, 'cached'),
    pick: build(left, 'pick'),
    'pick-stale': build(left, 'pick-stale'),
    reversed: build(left, 'result').reverse(),
  };
}

// ── Emit ─────────────────────────────────────────────────────────────────────
const cases = [];
for (const source of sources) {
  const legacy = plain(source.node);
  const task = plain(migrateLegacyPixVerseNode(legacy));
  const raw = !!task.provider_params?._raw_args;
  if (source.pristine && raw) throw new Error(`${source.name}: pristine template fell back to raw args`);
  if (source.raw && !raw) throw new Error(`${source.name}: expected raw-args fallback`);
  for (const [shape, deps] of Object.entries(depSets(legacy))) {
    cases.push({
      name: `${source.name} / ${shape}`,
      // Untouched templates must reproduce the legacy argv byte for byte;
      // edited ones may reorder flags (the CLI is order-insensitive).
      exact: !!(source.pristine || source.raw),
      legacy_may_fail: !!source.legacyProvider,
      legacy,
      task,
      deps: plain(deps),
      // Media a correct resolver must never pass on (rejected Pick candidates).
      forbidden: deps.filter(d => d.from?.kind === 'select')
        .flatMap(d => d.result.thumbs.filter(t => !t.chosen).flatMap(t => [t.path, t.id])),
    });
  }
}

const json = JSON.stringify({ generated_by: 'scripts/gen-pixverse-fixtures.mjs', cases }, null, 1) + '\n';
if (process.argv.includes('--check')) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (current !== json) {
    console.error(`${path.relative(root, out)} is stale — run: node scripts/gen-pixverse-fixtures.mjs`);
    process.exit(1);
  }
  console.log(`fixtures up to date (${cases.length} cases)`);
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json);
  console.log(`wrote ${cases.length} cases from ${sources.length} nodes → ${path.relative(root, out)}`);
}
