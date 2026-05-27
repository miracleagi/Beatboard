#!/usr/bin/env node
import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = path.resolve(process.env.ATLAS_WORKDIR || process.cwd());
const PORT = Number(process.env.ATLAS_PORT || 4173);
const HOST = process.env.ATLAS_HOST || '127.0.0.1';
const MAX_BODY = 2 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
};

const PIXVERSE_OUTPUT_DIR = path.join(WORK_ROOT, '.atlas-runs', 'pixverse');
const FFMPEG_OUTPUT_DIR = path.join(WORK_ROOT, '.atlas-runs', 'ffmpeg');
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif)(?:[?#].*)?$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v)(?:[?#].*)?$/i;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function basename(cmd) {
  return String(cmd || '').trim().split(/\s+/)[0].split(/[\\/]/).pop();
}

function firstPrompt(node, deps) {
  if (node.prompt) return node.prompt;
  const dep = (deps || []).find(d => d.from?.kind === 'prompt' && d.from.prompt);
  const connectedPrompt = dep?.from?.prompt || '';
  if (node.kind === 'motion' && connectedPrompt && node.motionPrompt) {
    return `${connectedPrompt}\nMotion: ${node.motionPrompt}`;
  }
  if (connectedPrompt) return connectedPrompt;
  if (node.motionPrompt) return node.motionPrompt;
  return '';
}

function promptForPixVerse(node, deps) {
  const prompt = firstPrompt(node, deps);
  return String(prompt || '')
    .replace(/\*\*/g, '')
    .trim();
}

function unwrapResult(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.pixverse) return unwrapResult(value.pixverse);
  if (value.data) return unwrapResult(value.data);
  if (value.result) return unwrapResult(value.result);
  return value;
}

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(String(value || '')) || /^data:/i.test(String(value || ''));
}

function hasMediaExt(value, type) {
  const s = String(value || '').split('?')[0];
  return type === 'video' ? VIDEO_EXT_RE.test(s) : IMAGE_EXT_RE.test(s);
}

function isPathInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function urlPathFromRelative(rel) {
  return '/' + rel.split(path.sep).map(encodeURIComponent).join('/');
}

function staticUrlForPath(value) {
  if (!value || isRemoteUrl(value)) return '';
  const raw = String(value);
  const abs = path.isAbsolute(raw) ? raw : path.resolve(WORK_ROOT, raw);
  if (isPathInside(APP_ROOT, abs)) return urlPathFromRelative(path.relative(APP_ROOT, abs));
  if (isPathInside(WORK_ROOT, abs)) return urlPathFromRelative(path.relative(WORK_ROOT, abs));
  return '';
}

function mediaKeys(type) {
  if (type === 'video') {
    return {
      url: ['video_url', 'videoUrl', 'media_url', 'mediaUrl', 'download_url', 'downloadUrl', 'url', 'src'],
      path: ['path', 'output', 'file', 'file_path', 'filePath', 'local_path', 'localPath'],
      id: ['video_id', 'videoId', 'asset_id', 'assetId', 'id', 'task_id', 'taskId'],
      arrays: ['videos', 'assets', 'items', 'outputs', 'records'],
    };
  }
  return {
    url: ['image_url', 'imageUrl', 'media_url', 'mediaUrl', 'download_url', 'downloadUrl', 'url', 'src'],
    path: ['path', 'output', 'file', 'file_path', 'filePath', 'local_path', 'localPath'],
    id: ['image_id', 'imageId', 'asset_id', 'assetId', 'id', 'task_id', 'taskId'],
    arrays: ['images', 'assets', 'items', 'outputs', 'records'],
  };
}

