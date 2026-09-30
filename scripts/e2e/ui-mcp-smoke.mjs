#!/usr/bin/env node
// End-to-end smoke test of the web UI and the MCP bridge, in headless Chromium
// with the Tauri backend stubbed out.
//
// It loads a saved state from before P1 (legacy PixVerse argv nodes, API keys
// in config), then checks that the project is migrated to task nodes, that the
// Inspector and palette work, and that MCP calls from older agents (short type
// names such as `video`, old param names such as `quality`) keep working.
// It also covers fal.ai: switching a node's provider and model, the API-key
// flow in Config, and MCP validation against per-model constraints; and
// ComfyUI: importing a workflow (MCP and Inspector), bindings → ports, and
// the server address in Config.
//
//   node scripts/e2e/ui-mcp-smoke.mjs
//
// Set SCREENSHOT_DIR to also save screenshots of key screens.
//
// Needs Playwright with a Chromium build. Set PLAYWRIGHT_MODULE to the
// Playwright entry point when it is not resolvable from this repo, e.g. a
// global install: PLAYWRIGHT_MODULE="$(npm root -g)/playwright/index.mjs".

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pw = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(pw ? pathToFileURL(pw).href : 'playwright');

// Stand-in for window.__TAURI__: answers the commands the UI calls, records
// saves, and lets the test deliver MCP ops through the bridge's listener.
const TAURI_STUB = `
window.__saved = []; window.__mcp = {}; window.__listeners = {}; window.__keys = {};
const LEGACY = fetch('legacy-state.json').then(r => r.json());
window.__TAURI__ = {
  tauri: {
    convertFileSrc: x => x,
    invoke: async (cmd, args) => {
      if (cmd === 'load_graph') return LEGACY;
      if (cmd === 'save_graph') { window.__saved.push(JSON.parse(args.state)); return null; }
      if (cmd === 'runtime_status') return { pixverse: { available: true, source: 'managed', version: '1.2.10' }, ffmpeg: { available: true, source: 'bundled', version: '8.1' } };
      if (cmd === 'preview_task') return ['pixverse', 'create', args.node.capability, '--json'];
      if (cmd === 'mcp_response') { window.__mcp[args.id] = args.result; return null; }
      if (cmd === 'run_node') return window.__runNode(args);
      if (cmd === 'resume_task') return { ok: true, provider: args.node.provider, thumbs: [{ type: 'image', path: '/tmp/resumed.png', url: '/tmp/resumed.png', chosen: true }] };
      if (cmd === 'provider_secret_status') return !!window.__keys[args.provider];
      if (cmd === 'set_provider_secret') { window.__keys[args.provider] = args.secret; return null; }
      if (cmd === 'clear_provider_secret') { delete window.__keys[args.provider]; return null; }
      return null;
    },
  },
  event: {
    listen: async (name, fn) => { (window.__listeners[name] = window.__listeners[name] || []).push(fn); return () => {}; },
  },
  dialog: {},
};
// Fake generation: PixVerse succeeds and reports credits; fal emits its job
// first, then Veo fails and other fal models succeed.
window.__runs = [];
window.__runNode = async ({ node, runId }) => {
  window.__runs.push(node.id);
  await new Promise(r => setTimeout(r, 50));
  if (node.kind !== 'task') return { ok: true };
  const kind = node.capability.startsWith('video') ? 'video' : 'image';
  const thumb = { type: kind, path: '/tmp/' + node.id + (kind === 'video' ? '.mp4' : '.png'), url: '/tmp/' + node.id, chosen: true };
  window.__lastNode = node;
  if (node.provider === 'comfyui') {
    // Step progress as the Rust provider reports it from ComfyUI's websocket.
    (window.__listeners['status:' + runId] || []).forEach(fn => fn({ payload: '#3 KSampler 12/20' }));
    (window.__listeners['progress:' + runId] || []).forEach(fn => fn({ payload: 0.6 }));
    await new Promise(r => setTimeout(r, 600));
    return { ok: true, provider: 'comfyui', thumbs: [{ ...thumb, label: 'sdxl · seed 7' }] };
  }
  if (node.provider === 'fal') {
    (window.__listeners['job:' + runId] || []).forEach(fn => fn({ payload: { request_id: 'req-' + node.id, status_url: 's', response_url: 'r', cancel_url: 'c', output: kind === 'video' ? 'video' : 'images', model: node.model } }));
    await new Promise(r => setTimeout(r, 50));
    if (node.model === 'veo-3.1-fast') throw new Error('fal.ai error (HTTP 422): prompt: flagged by safety checker');
    return { ok: true, provider: 'fal', thumbs: [thumb] };
  }
  return { ok: true, provider: 'pixverse', thumbs: [thumb], cost: { amount: 30, unit: 'PixVerse credits' } };
};
let mcpId = 0;
window.__mcpCall = async (tool, args) => {
  const id = ++mcpId;
  (window.__listeners['mcp:op'] || []).forEach(fn => fn({ payload: { id, tool, args } }));
  for (let i = 0; i < 100 && !(id in window.__mcp); i++) await new Promise(r => setTimeout(r, 20));
  return window.__mcp[id];
};
`;

// ── Web root: web/ with src/ synced in (as dev.command does) + the stub ──────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beatboard-e2e-'));
fs.cpSync(path.join(repo, 'web'), root, { recursive: true });
fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
fs.cpSync(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'tauri-stub.js'), TAURI_STUB);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
fs.writeFileSync(path.join(root, 'index.html'),
  html.replace('<script src="tauri-bridge.js"></script>', '<script src="tauri-stub.js"></script>\n<script src="tauri-bridge.js"></script>'));

