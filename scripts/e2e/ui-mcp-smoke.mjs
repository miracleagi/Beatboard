#!/usr/bin/env node
// End-to-end smoke test of the web UI and the MCP bridge, in headless Chromium
// with the Tauri backend stubbed out.
//
// It loads a saved state from before P1 (legacy PixVerse argv nodes, API keys
// in config), then checks that the project is migrated to task nodes, that the
// Inspector and palette work, and that MCP calls from older agents (short type
// names such as `video`, old param names such as `quality`) keep working.
// It also covers fal.ai: switching a node's provider and model, the API-key
// flow in Config, and MCP validation against per-model constraints.
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
    id: 'p_legacy', name: 'Legacy', color: '#7fc8ff', outputDir: '', modifiedAt: 1, runResults: {},
    graph: {
      nodes: [
        { id: 'p0', kind: 'prompt', title: 'Prompt', x: 40, y: 130, w: 196, prompt: 'a harbor at dawn', ports: [{ kind: 'text', side: 'right', top: 52 }], footer: { left: 'x', right: '·' } },
        { ...withFlags(video, ['--seed', '42', '--off-peak']), id: 'v1', x: 400, y: 100 },
        { ...withFlags(image, ['--frobnicate', 'x']), id: 'r1', x: 400, y: 320 },
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
check('saved config cleaned', saved && JSON.stringify(saved.config) === JSON.stringify({ binPaths: { ffmpeg: '', pixverse: '/opt/pv' } }), saved?.config);
check('saved nodes are task nodes', saved && saved.projects[0].graph.nodes.filter(n => n.kind === 'task').length === 2 && !JSON.stringify(saved).includes('sk-secret'), null);

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
check('palette groups', ['IMAGE', 'VIDEO', 'AUDIO', 'EFFECTS'].every(x => paletteText.includes(x)) && paletteText.includes('Generate video') && !paletteText.includes('PixVerse · video'), null);

// 4. Inspector on the migrated node.
await page.click('[data-node-id="v1"]', { position: { x: 60, y: 12 } });
await page.waitForTimeout(400);
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
await page.click('[data-node-id="r1"]', { position: { x: 60, y: 12 } });
await page.waitForTimeout(300);
const rawText = await page.evaluate(() => document.body.innerText);
check('raw node notice', rawText.includes('CUSTOM COMMAND') && rawText.includes('--frobnicate'), null);
await page.getByText('Reset to standard settings').click();
await page.waitForTimeout(300);
const r1b = (await mcp('get_graph')).nodes.find(n => n.id === 'r1');
check('raw node reset', !r1b.params._raw_args && r1b.params.resolution === '1080p', r1b);

// 7. Switch the migrated video node to fal.ai.
await page.click('[data-node-id="v1"]', { position: { x: 60, y: 12 } });
await page.waitForTimeout(300);
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