function collectAssetCandidates(input, type, out = [], seen = new Set()) {
  const value = unwrapResult(input);
  if (value == null) return out;
  if (typeof value === 'string') {
    const v = value.trim();
    if (isRemoteUrl(v) || hasMediaExt(v, type)) out.push({ kind: 'url', value: v });
    return out;
  }
  if (typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach(item => collectAssetCandidates(item, type, out, seen));
    return out;
  }

  const keys = mediaKeys(type);
  keys.url.forEach(key => {
    if (typeof value[key] === 'string' && value[key].trim()) out.push({ kind: 'url', value: value[key].trim(), key });
  });
  keys.path.forEach(key => {
    if (typeof value[key] === 'string' && value[key].trim()) out.push({ kind: 'path', value: value[key].trim(), key });
  });
  keys.id.forEach(key => {
    if (typeof value[key] === 'string' && value[key].trim()) out.push({ kind: 'id', value: value[key].trim(), key });
    if (typeof value[key] === 'number') out.push({ kind: 'id', value: String(value[key]), key });
  });

  [...keys.arrays, 'thumbs', 'result', 'data', 'pixverse'].forEach(key => {
    if (value[key] != null) collectAssetCandidates(value[key], type, out, seen);
  });
  return out;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = `${candidate.kind}:${candidate.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function thumbFromCandidate(candidate, type, index = 0) {
  const value = String(candidate?.value || '').trim();
  if (!value) return null;
  const staticUrl = candidate.kind === 'path' || hasMediaExt(value, type) ? staticUrlForPath(value) : '';
  const url = isRemoteUrl(value) ? value : staticUrl;
  return {
    seed: value,
    label: type,
    type,
    chosen: index === 0,
    url,
    path: candidate.kind === 'path' ? value : undefined,
    id: candidate.kind === 'id' ? value : undefined,
  };
}

function firstAssetValue(result, type) {
  const candidates = dedupeCandidates(collectAssetCandidates(result, type));
  const preferred = candidates.find(c => c.kind === 'url' || c.kind === 'path') || candidates[0];
  return preferred?.value || '';
}

function firstImageInput(deps) {
  for (const dep of deps || []) {
    for (const thumbs of [dep.result?.thumbs, dep.from?.thumbs]) {
      if (!Array.isArray(thumbs)) continue;
      const thumb = thumbs.find(t => t?.path || t?.local_path || t?.localPath || t?.url || t?.image_url || t?.imageUrl || t?.id);
      if (thumb) return thumb.path || thumb.local_path || thumb.localPath || thumb.url || thumb.image_url || thumb.imageUrl || thumb.id;
    }
    const resultValue = firstAssetValue(dep.result, 'image');
    if (resultValue) return resultValue;
    if (dep.from?.image) return dep.from.image;
  }
  return '';
}

function replaceToken(token, values) {
  if (token.includes('{prompt}') && !values.prompt.trim()) {
    throw new Error('PixVerse node needs a connected Prompt node.');
  }
  if (token.includes('{image}') && !values.image) return null;
  return token
    .replaceAll('{prompt}', values.prompt)
    .replaceAll('{image}', values.image)
    .replaceAll('{in}', values.image)
    .replaceAll('{prev.out}', values.image);
}

function resolveArgs(node, deps) {
  const args = Array.isArray(node.cli?.args) ? node.cli.args : [];
  const values = {
    prompt: firstPrompt(node, deps),
    image: firstImageInput(deps),
  };
  const out = [];
  for (const arg of args) {
    const replaced = replaceToken(String(arg), values);
    if (replaced == null || replaced === '') {
      if (out.length && out[out.length - 1].startsWith('--')) out.pop();
      continue;
    }
    out.push(replaced);
  }
  return out;
}

function normalizeRatio(node, fallback) {
  if (node.aspectRatio) return node.aspectRatio;
  if (node.size && String(node.size).includes(':')) return node.size;
  return fallback;
}

function pushOptional(args, flag, value) {
  if (value == null || value === '' || value === false) return;
  args.push(flag, String(value));
}

function argValue(args, flag, fallback = '') {
  const i = (args || []).indexOf(flag);
  const value = i >= 0 ? args[i + 1] : null;
  return value && !String(value).startsWith('--') ? value : fallback;
}

function resolveNodeArgs(node, deps) {
  const prompt = promptForPixVerse(node, deps);
  if (!prompt) throw new Error('PixVerse node needs a connected Prompt node.');
  const image = firstImageInput(deps);
  const mode = node.kind === 'motion' ? 'video' : 'image';
  const args = ['create', mode, '--prompt', prompt];
  if (image) args.push('--image', image);
  args.push('--model', node.model || (mode === 'video' ? 'v6' : 'qwen-image'));
  args.push('--quality', node.quality || (mode === 'video' ? '720p' : '1080p'));
  args.push('--aspect-ratio', normalizeRatio(node, '16:9'));
  pushOptional(args, '--count', node.count);
  if (node.seed && node.seed !== 'auto') pushOptional(args, '--seed', node.seed);
  pushOptional(args, '--idempotency-key', node.idempotencyKey);
  if (node.noWait) args.push('--no-wait');
  if (mode === 'video') {
    args.push('--duration', String(node.duration || 5));
    if (node.audio) args.push('--audio');
    if (node.noAudio) args.push('--no-audio');
    if (node.multiShot) args.push('--multi-shot');
    if (node.noMultiShot) args.push('--no-multi-shot');
    if (node.offPeak) args.push('--off-peak');
    args.push('--timeout', String(node.timeout || 600));
  } else {
    pushOptional(args, '--detail-level', node.detailLevel);
    args.push('--timeout', String(node.timeout || 300));
  }
  args.push('--json');
  return args;
}

function parseJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {}
    }
  }
  return null;
}

function collectThumbs(parsed, mode) {
  const type = mode === 'video' ? 'video' : 'image';
  const candidates = dedupeCandidates(collectAssetCandidates(parsed, type));
  const renderable = candidates.filter(c =>
    c.kind === 'url' || c.kind === 'path' || isRemoteUrl(c.value) || hasMediaExt(c.value, type)
  );
  const chosen = renderable.length ? renderable : candidates.filter(c => c.kind === 'id');
  return chosen
    .map((candidate, index) => thumbFromCandidate(candidate, type, index))
    .filter(Boolean);
}

function runJsonCommand(bin, args, req) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: WORK_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let closed = false;
    const killChild = () => {
      if (!closed && child.exitCode == null) child.kill('SIGTERM');
    };
    req.on('aborted', killChild);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      closed = true;
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${bin} exited with ${code}`));
        return;
      }
      resolve(parseJson(stdout) || { stdout: stdout.trim() });
    });
  });
}