// A pre-P1 saved state: a prompt wired into a PixVerse video node with edited
// flags, an image node with a flag the migration cannot type, legacy config.
const templates = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/fixtures/legacy-pixverse-templates.json'), 'utf8')).templates;
const video = templates.find(t => t.title === 'PixVerse · video').node;
const image = templates.find(t => t.title === 'PixVerse · image').node;
const withFlags = (node, extra) => ({ ...node, cli: { ...node.cli, args: [...node.cli.args.slice(0, -1), ...extra, '--json'] } });
const legacyState = {
  config: { apiKeys: { openai: 'sk-secret' }, binPaths: { ffmpeg: '', pixverse: '/opt/pv', 'real-esrgan': '~/bin/x' }, defaultModel: 'flux.1-dev' },
  activeProjectId: 'p_legacy',
  library: [],
  projects: [{
    id: 'p_legacy', name: 'Legacy', color: '#7fc8ff', outputDir: '', modifiedAt: 1,
    // Saved while a fal run was in flight (Beatboard quit), plus a node that
    // was only queued — it should simply be forgotten.
    runResults: {
      f1: { state: 'running', progress: 0.4, job: { request_id: 'req-abc12345', status_url: 's', response_url: 'r', cancel_url: 'c', output: 'images', model: 'flux-dev' } },
      p0: { state: 'queued', progress: 0 },
    },
    graph: {
      nodes: [
        { id: 'p0', kind: 'prompt', title: 'Prompt', x: 40, y: 130, w: 196, prompt: 'a harbor at dawn', ports: [{ kind: 'text', side: 'right', top: 52 }], footer: { left: 'x', right: '·' } },
        { ...withFlags(video, ['--seed', '42', '--off-peak']), id: 'v1', x: 400, y: 100 },
        { ...withFlags(image, ['--frobnicate', 'x']), id: 'r1', x: 400, y: 320 },
        { id: 'f1', kind: 'task', capability: 'image.generate', provider: 'fal', model: 'flux-dev', title: 'Interrupted fal image',
          params: { aspect_ratio: '16:9', count: 1 }, provider_params: {}, w: 244, x: 1000, y: 600,
          ports: [{ kind: 'image', side: 'left', top: 44, label: 'img 1', slot: 'images' }, { kind: 'image', side: 'left', top: 68, label: 'img 2', slot: 'images' }, { kind: 'text', side: 'left', top: 92, label: 'prompt', slot: 'prompt' }, { kind: 'image', side: 'right', top: 68 }] },
      ],
      edges: [{ from: { node: 'p0', port: 0 }, to: { node: 'v1', port: 1 } }],
    },
  }],
};
// load_graph returns the saved state as a JSON string.
fs.writeFileSync(path.join(root, 'legacy-state.json'), JSON.stringify(JSON.stringify(legacyState)));

