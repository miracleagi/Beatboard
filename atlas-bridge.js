(function () {
  function isAborted(ctx) {
    return !!(ctx && (ctx.aborted || ctx.abortRef?.current?.aborted));
  }

  function cliName(node) {
    const raw = node?.cli?.cmd || node?.cli?.bin || '';
    const first = String(raw).trim().split(/\s+/)[0] || '';
    return first.split(/[\\/]/).pop();
  }

  function isPixVerseNode(node) {
    return (node?.kind === 'cli' && cliName(node) === 'pixverse') ||
      ((node?.kind === 'gen' || node?.kind === 'motion') && node?.provider === 'pixverse');
  }

  function isFfmpegNode(node) {
    return node?.kind === 'cli' && cliName(node) === 'ffmpeg';
  }

  function isVideoThumb(thumb) {
    const value = thumb?.url || thumb?.src || thumb?.video_url || thumb?.videoUrl || thumb?.path || thumb?.output || '';
    return !!value && (
      thumb?.type === 'video' ||
      /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(value))
    );
  }

  function helperVideoThumbs(deps) {
    return upstreamThumbs(deps).filter(isVideoThumb);
  }

  function shouldUseHelper(node, deps) {
    if (isPixVerseNode(node)) return true;
    if (isFfmpegNode(node)) return helperVideoThumbs(deps).length >= 2;
    return false;
  }

  function estimateMs(node) {
    if (node.kind === 'prompt' || node.kind === 'asset' || node.kind === 'output') return 160;
    if (node.kind === 'select') return 400;
    if (node.kind === 'cli') return 900;
    if (node.kind === 'motion') return 1200;
    if (node.kind === 'gen') return 1000;
    return 600;
  }

  function resultThumbs(result) {
    if (!result) return [];
    if (Array.isArray(result.thumbs)) return result.thumbs;
    const url = result.image_url || result.imageUrl || result.video_url || result.videoUrl ||
      result.url || result.src || result.path || result.output || result.file ||
      result.file_path || result.filePath || result.local_path || result.localPath;
    const isVideo = !!(result.video_url || result.videoUrl) || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(url || ''));
    return url ? [{ seed: url, url, label: isVideo ? 'video' : 'image', type: isVideo ? 'video' : 'image' }] : [];
  }

  function sourceThumbs(dep) {
    if (dep.from?.kind === 'select' && Array.isArray(dep.from?.thumbs) && dep.from.thumbs.length) return dep.from.thumbs;
    const thumbs = resultThumbs(dep.result);
    return thumbs.length ? thumbs : (Array.isArray(dep.from?.thumbs) ? dep.from.thumbs : []);
  }

  function sourceOutputIndex(dep) {
    const ports = dep.from?.ports || [];
    let outputIndex = -1;
    let found = -1;
    ports.forEach((port, index) => {
      if (port.side !== 'right') return;
      outputIndex += 1;
      if (index === dep.edge?.from?.port) found = outputIndex;
    });
    return found;
  }

  function chosenThumb(thumbs, selectedIndex) {
    const idx = Number.isFinite(selectedIndex) ? selectedIndex : thumbs.findIndex(t => t.chosen);
    return thumbs[Math.max(0, idx)] || thumbs[0];
  }

  function upstreamThumbs(deps, options = {}) {
    const out = [];
    for (const dep of deps || []) {
      const thumbs = sourceThumbs(dep);
      if (!thumbs.length) continue;
      if (dep.from?.kind === 'select') {
        const selectedIndex = dep.from.selectedIndex ?? dep.result?.selectedIndex;
        const picked = chosenThumb(thumbs, selectedIndex);
        if (picked) out.push({ ...picked, chosen: true });
        continue;
      }
      if (options.forSelect && (dep.from?.kind === 'gen' || dep.from?.kind === 'motion' || dep.from?.kind === 'cli')) {
        out.push(...thumbs.map((thumb, i) => ({ ...thumb, sourceIndex: i })));
        continue;
      }
      const outputIndex = sourceOutputIndex(dep);
      if (outputIndex >= 0 && thumbs[outputIndex]) out.push({ ...thumbs[outputIndex], sourceIndex: outputIndex });
      else out.push(...thumbs);
    }
    return out;
  }

  function passthroughResult(node, deps) {
    const thumbs = upstreamThumbs(deps, { forSelect: node.kind === 'select' });
    if (!thumbs.length) return null;
    if (node.kind === 'select') {
      const selectedIndex = Math.min(thumbs.length - 1, Math.max(0, node.selectedIndex ?? thumbs.findIndex(t => t.chosen) ?? 0));
      return { selectedIndex, thumbs: thumbs.map((thumb, i) => ({ ...thumb, chosen: i === selectedIndex })) };
    }
    if (node.kind === 'output') {
      return { thumbs: thumbs.slice(0, 4).map((t, i) => ({ ...t, chosen: i === 0 })) };
    }
    if (node.kind === 'cli') {
      if (isFfmpegNode(node)) {
        const videos = thumbs.filter(t => t.type === 'video' || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(t.url || t.path || t.seed || '')));
        const inputs = videos.length ? videos : thumbs;
        const seed = `ffmpeg-compose:${node.id || node.title || 'ff'}:${inputs.map(t => t.seed || t.url || t.path || t.id || t.label).join('|')}`;
        return {
          thumbs: [{
            seed,
            type: 'video',
            label: `compose · ${inputs.length} clips`,
            chosen: true,
            sources: inputs.map(t => ({ seed: t.seed, label: t.label, url: t.url, path: t.path, id: t.id })),
          }],
        };
      }
      return { thumbs: thumbs.slice(0, 4).map((t, i) => ({ ...t, label: node.title || t.label, chosen: i === 0 })) };
    }
    if (node.kind === 'motion') {
      const motionKey = `${node.id || node.title || 'motion'}:${node.motionPrompt || ''}:${thumbs[0].seed || thumbs[0].url || thumbs[0].id || ''}`;
      const motionLabel = node.motionPrompt
        ? `${node.title || 'video'} · ${String(node.motionPrompt).slice(0, 28)}`
        : (node.title || 'video');
      return { thumbs: [{ ...thumbs[0], seed: motionKey, type: 'video', label: motionLabel, chosen: true }] };
    }
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
    const pass = passthroughResult(node, deps);
    return {
      ok: true,
      ...(pass || {}),
      skipped: node.kind === 'cli' ? `${cliName(node) || 'cli'} cli mocked in browser bridge` : undefined,
    };
  }

  async function chooseOutputDir(current = '') {
    const value = window.prompt('Project save directory', current || '');
    return value && value.trim() ? value.trim() : null;
  }

  async function downloadOutputFile(srcPath, projectName, configuredDir) {
    if (location.protocol === 'file:') {
      throw new Error('Start Atlas with run-atlas.command to save files to a local folder.');
    }
    const destDir = String(configuredDir || '').trim() || await chooseOutputDir('');
    if (!destDir) return null;
    const res = await fetch('/api/save-output', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        srcPath,
        projectName: projectName || 'Output',
        destDir,
      }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data.path || data.destPath || null;
  }

  window.AtlasChooseOutputDir = chooseOutputDir;
  window.AtlasDownloadOutputFile = downloadOutputFile;

  window.AtlasExecutor = {
    async runNode(node, deps, ctx, onProgress) {
      if (isAborted(ctx)) return { ok: false, error: 'aborted' };
      const useHelper = shouldUseHelper(node, deps);
      if (!useHelper) return mockNode(node, deps, ctx, onProgress);
      if (location.protocol === 'file:') {
        return { ok: false, error: 'Start Atlas with run-atlas.command to enable local CLI execution.' };
      }

      const controller = new AbortController();
      const abortPoll = setInterval(() => {
        if (isAborted(ctx)) controller.abort();
      }, 250);

      try {
        onProgress(0.05);
        const res = await fetch('/api/run-node', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node, deps, config: ctx.config }),
          signal: controller.signal,
        });
        onProgress(0.95);
        const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
        if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
        onProgress(1);
        return data;
      } catch (e) {
        if (controller.signal.aborted || isAborted(ctx)) return { ok: false, error: 'aborted' };
        return { ok: false, error: e.message || String(e) };
      } finally {
        clearInterval(abortPoll);
      }
    },
  };
})();