function runCommand(bin, args, req) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: WORK_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let closed = false;
    let errored = false;
    const killChild = () => {
      if (!closed && child.exitCode == null) child.kill('SIGTERM');
    };
    req.on('aborted', killChild);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      errored = true;
      reject(err);
    });
    child.on('close', code => {
      closed = true;
      if (errored) return;
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${bin} exited with ${code}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function downloadAssetThumb(bin, thumb, mode, req) {
  if (thumb.url || !thumb.id) return [thumb];
  await mkdir(PIXVERSE_OUTPUT_DIR, { recursive: true });
  const parsed = await runJsonCommand(bin, [
    'asset', 'download', thumb.id,
    '--type', mode === 'video' ? 'video' : 'image',
    '--dest', PIXVERSE_OUTPUT_DIR,
    '--json',
  ], req);
  const downloaded = collectThumbs(parsed, mode);
  return downloaded.length ? downloaded : [thumb];
}

function mediaExtFromUrl(value, mode) {
  try {
    const ext = path.extname(new URL(value).pathname).toLowerCase();
    const allowed = mode === 'video'
      ? ['.mp4', '.mov', '.webm', '.m4v']
      : ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'];
    if (allowed.includes(ext)) return ext;
  } catch {}
  return mode === 'video' ? '.mp4' : '.jpg';
}

async function downloadRemoteThumb(thumb, mode, req) {
  if (thumb.path || !isHttpUrl(thumb.url)) return [thumb];
  await mkdir(PIXVERSE_OUTPUT_DIR, { recursive: true });
  const urlPart = String(thumb.url).split('?')[0].split('/').pop() || 'media';
  const safeName = urlPart.replace(/[^a-z0-9._-]+/ig, '-').slice(0, 80) || 'media';
  const baseName = path.extname(safeName) ? safeName : `${safeName}${mediaExtFromUrl(thumb.url, mode)}`;
  const outPath = path.join(PIXVERSE_OUTPUT_DIR, `${mode}-${baseName}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on('aborted', abort);
  try {
    const res = await fetch(thumb.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Atlas media-generation helper' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('empty response body');
    await pipeline(res.body, createWriteStream(outPath));
    return [{ ...thumb, path: outPath, url: staticUrlForPath(outPath) || thumb.url }];
  } finally {
    req.off?.('aborted', abort);
  }
}

async function resolveVisibleThumbs(bin, thumbs, mode, req) {
  const out = [];
  for (const thumb of thumbs) {
    const idResolved = await downloadAssetThumb(bin, thumb, mode, req).catch(() => [thumb]);
    for (const candidate of idResolved) {
      const visible = await downloadRemoteThumb(candidate, mode, req).catch(() => [candidate]);
      out.push(...visible);
    }
  }
  return out.map((thumb, index) => ({ ...thumb, chosen: index === 0 }));
}

function cliFieldValue(node, key, fallback = '') {
  const fields = Array.isArray(node?.cli?.fields) ? node.cli.fields : [];
  const found = fields.find(field => field?.k === key);
  return found?.v ?? fallback;
}

function positiveNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function firstCommandToken(value) {
  return String(value || '').trim().split(/\s+/)[0];
}

function servedPathFromUrl(value) {
  try {
    const url = new URL(value, `http://${HOST}:${PORT}`);
    const localHost = url.hostname === HOST || url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    const localPort = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    if (!localHost || localPort !== PORT) return '';
    const pathname = decodeURIComponent(url.pathname);
    const base = pathname.startsWith('/.atlas-runs/') ? WORK_ROOT : APP_ROOT;
    const target = path.normalize(path.join(base, pathname));
    if (isPathInside(base, target)) return target;
  } catch {}
  return '';
}

function pathForFfmpegInput(value) {
  const raw = String(value || '').trim();
  if (!raw || /^data:/i.test(raw)) return '';
  if (raw.startsWith('/')) return servedPathFromUrl(raw);
  if (/^https?:\/\//i.test(raw)) return servedPathFromUrl(raw) || raw;
  return path.isAbsolute(raw) ? raw : path.resolve(WORK_ROOT, raw);
}

function collectThumbVideoValues(thumb, out) {
  if (!thumb || typeof thumb !== 'object') return;
  const value = thumb.path || thumb.video_url || thumb.videoUrl || thumb.url || thumb.src || thumb.output || '';
  if (!value) return;
  if (thumb.type === 'video' || hasMediaExt(value, 'video')) out.push(value);
}

function collectObjectVideoValues(value, out) {
  const candidates = dedupeCandidates(collectAssetCandidates(value, 'video'));
  candidates.forEach(candidate => {
    if (candidate.kind !== 'url' && candidate.kind !== 'path') return;
    const key = String(candidate.key || '');
    if (/video/i.test(key) || hasMediaExt(candidate.value, 'video')) out.push(candidate.value);
  });
}

function collectFfmpegVideoInputs(deps) {
  const values = [];
  for (const dep of deps || []) {
    if (Array.isArray(dep.result?.thumbs)) dep.result.thumbs.forEach(thumb => collectThumbVideoValues(thumb, values));
    if (Array.isArray(dep.from?.thumbs)) dep.from.thumbs.forEach(thumb => collectThumbVideoValues(thumb, values));
    collectObjectVideoValues(dep.result, values);
    collectObjectVideoValues(dep.from, values);
  }

  const seen = new Set();
  const inputs = [];
  for (const value of values) {
    const input = pathForFfmpegInput(value);
    if (!input || seen.has(input)) continue;
    seen.add(input);
    inputs.push(input);
  }
  return inputs;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function inputExtFromUrl(value) {
  try {
    const ext = path.extname(new URL(value).pathname).toLowerCase();
    if (['.mp4', '.mov', '.webm', '.m4v'].includes(ext)) return ext;
  } catch {}
  return '.mp4';
}

function projectFfmpegDir(config = {}) {
  const configuredDir = expandHome(config?.project?.outputDir || config?.projectOutputDir || '');
  if (!configuredDir) return FFMPEG_OUTPUT_DIR;
  const root = path.isAbsolute(configuredDir) ? configuredDir : path.resolve(WORK_ROOT, configuredDir);
  return path.join(root, 'ffmpeg');
}

async function downloadFfmpegInput(url, inputDir, prefix, index, req) {
  await mkdir(inputDir, { recursive: true });
  const outPath = path.join(inputDir, `${prefix}-${index + 1}${inputExtFromUrl(url)}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on('aborted', abort);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Atlas media-generation helper' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('empty response body');
    await pipeline(res.body, createWriteStream(outPath));
    return outPath;
  } catch (e) {
    throw new Error(`Failed to download ffmpeg input ${url}: ${e.message || String(e)}`);
  } finally {
    req.off?.('aborted', abort);
  }
}

async function localizeFfmpegInputs(inputs, inputDir, prefix, req) {
  const localized = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    localized.push(isHttpUrl(input) ? await downloadFfmpegInput(input, inputDir, prefix, i, req) : input);
  }
  return localized;
}

function ffmpegCanvasSize(node) {
  const ratio = normalizeRatio(node, '16:9');
  if (ratio === '9:16') return { width: 720, height: 1280 };
  if (ratio === '1:1') return { width: 1080, height: 1080 };
  return { width: 1280, height: 720 };
}

function ffmpegConcatArgs(node, inputs, outPath) {
  const { width, height } = ffmpegCanvasSize(node);
  const fps = positiveNumber(cliFieldValue(node, 'fps', 24), 24, 1, 120);
  const crf = positiveNumber(cliFieldValue(node, 'crf', 18), 18, 0, 51);
  const filters = inputs.map((_, i) =>
    `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`
  );
  filters.push(`${inputs.map((_, i) => `[v${i}]`).join('')}concat=n=${inputs.length}:v=1:a=0[v]`);
  return [
    '-y',
    ...inputs.flatMap(input => ['-i', input]),
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    '-an',
    '-c:v', 'libx264',
    '-crf', String(crf),
    '-preset', 'medium',
    '-movflags', '+faststart',
    outPath,
  ];
}

async function runFfmpeg(payload, req) {
  const { node, deps = [], config = {} } = payload || {};
  const configuredBin = firstCommandToken(config.binPaths?.ffmpeg || node?.cli?.bin || node?.cli?.cmd || 'ffmpeg');
  if (basename(configuredBin) !== 'ffmpeg') {
    throw new Error('ffmpeg binary path must point to ffmpeg.');
  }

  const sourceInputs = collectFfmpegVideoInputs(deps);
  const label = `compose · ${sourceInputs.length} clips`;
  const seed = `ffmpeg-compose:${node?.id || node?.title || 'ff'}:${sourceInputs.join('|')}`;
  if (process.env.ATLAS_DRY_RUN === '1') {
    return {
      ok: true,
      dryRun: true,
      cli: { cmd: configuredBin, args: [] },
      thumbs: [{ seed, type: 'video', label, chosen: true, sources: sourceInputs }],
    };
  }

  if (sourceInputs.length < 2) {
    throw new Error('ffmpeg node needs at least two rendered video inputs (url/path). Run upstream video nodes first.');
  }

  const ffmpegOutputDir = projectFfmpegDir(config);
  const ffmpegInputDir = path.join(ffmpegOutputDir, 'inputs');
  const prefix = `${String(node?.id || 'ffmpeg').replace(/[^a-z0-9_-]+/ig, '-')}-${Date.now()}`;
  await mkdir(ffmpegOutputDir, { recursive: true });
  await mkdir(ffmpegInputDir, { recursive: true });
  const outPath = path.join(ffmpegOutputDir, `${prefix}.mp4`);
  const inputs = await localizeFfmpegInputs(sourceInputs, ffmpegInputDir, prefix, req);
  const args = ffmpegConcatArgs(node, inputs, outPath);
  const result = await runCommand(configuredBin, args, req);
  return {
    ok: true,
    cli: { cmd: configuredBin, args },
    ffmpeg: { inputs: sourceInputs, localizedInputs: inputs, output: outPath, stderr: result.stderr },
    thumbs: [{
      seed: outPath,
      type: 'video',
      label,
      chosen: true,
      url: staticUrlForPath(outPath),
      path: outPath,
      sources: sourceInputs,
    }],
  };
}

function runPixVerse(payload, req) {
  const { node, deps = [], config = {} } = payload || {};
  const isPixVerseCli = node?.kind === 'cli' && basename(node.cli?.cmd || node.cli?.bin) === 'pixverse';
  const isPixVerseNode = (node?.kind === 'gen' || node?.kind === 'motion') && node?.provider === 'pixverse';
  if (!isPixVerseCli && !isPixVerseNode) {
    throw new Error('Only PixVerse CLI/provider nodes are executable by this helper.');
  }

  const bin = config.binPaths?.pixverse || node.cli?.bin || 'pixverse';
  if (basename(bin) !== 'pixverse') {
    throw new Error('PixVerse binary path must point to pixverse.');
  }

  const args = isPixVerseCli ? resolveArgs(node, deps) : resolveNodeArgs(node, deps);
  const mode = args.includes('video') ? 'video' : 'image';
  if (process.env.ATLAS_DRY_RUN === '1') {
    const count = Math.max(1, Math.min(12, Number(argValue(args, '--count', '1')) || 1));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#152033"/><text x="24" y="96" fill="#7fc8ff" font-family="monospace" font-size="18">PixVerse ${mode} dry-run</text></svg>`;
    return Promise.resolve({
      ok: true,
      dryRun: true,
      cli: { cmd: bin, args },
      thumbs: mode === 'image'
        ? Array.from({ length: count }, (_, i) => ({
            seed: `pixverse-dry-run-${i + 1}`,
            label: `dry-run ${i + 1}`,
            type: 'image',
            chosen: i === 0,
            url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          }))
        : [],
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: WORK_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let closed = false;

    const killChild = () => {
      if (!closed && child.exitCode == null) child.kill('SIGTERM');
    };
    req.on('aborted', killChild);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', async code => {
      closed = true;
      if (code !== 0) {
        const msg = stderr.trim() || stdout.trim() || `pixverse exited with ${code}`;
        reject(new Error(msg));
        return;
      }
      const parsed = parseJson(stdout);
      const rawThumbs = collectThumbs(parsed, mode);
      const thumbs = args.includes('--no-wait')
        ? rawThumbs
        : await resolveVisibleThumbs(bin, rawThumbs, mode, req);
      resolve({
        ok: true,
        cli: { cmd: bin, args },
        pixverse: parsed,
        stdout: parsed ? undefined : stdout.trim(),
        thumbs,
      });
    });
  });
}

function runNode(payload, req) {
  const node = payload?.node;
  const isPixVerseCli = node?.kind === 'cli' && basename(node.cli?.cmd || node.cli?.bin) === 'pixverse';
  const isPixVerseProvider = (node?.kind === 'gen' || node?.kind === 'motion') && node?.provider === 'pixverse';
  const isFfmpegCli = node?.kind === 'cli' && basename(node.cli?.cmd || node.cli?.bin) === 'ffmpeg';
  if (isFfmpegCli) return runFfmpeg(payload, req);
  if (isPixVerseCli || isPixVerseProvider) return runPixVerse(payload, req);
  throw new Error('Only PixVerse and ffmpeg nodes are executable by this helper.');
}

function expandHome(value) {
  const raw = String(value || '').trim();
  if (raw === '~') return process.env.HOME || raw;
  if (raw.startsWith('~/')) return path.join(process.env.HOME || '', raw.slice(2));
  return raw;
}

function safePathName(value, fallback) {
  const safe = String(value || '')
    .split('')
    .map(c => /[\p{L}\p{N} ._-]/u.test(c) ? c : '_')
    .join('')
    .trim();
  return safe || fallback;
}

function sourcePathForSave(value) {
  const raw = String(value || '').trim();
  if (!raw || /^data:/i.test(raw)) return '';
  if (raw.startsWith('asset://localhost')) {
    try { return decodeURIComponent(new URL(raw).pathname); } catch { return ''; }
  }
  if (/^https?:\/\//i.test(raw)) return servedPathFromUrl(raw);
  if (raw.startsWith('/.atlas-runs/')) return servedPathFromUrl(raw);
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(WORK_ROOT, raw);
}

async function copyOutputFile(payload) {
  const srcPath = sourcePathForSave(payload?.srcPath || payload?.src || '');
  if (!srcPath) throw new Error('No local output path is available yet.');
  const rawDest = expandHome(payload?.destDir || '');
  if (!rawDest) throw new Error('Set a project save directory first.');
  const destRoot = path.isAbsolute(rawDest) ? rawDest : path.resolve(WORK_ROOT, rawDest);
  if (!isPathInside(WORK_ROOT, srcPath) && !isPathInside(APP_ROOT, srcPath) && !isPathInside(destRoot, srcPath)) {
    throw new Error('Output file must be inside the Atlas workspace before it can be saved.');
  }
  const info = await stat(srcPath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Source file not found: ${srcPath}`);

  await mkdir(destRoot, { recursive: true });
  const destPath = path.join(destRoot, path.basename(srcPath));
  await copyFile(srcPath, destPath);
  return { ok: true, path: destPath };
}

async function handleApi(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    const result = await runNode(payload, req);
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message || String(e) });
  }
}

async function handleSaveOutput(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    const result = await copyOutputFile(payload);
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message || String(e) });
  }
}

async function handleStatic(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/Atlas.html';
  const base = pathname.startsWith('/.atlas-runs/') ? WORK_ROOT : APP_ROOT;
  const target = path.normalize(path.join(base, pathname));
  if (!isPathInside(base, target)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('Not a file');
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('File not found');
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/run-node') {
    handleApi(req, res);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/save-output') {
    handleSaveOutput(req, res);
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    handleStatic(req, res);
    return;
  }
  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, HOST, () => {
  console.log(`Atlas helper listening on http://${HOST}:${PORT}/Atlas.html`);
  console.log(`Atlas run directory: ${path.join(WORK_ROOT, '.atlas-runs')}`);
  console.log('PixVerse and ffmpeg CLI nodes are enabled. Authenticate with: pixverse auth login');
});