const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const p = path.join(root, u === '/' ? 'index.html' : u);
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    const type = p.endsWith('.html') ? 'text/html' : p.endsWith('.json') ? 'application/json' : 'text/javascript';
    res.writeHead(200, { 'Content-Type': type });
    res.end(d);
  });
});
await new Promise(r => srv.listen(0, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
// Web fonts may be unreachable in sandboxes; that is not an app error.
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.goto(`http://localhost:${srv.address().port}/`);
await page.waitForFunction(() => (window.__listeners?.['mcp:op'] || []).length > 0, null, { timeout: 20000 });
await page.waitForTimeout(1000);

const results = {};
const check = (name, ok, detail) => { results[name] = ok ? 'PASS' : `FAIL ${JSON.stringify(detail)}`; };
const shot = async (name) => {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `${name}.png`) });
};
// Select a canvas node the way a click does (mousedown + mouseup without
// moving), without depending on which node happens to be on top.
const selectNode = async (id) => {
  await page.evaluate((nodeId) => {
    // The draggable header (cursor: grab) owns the node's mousedown handler.
    const el = document.querySelector(`[data-node-id="${nodeId}"] div[style*="cursor: grab"]`);
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, id);
  await page.waitForTimeout(300);
};
const mcp = (tool, args = {}) => page.evaluate(([t, a]) => window.__mcpCall(t, a), [tool, args]);
// Click an element with exactly this text inside the right-hand Inspector.
const inspectorClick = async (text) => {
  const all = page.getByText(text, { exact: true });
  for (let i = 0; i < await all.count(); i++) {
    const box = await all.nth(i).boundingBox();
    if (box && box.x > 1500 - 288) { await all.nth(i).click(); return; }
  }
  throw new Error(`no inspector element "${text}"`);
};

// 1. The legacy project is migrated on load, and saved back clean.
const g = await mcp('get_graph');
const v1 = g.nodes.find(n => n.id === 'v1');
const r1 = g.nodes.find(n => n.id === 'r1');
check('legacy video migrated', v1?.type === 'video.generate' && v1.provider === 'pixverse' && v1.params.seed === 42 && v1.params.off_peak === true && v1.params.duration_s === 5, v1);
check('unconvertible node kept raw', r1?.type === 'image.generate' && !!r1.params._raw_args, r1);
check('edge preserved', g.edges.some(e => e.from === 'p0' && e.to === 'v1' && e.to_port === 'prompt'), g.edges);
await page.waitForTimeout(1500);
const saved = await page.evaluate(() => window.__saved.at(-1));
check('saved config cleaned', saved && JSON.stringify(saved.config) === JSON.stringify({ binPaths: { ffmpeg: '', pixverse: '/opt/pv' }, paidRunLimit: 3 }), saved?.config);
check('saved nodes are task nodes', saved && saved.projects[0].graph.nodes.filter(n => n.kind === 'task').length === 3 && !JSON.stringify(saved).includes('sk-secret'), null);

// Object rest (`const { a, ...rest } = x`) must not be used in src/*.jsx: the
// files share one global scope and Babel's `_excluded` helper var collides.
const sig = await page.evaluate(() => [
  executionNodeSignature({ id: 'n', kind: 'task', model: 'a', x: 1, y: 2, title: 't1' }),
  executionNodeSignature({ id: 'n', kind: 'task', model: 'a', x: 9, y: 8, title: 't2' }),
  executionNodeSignature({ id: 'n', kind: 'task', model: 'b', x: 1, y: 2, title: 't1' }),
]);
check('moving or renaming a node keeps its results', sig[0] === sig[1] && sig[0] !== sig[2], sig);
check('migrated nodes drop legacy fields', saved && saved.projects[0].graph.nodes.filter(n => n.kind === 'task').every(n => !('cli' in n) && !('quality' in n)), saved?.projects[0].graph.nodes.map(n => Object.keys(n)));

// 2. MCP: legacy type aliases and param names, validation.
const add = await mcp('add_node', { type: 'video', params: { quality: '1080p', duration: '8', audio: false, model: 'kling-3.0-pro' } });
check('mcp add_node alias + legacy params', add.ok && add.type === 'video.generate' && add.params.resolution === '1080p' && add.params.duration_s === 8 && add.params.audio === false && add.model === 'kling-3.0-pro' && add.inputs.join() === 'src,prompt', add);
const bad = await mcp('set_params', { node_id: add.node_id, params: { template_id: '1' } });
check('mcp rejects unknown param', !!bad.error && bad.error.includes('template_id'), bad);
const badProvider = await mcp('add_node', { type: 'image.generate', params: { provider: 'replicate' } });
check('mcp rejects unknown provider', !!badProvider.error, badProvider);
const badType = await mcp('add_node', { type: 'hologram' });
check('mcp unknown type lists valid', !!badType.error && badType.error.includes('video.transition'), badType);
const music = await mcp('add_node', { type: 'music', params: { auto_lyrics: true } });
check('mcp exclusive toggles', music.ok && music.params.auto_lyrics === true && music.params.instrumental === undefined, music);
const conn = await mcp('connect_nodes', { from_node: 'p0', to_node: add.node_id, to_port: 'prompt' });
check('mcp connect by legacy port label', conn.ok, conn);
const rawEdit = await mcp('set_params', { node_id: 'r1', params: { seed: 3 } });
check('mcp refuses editing raw node', !!rawEdit.error, rawEdit);

// 3. Palette is grouped by capability.
const paletteText = await page.evaluate(() => document.body.innerText);
check('palette groups', ['IMAGE', 'VIDEO', 'AUDIO', 'EFFECTS', 'LOCAL'].every(x => paletteText.includes(x)) && paletteText.includes('Generate video') && !paletteText.includes('PixVerse · video'), null);

// 4. Inspector on the migrated node.
await selectNode('v1');
const inspector = await page.evaluate(() => document.body.innerText);
check('inspector sections', ['PROVIDER', 'MODEL', 'QUALITY', 'ASPECT RATIO', 'DURATION', 'GENERATION', 'FLAGS', 'ADVANCED', 'RESOLVED COMMAND'].every(x => inspector.includes(x)), null);
await inspectorClick('9:16');
await inspectorClick('multi-shot');
await inspectorClick('kling-3.0-pro');
await page.waitForTimeout(300);
let v1b = (await mcp('get_graph')).nodes.find(n => n.id === 'v1');
check('inspector edits apply', v1b.params.aspect_ratio === '9:16' && v1b.params.multi_shot === true && v1b.model === 'kling-3.0-pro', v1b);
await inspectorClick('off-peak');
await page.waitForTimeout(200);
v1b = (await mcp('get_graph')).nodes.find(n => n.id === 'v1');
check('inspector toggle clears', v1b.params.off_peak === undefined, v1b.params);

// 5. A node that kept its raw command can be reset to settings.
await selectNode('r1');
const rawText = await page.evaluate(() => document.body.innerText);
check('raw node notice', rawText.includes('CUSTOM COMMAND') && rawText.includes('--frobnicate'), null);
await page.getByText('Reset to standard settings').click();
await page.waitForTimeout(300);
const r1b = (await mcp('get_graph')).nodes.find(n => n.id === 'r1');
check('raw node reset', !r1b.params._raw_args && r1b.params.resolution === '1080p', r1b);

// 7. Switch the migrated video node to fal.ai.
await selectNode('v1');
const providerSelect = page.locator('select').filter({ has: page.locator('option[value="fal"]') }).first();
await providerSelect.selectOption('fal');
await page.waitForTimeout(400);
let v1c = (await mcp('get_graph')).nodes.find(n => n.id === 'v1');
let text = await page.evaluate(() => document.body.innerText);
check('switch to fal keeps what fits', v1c.provider === 'fal' && v1c.model === 'kling-2.5-turbo-pro' && v1c.params.duration_s === 5 && v1c.params.aspect_ratio === '9:16' && v1c.params.seed === undefined && v1c.params.timeout === undefined, v1c);
check('switch notice lists adjustments', /Adjusted for fal\.ai: .*seed removed/.test(text), null);
check('missing key warning', text.includes('No fal.ai API key'), null);

// 8. Save a key in Config; the warning clears.
await page.getByText('add it in Config').click();
await page.waitForTimeout(300);
await page.locator('input[type="password"]').first().fill('fal-test-key');
await page.getByText('Save', { exact: true }).click();
await page.waitForTimeout(300);
await shot('config-provider-keys');
text = await page.evaluate(() => document.body.innerText);
check('key saved via Keychain command', (await page.evaluate(() => window.__keys.fal)) === 'fal-test-key' && text.includes('KEY SET'), null);
await page.getByText('Done', { exact: true }).click();
await page.waitForTimeout(300);
text = await page.evaluate(() => document.body.innerText);
check('warning cleared after save', !text.includes('No fal.ai API key'), null);

// 9. Model switch clamps values the new model doesn't offer.
await inspectorClick('veo-3.1-fast');
await page.waitForTimeout(300);
await shot('inspector-fal-veo');
v1c = (await mcp('get_graph')).nodes.find(n => n.id === 'v1');
text = await page.evaluate(() => document.body.innerText);
check('veo clamps duration to its default', v1c.model === 'veo-3.1-fast' && v1c.params.duration_s === 8 && text.includes('duration_s 5 → 8'), v1c.params);
check('model-specific options shown', text.includes('RESOLUTION') && !text.includes('CFG SCALE'), null);

// 10. MCP against fal: provider switch, strict validation.
const falImg = await mcp('add_node', { type: 'image.generate', params: { provider: 'fal', model: 'nano-banana', aspect_ratio: '21:9', count: 2 } });
check('mcp adds fal node', falImg.ok && falImg.provider === 'fal' && falImg.model === 'nano-banana' && falImg.params.aspect_ratio === '21:9' && falImg.params.count === 2, falImg);
const badDur = await mcp('set_params', { node_id: 'v1', params: { duration_s: 5 } });
check('mcp strict option check', !!badDur.error && badDur.error.includes('4, 6, 8'), badDur);
const badModel = await mcp('set_params', { node_id: 'v1', params: { model: 'sora-9' } });
check('mcp strict model check', !!badModel.error && badModel.error.includes('veo-3.1-fast'), badModel);
const unsupported = await mcp('set_params', { node_id: falImg.node_id, params: { guidance_scale: 3 } });
check('mcp per-model param check', !!unsupported.error && unsupported.error.includes('nano-banana'), unsupported);

// 12. Resume a fal run interrupted by quitting the app.
const interrupted = await mcp('get_node_result', { node_id: 'f1' });
check('in-flight fal run reloads as interrupted', interrupted.state === 'interrupted' && /Resume/.test(interrupted.note || ''), interrupted);
const queuedGone = await mcp('get_node_result', { node_id: 'p0' });
check('queued-only result is dropped', queuedGone.state === 'idle', queuedGone);
await mcp('switch_project', { project_id: 'p_legacy' });
await page.evaluate(() => {
  // Select f1 through the canvas: it sits off-screen at (1000, 600).
  document.querySelector('[data-node-id="f1"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }));
});
await page.waitForTimeout(300);
let resumeBtn = page.getByText('Resume', { exact: true });
if (!(await resumeBtn.count())) {
  await page.evaluate(() => document.querySelector('[data-node-id="f1"]').scrollIntoView());
  await selectNode('f1');
  await page.waitForTimeout(300);
}
await shot('inspector-resume');
await page.getByText('Resume', { exact: true }).first().click();
await page.waitForTimeout(400);
const resumed = await mcp('get_node_result', { node_id: 'f1' });
check('resume collects the result', resumed.state === 'done' && resumed.outputs?.[0]?.path === '/tmp/resumed.png', resumed);

// 13. Compare via MCP: two fal variants of the PixVerse video node.
const cmp = await mcp('compare_node', { node_id: add.node_id, variants: [{ provider: 'fal', model: 'veo-3.1-fast' }, { provider: 'fal', model: 'kling-2.5-turbo-pro' }] });
check('compare_node creates variants and a pick', cmp.ok && cmp.variant_node_ids.length === 2 && !!cmp.pick_node_id, cmp);
let g2 = await mcp('get_graph');
const veoVariant = g2.nodes.find(n => n.id === cmp.variant_node_ids[0]);
// PixVerse's 8 s is valid for Veo; PixVerse-only settings are dropped and reported.
check('variant settings fitted to the model', veoVariant.provider === 'fal' && veoVariant.model === 'veo-3.1-fast' && veoVariant.params.duration_s === 8 && veoVariant.params.timeout === undefined
  && (cmp.adjusted_params?.[veoVariant.id] || []).includes('timeout removed'), { veoVariant, adjusted: cmp.adjusted_params });
const into = id => g2.edges.filter(e => e.to === id);
check('variants share the original inputs', cmp.variant_node_ids.every(id => into(id).some(e => e.from === 'p0' && e.to_port === 'prompt')), g2.edges);
check('pick is fed by original + variants', into(cmp.pick_node_id).length === 3, into(cmp.pick_node_id));
const badCmp = await mcp('compare_node', { node_id: add.node_id, variants: [{ provider: 'fal', model: 'sora-9' }] });
check('compare_node rejects unknown variants', !!badCmp.error && badCmp.error.includes('options:'), badCmp);

// 14. Budget gate: limit 2, the comparison submits 3 paid runs → confirm.
await page.getByText('Config', { exact: true }).first().click();
await page.waitForTimeout(300);
const limitInput = page.locator('input[inputmode="numeric"]').last();
await limitInput.fill('2');
await limitInput.press('Enter');
await page.getByText('Done', { exact: true }).click();
await page.waitForTimeout(200);
const run = await mcp('run_node', { node_id: cmp.pick_node_id });
check('run reports confirmation needed', run.ok && run.paid_generations === 3 && run.needs_user_confirmation === true, run);
await page.waitForTimeout(300);
const waitingConfirm = await mcp('get_node_result', { node_id: cmp.pick_node_id });
text = await page.evaluate(() => document.body.innerText);
check('confirmation dialog shown', waitingConfirm.state === 'waiting_for_confirmation' && text.includes('Run 3 paid generations?') && (await page.evaluate(() => window.__runs.length)) === 0, waitingConfirm);
await shot('paid-run-confirm');
await page.getByText('Run 3', { exact: true }).click();

// 15. The failed Veo variant doesn't block the Pick; the others are offered.
let pickState;
for (let i = 0; i < 40; i++) {
  pickState = await mcp('get_node_result', { node_id: cmp.pick_node_id });
  if (pickState.state === 'waiting_for_pick') break;
  await page.waitForTimeout(100);
}
check('pick proceeds without the failed variant', pickState.state === 'waiting_for_pick' && pickState.candidates === 2, pickState);
const veoResult = await mcp('get_node_result', { node_id: cmp.variant_node_ids[0] });
check('failed variant reports its error', veoResult.state === 'error' && /safety checker/.test(veoResult.error || ''), veoResult);
await page.evaluate(() => window.AtlasRunner.pick(1));
await page.waitForTimeout(400);
const picked = await mcp('get_node_result', { node_id: cmp.pick_node_id });
check('pick completes', picked.state === 'done', picked);
const pvCost = await mcp('get_node_result', { node_id: add.node_id });
check('PixVerse credits recorded', pvCost.cost?.amount === 30 && pvCost.cost?.unit === 'PixVerse credits', pvCost);
const errorClose = page.getByText('Close', { exact: true });
if (await errorClose.count()) await errorClose.first().click();
await page.keyboard.press('Escape');
await page.mouse.click(700, 700);
await page.waitForTimeout(300);
text = await page.evaluate(() => document.body.innerText);
check('graph shows reported spend', /REPORTED SPEND[\s\S]*30 PixVerse credits/.test(text), null);

// 16. Compare from the Inspector.
await selectNode('v1');
await inspectorClick('Compare with other models…');
await inspectorClick('fal.ai · Hailuo-02 Standard');
await shot('inspector-compare');
await inspectorClick('Create comparison (2 runs)');
await page.waitForTimeout(300);
const g3 = await mcp('get_graph');
const uiPick = g3.nodes.find(n => n.type === 'pick' && n.id !== cmp.pick_node_id);
check('inspector comparison built', !!uiPick && g3.edges.filter(e => e.to === uiPick.id).length === 2 && g3.nodes.some(n => n.model === 'hailuo-02-standard'), uiPick);

// 17. ComfyUI: import a workflow through MCP, rebind, run for free.
const comfyGraph = {
  3: { class_type: 'KSampler', inputs: { seed: 42, steps: 20, cfg: 7, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['12', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'a castle', clip: ['4', 1] }, _meta: { title: 'Positive' } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] }, _meta: { title: 'Negative' } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
  10: { class_type: 'LoadImage', inputs: { image: 'example.png' }, _meta: { title: 'Reference' } },
  12: { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
  20: { class_type: 'PreviewImage', inputs: { images: ['8', 0] } },
};
const comfy = await mcp('add_node', { type: 'comfyui', params: { workflow: JSON.stringify(comfyGraph), workflow_name: 'sdxl img2img', seed: 7 } });
check('mcp imports a ComfyUI workflow', comfy.ok && comfy.type === 'comfyui.workflow' && comfy.provider === 'comfyui' && comfy.params.seed === 7
  && comfy.inputs.join() === 'prompt,Reference' && comfy.workflow?.prompt === '#6 Positive.text' && comfy.workflow?.negative === '#7 Negative.text'
  && comfy.workflow?.output === '#9 SaveImage' && comfy.workflow?.seed?.[0] === '#3 KSampler.seed' && comfy.title === 'ComfyUI · sdxl img2img', comfy);
const uiFormat = await mcp('add_node', { type: 'comfyui', params: { workflow: { nodes: [], links: [] } } });
check('mcp explains the editor format', !!uiFormat.error && uiFormat.error.includes('Export (API)'), uiFormat);
const badBinding = await mcp('set_params', { node_id: comfy.node_id, params: { bindings: { prompt: { node: '3', input: 'positive' } } } });
check('mcp rejects a binding onto a wired input', !!badBinding.error && badBinding.error.includes('wired'), badBinding);
const notComfy = await mcp('set_params', { node_id: falImg.node_id, params: { workflow: comfyGraph } });
check('workflow only on ComfyUI nodes', !!notComfy.error, notComfy);
await mcp('connect_nodes', { from_node: 'p0', to_node: comfy.node_id, to_port: 'prompt' });
const imgEdge = await mcp('connect_nodes', { from_node: 'f1', to_node: comfy.node_id, to_port: 'Reference' });
const seedless = await mcp('set_params', { node_id: comfy.node_id, params: { count: 2 } });
check('count allowed with a seed input', seedless.ok && seedless.params.count === 2, seedless);
const rebound = await mcp('set_params', { node_id: comfy.node_id, params: { bindings: { inputs: [], seed: [] } } });
let g4 = await mcp('get_graph');
const comfyEdges = g4.edges.filter(e => e.to === comfy.node_id);
check('rebinding drops the unbound port and its edge only', imgEdge.ok && rebound.ok && comfyEdges.length === 1 && comfyEdges[0].from === 'p0' && comfyEdges[0].to_port === 'prompt'
  && rebound.params.seed === undefined && rebound.params.count === undefined, { rebound, comfyEdges });
const comfyRun = await mcp('run_node', { node_id: comfy.node_id });
await page.waitForTimeout(250);
const comfyLive = await mcp('get_node_result', { node_id: comfy.node_id });
const liveFooter = await page.evaluate((id) => document.querySelector(`[data-node-id="${id}"] [data-testid="node-footer-left"]`)?.innerText, comfy.node_id);
const liveLog = await page.evaluate(() => document.body.innerText.includes('#3 KSampler 12/20'));
check('ComfyUI step shown while running', comfyLive.state === 'running' && comfyLive.detail === '#3 KSampler 12/20' && comfyLive.progress === 0.6
  && liveFooter === '#3 KSampler 12/20' && liveLog, { comfyLive, liveFooter });
await page.waitForTimeout(800);
const doneFooter = await page.evaluate((id) => document.querySelector(`[data-node-id="${id}"] [data-testid="node-footer-left"]`)?.innerText, comfy.node_id);
check('step detail cleared when done', doneFooter && !doneFooter.includes('KSampler'), doneFooter);
const comfyResult = await mcp('get_node_result', { node_id: comfy.node_id });
const sentNode = await page.evaluate(() => window.__lastNode);
check('ComfyUI run is not a paid generation', comfyRun.ok && !comfyRun.needs_user_confirmation && !comfyRun.paid_generations && comfyResult.state === 'done', { comfyRun, comfyResult });
check('run sends the workflow to Rust', sentNode?.provider === 'comfyui' && sentNode.workflow?.graph?.['10']?.class_type === 'LoadImage' && sentNode.workflow.bindings.inputs.length === 0, sentNode?.workflow?.bindings);
const localNotCounted = await page.evaluate(() => paidRunSummary({ nodes: [
  { id: 'c', kind: 'task', provider: 'comfyui', capability: 'comfyui.workflow' },
  { id: 'f', kind: 'task', provider: 'fal', capability: 'image.generate' }] }, ['c', 'f']));
check('paid-run count skips local providers', localNotCounted.total === 1 && !localNotCounted.byProvider.comfyui, localNotCounted);

// 18. ComfyUI in the Inspector: paste a workflow into a fresh node.
const fresh = await mcp('add_node', { type: 'comfyui.workflow', x: 60, y: 560 });
await selectNode(fresh.node_id);
text = await page.evaluate(() => document.body.innerText);
check('empty ComfyUI node asks for a workflow', text.includes('Export (API)') && text.includes('Import workflow…') && !text.includes('Compare with other models…'), null);
await inspectorClick('Paste JSON');
await page.locator('[data-testid="comfy-paste"]').fill('{"nodes": [], "links": []}');
await inspectorClick('Use this workflow');
await page.waitForTimeout(200);
text = await page.evaluate(() => document.body.innerText);
check('Inspector explains the editor format', text.includes('This is the ComfyUI editor format'), null);
await page.locator('[data-testid="comfy-paste"]').fill(JSON.stringify(comfyGraph));
await inspectorClick('Use this workflow');
await page.waitForTimeout(300);
await shot('inspector-comfyui');
let freshNode = (await mcp('get_graph')).nodes.find(n => n.id === fresh.node_id);
text = await page.evaluate(() => document.body.innerText);
check('Inspector import suggests bindings', freshNode.inputs?.join() === 'prompt,Reference' && text.includes('PROMPT GOES TO') && text.includes('RESULT')
  && text.includes('SEED') && await page.locator('[data-testid="comfy-prompt"]').inputValue() === '6|text', freshNode);
await page.locator('[data-testid="comfy-output"]').selectOption('20');
await page.locator('[data-testid="comfy-prompt"]').selectOption('');
await page.waitForTimeout(300);
freshNode = (await mcp('get_graph')).nodes.find(n => n.id === fresh.node_id);
check('Inspector rebinding updates ports and output', freshNode.inputs?.join() === 'Reference' && freshNode.workflow?.output === '#20 PreviewImage' && freshNode.workflow?.prompt === null, freshNode);
const saved2 = await page.evaluate(() => window.__saved.at(-1));
const savedFresh = saved2.projects.find(p => p.graph.nodes.some(n => n.id === fresh.node_id)).graph.nodes.find(n => n.id === fresh.node_id);
check('workflow saved with the project', savedFresh.workflow?.graph?.['9']?.class_type === 'SaveImage' && savedFresh.workflow.bindings.output === '20' && savedFresh.workflow.name === 'workflow', savedFresh.workflow?.bindings);

// 19. ComfyUI server address in Config.
await page.getByText('Config', { exact: true }).first().click();
await page.waitForTimeout(300);
text = await page.evaluate(() => document.body.innerText);
check('Config shows the ComfyUI server', text.includes('COMFYUI SERVER') && await page.locator('[data-testid="comfyui-url"]').getAttribute('placeholder') === 'http://127.0.0.1:8188', null);
await page.locator('[data-testid="comfyui-url"]').fill('192.168.1.20:8188');
await page.locator('[data-testid="comfyui-url"]').press('Enter');
text = await page.evaluate(() => document.body.innerText);
check('Config rejects an address without a scheme', text.includes('must start with http://'), null);
await page.locator('[data-testid="comfyui-url"]').fill('http://192.168.1.20:8188');
await page.locator('[data-testid="comfyui-url"]').press('Enter');
await page.getByText('Done', { exact: true }).click();
await page.waitForTimeout(1500);
const saved3 = await page.evaluate(() => window.__saved.at(-1));
check('ComfyUI server saved in config', saved3.config.comfyuiUrl === 'http://192.168.1.20:8188', saved3.config);

// 20. Compare a ComfyUI node against cloud models.
const cmpComfy = await mcp('add_node', { type: 'comfyui', x: 1400, y: 1400, params: { workflow: comfyGraph, workflow_name: 'local sdxl', seed: 7, count: 6, negative_prompt: 'blurry text' } });
const sink = await mcp('add_node', { type: 'output', x: 1800, y: 1400 });
await mcp('connect_nodes', { from_node: 'f1', to_node: cmpComfy.node_id, to_port: 'Reference' });
await mcp('connect_nodes', { from_node: cmpComfy.node_id, to_node: sink.node_id });
const toComfy = await mcp('compare_node', { node_id: cmpComfy.node_id, variants: [{ provider: 'comfyui' }] });
check('bare ComfyUI (no workflow) is not a comparison target', !!toComfy.error && toComfy.error.startsWith('comfyui cannot run') && toComfy.error.includes('fal/flux-dev'), toComfy);
const emptyCmp = await mcp('compare_node', { node_id: fresh.node_id === undefined ? 'x' : (await mcp('add_node', { type: 'comfyui', x: 1400, y: 1700 })).node_id, variants: [{ provider: 'fal', model: 'flux-dev' }] });
check('ComfyUI node needs a workflow to compare', !!emptyCmp.error && emptyCmp.error.includes('import a ComfyUI workflow'), emptyCmp);
const cc = await mcp('compare_node', { node_id: cmpComfy.node_id, variants: [{ provider: 'fal', model: 'flux-dev' }, { provider: 'fal', model: 'nano-banana' }] });
const g5 = await mcp('get_graph');
const flux = g5.nodes.find(n => n.id === cc.variant_node_ids?.[0]);
const banana = g5.nodes.find(n => n.id === cc.variant_node_ids?.[1]);
check('ComfyUI compare creates cloud stand-ins', cc.ok && flux?.type === 'image.generate' && flux.provider === 'fal' && flux.model === 'flux-dev' && banana?.model === 'nano-banana', { cc, flux, banana });
check('settings carried and fitted', flux.params.seed === 7 && flux.params.count === 4 && flux.params.negative_prompt === undefined
  && ['count 6 → 4', 'negative_prompt not supported', 'prompt taken from the workflow'].every(c => (cc.adjusted_params?.[flux.id] || []).includes(c)), { params: flux.params, changes: cc.adjusted_params });
check('workflow prompt stands in when none is connected', flux.prompt === 'a castle', flux.prompt);
const into5 = id => g5.edges.filter(e => e.to === id);
check('ComfyUI inputs rewired to the stand-in ports', into5(flux.id).length === 1 && into5(flux.id)[0].from === 'f1' && into5(flux.id)[0].to_port === 'img 1', into5(flux.id));
check('ComfyUI compare feeds a pick and moves downstream', into5(cc.pick_node_id).length === 3 && into5(sink.node_id).length === 1 && into5(sink.node_id)[0].from === cc.pick_node_id, { pick: into5(cc.pick_node_id), sink: into5(sink.node_id) });
await page.waitForTimeout(1200);
const savedCmp = await page.evaluate(() => window.__saved.at(-1));
const cmpGraph = savedCmp.projects.find(p => p.graph.nodes.some(n => n.id === cc.pick_node_id)).graph;
const fromOutputs = cmpGraph.edges.filter(e => e.to.node === cc.pick_node_id).every(e => {
  const src = cmpGraph.nodes.find(n => n.id === e.from.node);
  return src.ports[e.from.port]?.side === 'right';
});
check('pick is fed from each node\'s own output port', fromOutputs, cmpGraph.edges.filter(e => e.to.node === cc.pick_node_id));
const ccRun = await mcp('run_node', { node_id: cc.pick_node_id });
check('only the cloud variants are paid', ccRun.ok && ccRun.paid_generations === 2 && !ccRun.needs_user_confirmation, ccRun);
await page.waitForTimeout(1500);
const ccPick = await mcp('get_node_result', { node_id: cc.pick_node_id });
check('pick offers the ComfyUI and cloud results', ccPick.state === 'waiting_for_pick' && ccPick.candidates === 3, ccPick);
// Pick the local result: it flows on as the original's output did.
await page.evaluate(() => window.AtlasRunner.pick(0));
await page.waitForTimeout(400);
const ccPicked = await mcp('get_node_result', { node_id: cc.pick_node_id });
check('picked ComfyUI result flows on', ccPicked.state === 'done' && (ccPicked.outputs?.find(o => o.chosen) || ccPicked.outputs?.[0])?.path === `/tmp/${cmpComfy.node_id}.png`, ccPicked);
// The Inspector offers the same comparison.
await selectNode(cmpComfy.node_id);
text = await page.evaluate(() => document.body.innerText);
if (text.includes('Compare with other models…')) await inspectorClick('Compare with other models…');
text = await page.evaluate(() => document.body.innerText);
const compareBlock = text.slice(text.indexOf('COMPARE'), text.indexOf('Create comparison'));
check('Inspector compares ComfyUI with cloud models', compareBlock.includes('fal.ai · FLUX.1 [dev]') && compareBlock.includes('This ComfyUI run is free')
  && !compareBlock.split('\n').some(line => line.trim() === 'ComfyUI') && compareBlock.includes('ComfyUI · sdxl img2img'), compareBlock);

// 21. The other way: a cloud node compared against ComfyUI workflows on the canvas.
await mcp('connect_nodes', { from_node: 'p0', to_node: falImg.node_id, to_port: 'prompt' });
await mcp('connect_nodes', { from_node: 'f1', to_node: falImg.node_id, to_port: 'img 1' });
const badWf = await mcp('compare_node', { node_id: falImg.node_id, variants: [{ provider: 'comfyui', workflow_node: 'v1' }] });
check('workflow target must be a ComfyUI node', !!badWf.error && badWf.error.includes('"v1" is not a ComfyUI node'), badWf);
const listed = await mcp('compare_node', { node_id: falImg.node_id, variants: [{ provider: 'comfyui' }] });
check('options list the canvas workflows', !!listed.error && listed.error.includes(`comfyui with workflow_node ${cmpComfy.node_id}`), listed);
const toWf = await mcp('compare_node', { node_id: falImg.node_id, variants: [
  { provider: 'comfyui', workflow_node: cmpComfy.node_id },
  { provider: 'comfyui', workflow_node: fresh.node_id },
] });
let g6 = await mcp('get_graph');
const wfA = g6.nodes.find(n => n.id === toWf.variant_node_ids?.[0]);
const wfB = g6.nodes.find(n => n.id === toWf.variant_node_ids?.[1]);
const into6 = id => g6.edges.filter(e => e.to === id);
check('cloud node compared with ComfyUI workflows', toWf.ok && wfA?.type === 'comfyui.workflow' && wfA.title === 'ComfyUI · local sdxl'
  && wfA.inputs.join() === 'prompt,Reference' && wfA.params.count === 2 && wfB?.workflow?.name === 'workflow', { toWf, wfA, wfB });
check('inputs wired into the workflow ports', into6(wfA.id).map(e => `${e.from}>${e.to_port}`).sort().join() === 'f1>Reference,p0>prompt'
  && into6(wfB.id).map(e => `${e.from}>${e.to_port}`).join() === 'f1>Reference', { a: into6(wfA.id), b: into6(wfB.id) });
check('unusable prompt listed', (toWf.adjusted_params?.[wfB.id] || []).includes('input "prompt" not connected (no free port)'), toWf.adjusted_params);
await mcp('set_params', { node_id: cmpComfy.node_id, params: { workflow_name: 'renamed later' } });
g6 = await mcp('get_graph');
check('copies run their own workflow copy', g6.nodes.find(n => n.id === wfA.id).workflow.name === 'local sdxl', null);
const wfRun = await mcp('run_node', { node_id: toWf.pick_node_id });
check('ComfyUI variants are free', wfRun.ok && wfRun.paid_generations === 1 && !wfRun.needs_user_confirmation, wfRun);
await page.waitForTimeout(2000);
const wfPick = await mcp('get_node_result', { node_id: toWf.pick_node_id });
check('pick offers the cloud and ComfyUI results', wfPick.state === 'waiting_for_pick' && wfPick.candidates === 3, wfPick);
await page.evaluate(() => window.AtlasRunner.pick(1));
await page.waitForTimeout(400);
const wfPicked = await mcp('get_node_result', { node_id: toWf.pick_node_id });
check('picked ComfyUI variant flows on', wfPicked.state === 'done' && wfPicked.outputs?.find(o => o.chosen)?.path === `/tmp/${wfA.id}.png`, wfPicked);
// ComfyUI against another ComfyUI workflow.
const wfVsWf = await mcp('compare_node', { node_id: comfy.node_id, variants: [{ provider: 'comfyui', workflow_node: cmpComfy.node_id }] });
const g7 = await mcp('get_graph');
const wfC = g7.nodes.find(n => n.id === wfVsWf.variant_node_ids?.[0]);
check('ComfyUI compared with another workflow', wfVsWf.ok && wfC?.workflow?.name === 'renamed later' && g7.edges.some(e => e.to === wfC.id && e.from === 'p0' && e.to_port === 'prompt'), { wfVsWf, wfC });
// The active project's graph as last autosaved.
const liveGraph = async () => {
  await page.waitForTimeout(1200);
  const saved = await page.evaluate(() => window.__saved.at(-1));
  return saved.projects.find(p => p.id === saved.activeProjectId).graph;
};
// A copy never shares the source's workflow object: mutate the source in
// place (as any future in-place edit would) and the copy must not change.
const aliasing = await page.evaluate(([g, srcId, fromId]) => {
  const graph = JSON.parse(JSON.stringify(g));
  const result = buildComparison(graph, fromId, [{ provider: 'comfyui', workflow_node: srcId }]);
  const copy = result.graph.nodes.find(n => n.id === result.variantIds[0]);
  const source = result.graph.nodes.find(n => n.id === srcId);
  source.workflow.graph['6'].inputs.text = 'mutated';
  source.workflow.bindings.seed.push({ node: '99', input: 'seed' });
  source.workflow.name = 'mutated';
  return { text: copy.workflow.graph['6'].inputs.text, seeds: copy.workflow.bindings.seed.length, name: copy.workflow.name };
}, [await liveGraph(), cmpComfy.node_id, falImg.node_id]);
check('copy has its own workflow (no shared objects)', aliasing.text === 'a castle' && aliasing.seeds === 1 && aliasing.name === 'renamed later', aliasing);
// The original's own prompt goes only to workflows with a prompt input.
const kite = await mcp('add_node', { type: 'image.generate', x: 2200, y: 1400, params: { provider: 'fal', model: 'flux-dev', prompt: 'a red kite' } });
const kiteCmp = await mcp('compare_node', { node_id: kite.node_id, variants: [
  { provider: 'comfyui', workflow_node: cmpComfy.node_id },
  { provider: 'comfyui', workflow_node: fresh.node_id },
] });
const g8 = await mcp('get_graph');
const withPrompt = g8.nodes.find(n => n.id === kiteCmp.variant_node_ids?.[0]);
const noPrompt = g8.nodes.find(n => n.id === kiteCmp.variant_node_ids?.[1]);
check('own prompt passed to a workflow with a prompt input', kiteCmp.ok && withPrompt?.prompt === 'a red kite' && !(kiteCmp.adjusted_params?.[withPrompt.id] || []).some(c => c.startsWith('prompt')), { withPrompt, changes: kiteCmp.adjusted_params });
check('own prompt withheld from a workflow without one', noPrompt && noPrompt.prompt === undefined
  && (kiteCmp.adjusted_params?.[noPrompt.id] || []).includes('prompt not used (the workflow has no prompt input)'), { noPrompt, changes: kiteCmp.adjusted_params });

// The Inspector lists the workflows, marking same-named ones by node id.
await selectNode(falImg.node_id);
text = await page.evaluate(() => document.body.innerText);
if (text.includes('Compare with other models…')) await inspectorClick('Compare with other models…');
text = await page.evaluate(() => document.body.innerText);
check('Inspector offers canvas workflows', text.includes('ComfyUI · local sdxl') && text.includes(`ComfyUI · workflow (${fresh.node_id})`) && text.includes('ComfyUI workflows run free'), null);

// 11. Clicking a palette entry adds a task node (last: it may land on top of other nodes).
const before = (await mcp('get_graph')).nodes.length;
await page.getByText('Upscale video', { exact: true }).first().click();
await page.waitForTimeout(400);
const after = await mcp('get_graph');
const upscale = after.nodes.find(n => n.type === 'video.upscale');
check('palette adds task node', after.nodes.length === before + 1 && upscale && upscale.id.startsWith('gen') && upscale.params.resolution === '2160p', upscale);

check('no page errors', errors.length === 0, errors);

await browser.close();
srv.close();
fs.rmSync(root, { recursive: true, force: true });
const failed = Object.entries(results).filter(([, v]) => v !== 'PASS');
for (const [name, v] of Object.entries(results)) console.log(`${v === 'PASS' ? 'ok  ' : 'FAIL'} ${name}${v === 'PASS' ? '' : `: ${v.slice(5)}`}`);
console.log(`${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`);
process.exit(failed.length ? 1 : 0);
