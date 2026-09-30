/**
 * tauri-bridge.js
 * Replaces browser-bridge.js when running inside the Tauri desktop app.
 * Sets window.AtlasStorage (filesystem) and window.AtlasExecutor (Rust backend).
 */
(function () {
  'use strict';

  const { invoke } = window.__TAURI__.tauri;
  const { listen } = window.__TAURI__.event;
  const { convertFileSrc } = window.__TAURI__.tauri;

  // ── Storage: read/write graph JSON to the app data directory ──────────────

  window.AtlasStorage = {
    async load() {
      try {
        const raw = await invoke('load_graph');
        return raw ? localizeSavedState(JSON.parse(raw)) : null;
      } catch (e) {
        console.warn('[Beatboard] storage load failed', e);
        return null;
      }
    },
    async save(state) {
      try {
        // Strip transient UI before persisting
        const { ui, ...rest } = state;
        await invoke('save_graph', { state: JSON.stringify(rest) });
      } catch (e) {
        console.warn('[Beatboard] storage save failed', e);
      }
    },
  };

  // ── Result post-processing: convert local paths to preview URLs ───────────

  function isRemoteLike(value) {
    return /^(https?:|data:|blob:|asset:|atlasmedia:)/i.test(String(value || ''));
  }

  function pathFromLocalMediaUrl(value) {
    const s = String(value || '').trim();
    if (!/^(asset|atlasmedia):\/\/localhost/i.test(s)) return '';
    try {
      const pathname = new URL(s).pathname;
      const encoded = pathname.startsWith('/%2F') ? pathname.slice(1) : pathname;
      return decodeURIComponent(encoded);
    } catch (_) {
      return '';
    }
  }

  function thumbLocalPath(thumb) {
    if (!thumb || typeof thumb !== 'object') return '';
    const values = [
      thumb.path,
      thumb.local_path,
      thumb.localPath,
      thumb.file_path,
      thumb.filePath,
      thumb.file,
      thumb.output,
      thumb.url,
      thumb.video_url,
      thumb.videoUrl,
      thumb.image_url,
      thumb.imageUrl,
      thumb.audio_url,
      thumb.audioUrl,
      thumb.src,
    ];
    const mediaUrlPath = values.map(pathFromLocalMediaUrl).find(Boolean);
    if (mediaUrlPath) return mediaUrlPath;
    return String(values.find(value => {
      const s = String(value || '').trim();
      return s && !isRemoteLike(s) && (s.startsWith('/') || /\.(png|jpe?g|webp|gif|avif|mp4|mov|webm|m4v|mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(s));
    }) || '');
  }

  function isVideoPath(value, thumb) {
    return thumb?.type === 'video' || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(value || ''));
  }

  function isAudioPath(value, thumb) {
    return thumb?.type === 'audio' || /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(String(value || ''));
  }

  function mediaFileSrc(localPath, thumb) {
    // Route all local media through the custom atlasmedia:// protocol.
    // It handles both images and videos with proper MIME types, Range support,
    // and an explicit $HOME / $APPDATA security check — more reliable than
    // the built-in asset:// protocol whose scope expansion can be inconsistent.
    return `atlasmedia://localhost/${encodeURIComponent(localPath)}`;
  }

  function localizeThumb(thumb) {
    if (!thumb || typeof thumb !== 'object') return thumb;
    // If we have a local path, always prefer it as the preview URL.
    const localPath = thumbLocalPath(thumb);
    if (localPath) {
      try {
        return { ...thumb, path: thumb.path || localPath, url: mediaFileSrc(localPath, thumb) };
      } catch (_) { /* ignore */ }
    }
    return thumb;
  }

  function localizeResult(result) {
    if (!result || typeof result !== 'object') return result;
    if (Array.isArray(result.thumbs)) {
      // Standard case: result carries a thumbs array — localize each thumb.
      return { ...result, thumbs: result.thumbs.map(localizeThumb) };
    }
    // Flat result (e.g. PixVerse CLI returns { ok, path, output, … } without thumbs).
    // Treat the result object itself like a thumb so that path/output/url fields get
    // converted to asset:// URLs before resultThumbs() in state.jsx reads them.
    return localizeThumb(result);
  }

  function localizeSavedState(state) {
    if (!state || !Array.isArray(state.projects)) return state;
    return {
      ...state,
      // Re-localize library item thumbs so their path/url fields point to valid
      // atlasmedia:// URLs after reloading from JSON (library is global, not per-project).
      library: Array.isArray(state.library)
        ? state.library.map(item => item && item.thumb
            ? { ...item, thumb: localizeThumb(item.thumb) }
            : item)
        : (state.library || []),
      projects: state.projects.map(project => ({
        ...project,
        graph: project.graph ? {
          ...project.graph,
          nodes: (project.graph.nodes || []).map(node => ({
            ...node,
            thumbs: Array.isArray(node.thumbs) ? node.thumbs.map(localizeThumb) : node.thumbs,
          })),
        } : project.graph,
        runResults: Object.fromEntries(Object.entries(project.runResults || {}).map(([id, result]) => [
          id,
          localizeResult(result),
        ])),
      })),
    };
  }

  // ── Mock executor (for non-CLI nodes: prompt, gen, select, output…) ───────
  // Copied from browser-bridge.js so non-PixVerse / non-ffmpeg nodes still animate.

  function isAborted(ctx) {
    return !!(ctx && (ctx.aborted || ctx.abortRef?.current?.aborted));
  }

  function cliName(node) {
    const raw = node?.cli?.cmd || node?.cli?.bin || '';
    return String(raw).trim().split(/\s+/)[0].split(/[\\/]/).pop();
  }

  function isPixVerseNode(node) {
    return (node?.kind === 'cli' && cliName(node) === 'pixverse') ||
      ((node?.kind === 'gen' || node?.kind === 'motion') && node?.provider === 'pixverse');
  }

  function isFfmpegNode(node) {
    return node?.kind === 'cli' && cliName(node) === 'ffmpeg';
  }

  function shouldUseTauri(node) {
    return node?.kind === 'task' || isPixVerseNode(node) || isFfmpegNode(node);
  }

  function estimateMs(node) {
    if (node.kind === 'prompt' || node.kind === 'asset' || node.kind === 'output') return 160;
    if (node.kind === 'select') return 400;
    if (node.kind === 'cli') return 900;
    if (node.kind === 'motion') return 1200;
    if (node.kind === 'gen') return 1000;
    return 600;
  }

  // Minimal passthrough for mock: forward upstream thumbs to downstream nodes
  function resultThumbs(result) {
    if (!result) return [];
    if (Array.isArray(result.thumbs)) return result.thumbs;
    const url = result.image_url || result.imageUrl || result.video_url || result.videoUrl ||
      result.audio_url || result.audioUrl ||
      result.url || result.src || result.path || result.output || result.file ||
      result.file_path || result.filePath || result.local_path || result.localPath;
    const isVideo = !!(result.video_url || result.videoUrl) || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(url || ''));
    const isAudio = !!(result.audio_url || result.audioUrl) || /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(String(url || ''));
    const type = isAudio ? 'audio' : isVideo ? 'video' : 'image';
    return url ? [{ seed: url, url, label: type, type }] : [];
  }

  function sourceThumbs(dep) {
    const thumbs = resultThumbs(dep.result);
    return thumbs.length ? thumbs : (Array.isArray(dep.from?.thumbs) ? dep.from.thumbs : []);
  }

  // Same rule as pickedThumb in src/state.jsx: run result before the (possibly
  // stale) node, explicit selectedIndex before the `chosen` flag.
  function pickedThumb(dep) {
    const fromResult = resultThumbs(dep.result);
    const holder = fromResult.length ? dep.result : dep.from;
    const thumbs = fromResult.length ? fromResult : (Array.isArray(dep.from?.thumbs) ? dep.from.thumbs : []);
    if (!thumbs.length) return null;
    const selected = holder?.selectedIndex;
    const idx = Number.isInteger(selected) && selected >= 0 && selected < thumbs.length
      ? selected
      : thumbs.findIndex(t => t.chosen);
    return thumbs[Math.max(0, idx)];
  }

  function upstreamThumbs(deps) {
    const out = [];
    for (const dep of deps || []) {
      if (dep.from?.kind === 'select') {
        const picked = pickedThumb(dep);
        if (picked) out.push({ ...picked, chosen: true });
        continue;
      }
      const thumbs = sourceThumbs(dep);
      if (!thumbs.length) continue;
      const chosen = thumbs.find(t => t.chosen) || thumbs[0];
      if (chosen) out.push(chosen);
    }
    return out;
  }

  function passthroughResult(node, deps) {
    // Asset nodes expose their own thumbs as the result so downstream Rust nodes
    // can reliably read dep.result.thumbs (instead of only dep.from.thumbs).
    if (node.kind === 'asset') {
      // Only pass through thumbs that have a real media source (path or recognisable url).
      const assetThumbs = (node.thumbs || []).filter(t => {
        if (!t) return false;
        const path = t.path || t.local_path || t.localPath || t.file || '';
        if (path && String(path).trim().startsWith('/')) return true;
        const url = t.url || t.src || '';
        return url && /^(https?:|atlasmedia:|asset:|data:|blob:)/i.test(String(url));
      });
      return assetThumbs.length
        ? { thumbs: assetThumbs.map((t, i) => ({ ...t, chosen: i === 0 })) }
        : null;
    }
    const thumbs = upstreamThumbs(deps);
    if (!thumbs.length) return null;
    if (node.kind === 'select') {
      const idx = Math.min(thumbs.length - 1, Math.max(0, node.selectedIndex ?? 0));
      return { selectedIndex: idx, thumbs: thumbs.map((t, i) => ({ ...t, chosen: i === idx })) };
    }
    if (node.kind === 'output') return { thumbs: thumbs.slice(0, 4).map((t, i) => ({ ...t, chosen: i === 0 })) };
    return null;
  }

  async function mockNode(node, deps, ctx, onProgress) {
    const total = estimateMs(node);
    const tickEvery = 80;
    const ticks = Math.max(1, Math.floor(total / tickEvery));
    for (let i = 0; i <= ticks; i++) {
      if (isAborted(ctx)) return { ok: false, error: 'aborted' };
      onProgress(i / ticks);
      await new Promise(r => setTimeout(r, tickEvery));
    }
    return { ok: true, ...(passthroughResult(node, deps) || {}) };
  }

  // ── Download output file to a user-chosen directory ──────────────────────
  //
  // Shows the OS folder-picker, then copies `srcPath` into
  // `{chosen_dir}/{filename}`.
  // Returns the destination path, or null if the user cancelled.

  async function chooseOutputDir() {
    const { open } = window.__TAURI__.dialog;
    const destDir = await open({
      directory: true,
      multiple: false,
      title: 'Choose project save directory',
    });
    return destDir || null;
  }

  // Decode an atlasmedia:// or asset:// URL back to a local filesystem path.
  // Used so Rust's copy_to_downloads always receives a plain absolute path.
  function decodeMediaUrl(srcPath) {
    const s = String(srcPath || '').trim();
    if (/^(atlasmedia|asset):\/\/localhost/i.test(s)) {
      try {
        const pathname = new URL(s).pathname;
        const encoded = pathname.startsWith('/%2F') ? pathname.slice(1) : pathname;
        return decodeURIComponent(encoded);
      } catch (_) {}
    }
    return s;
  }

  async function downloadOutputFile(srcPath, projectName, configuredDir) {
    const localSrc = decodeMediaUrl(srcPath);
    if (!localSrc) return null;

    const destDir = String(configuredDir || '').trim() || await chooseOutputDir();
    if (!destDir) return null; // user cancelled

    const destPath = await invoke('copy_to_downloads', {
      src: localSrc,
      projectName: projectName || 'Output',
      destDir,
    });
    return destPath;
  }

  window.AtlasChooseOutputDir = chooseOutputDir;
  window.AtlasDownloadOutputFile = downloadOutputFile;

  // ── Local media file picker ───────────────────────────────────────────────
  // Opens a native OS file-open dialog filtered to image, video, and audio.
  // Returns { path, url, label, type } on success, or null if cancelled.
  async function chooseLocalFile() {
    const { open } = window.__TAURI__.dialog;
    const filePath = await open({
      multiple: false,
      filters: [{
        name: 'Images, Videos & Audio',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'mp4', 'mov', 'webm', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'],
      }],
    });
    if (!filePath) return null;
    const isVideo = /\.(mp4|mov|webm|m4v)$/i.test(filePath);
    const isAudio = /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(filePath);
    const label = filePath.split('/').pop();
    const url = mediaFileSrc(filePath);
    return { path: filePath, url, label, type: isAudio ? 'audio' : isVideo ? 'video' : 'image', seed: filePath };
  }
  window.AtlasChooseLocalFile = chooseLocalFile;

  // ── Main executor ─────────────────────────────────────────────────────────

  window.AtlasExecutor = {
    async runNode(node, deps, ctx, onProgress) {
      if (isAborted(ctx)) return { ok: false, error: 'aborted' };

      if (!shouldUseTauri(node)) {
        return mockNode(node, deps, ctx, onProgress);
      }

      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // Listen for progress events emitted from Rust
      const unlisten = await listen(`progress:${runId}`, (event) => {
        if (!isAborted(ctx)) onProgress(Number(event.payload) || 0);
      });
      // What the provider is doing right now, e.g. "#3 KSampler 12/20".
      const unlistenStatus = await listen(`status:${runId}`, (event) => {
        if (!isAborted(ctx) && typeof ctx.onStatus === 'function') ctx.onStatus(String(event.payload || ''));
      });
      // A provider job was submitted: the runner stores it so the run can be
      // resumed if Beatboard quits before it finishes.
      const unlistenJob = await listen(`job:${runId}`, (event) => {
        if (!isAborted(ctx) && typeof ctx.onJob === 'function') ctx.onJob(event.payload);
      });

      // Stop: the runner only flips an abort flag, so watch it and ask Rust
      // to kill the node's process instead of letting it run to completion.
      const abortWatch = setInterval(() => {
        if (!isAborted(ctx)) return;
        clearInterval(abortWatch);
        invoke('cancel_run', { runId }).catch(e => console.warn('[Beatboard] cancel failed', e));
      }, 150);

      try {
        onProgress(0);
        const result = await invoke('run_node', {
          node,
          deps,
          config: ctx.config,
          runId,
        });
        const localized = localizeResult(result);
        onProgress(1);
        return localized;
      } catch (e) {
        if (isAborted(ctx)) return { ok: false, error: 'aborted' };
        return { ok: false, error: String(e) };
      } finally {
        clearInterval(abortWatch);
        unlisten();
        unlistenStatus();
        unlistenJob();
      }
    },

    // Finish a job recorded by an interrupted run (see ctx.onJob above).
    async resumeNode(node, job, ctx, onProgress) {
      const runId = `resume-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const unlisten = await listen(`progress:${runId}`, (event) => onProgress(Number(event.payload) || 0));
      const unlistenStatus = await listen(`status:${runId}`, (event) => {
        if (typeof ctx.onStatus === 'function') ctx.onStatus(String(event.payload || ''));
      });
      try {
        const result = await invoke('resume_task', { node, job, config: ctx.config, runId });
        return localizeResult(result);
      } catch (e) {
        return { ok: false, error: String(e) };
      } finally {
        unlisten();
        unlistenStatus();
      }
    },
  };
})();
