// Editable Node — extends the visual vocabulary from graph.jsx with
// in-place editing affordances. Inputs / textareas swap in where the node's
// content is normally read-only, so users can rewrite prompts and CLI
// commands directly.

// ── PixVerse node-body helpers (detection only; editing lives in inspector) ──
function _pvCliArg(args, flag, fallback = '') {
  const i = (args || []).indexOf(flag);
  if (i < 0) return fallback;
  const next = args[i + 1];
  return next && !String(next).startsWith('--') ? next : fallback;
}
function _isPixVerseCli(node) {
  if (node?.kind !== 'cli') return false;
  const raw = String(node?.cli?.cmd || node?.cli?.bin || '').trim();
  return raw.split(/\s+/)[0].split(/[\\/]/).pop() === 'pixverse';
}
function _pvMode(node) {
  const sub = (node?.cli?.args || [])[1] || 'image';
  if (sub === 'voice' || sub === 'music') return 'audio';
  if (sub === 'image') return 'image';
  if (sub === 'template') return 'asset';
  return 'video';
}

function EditableText({ value, onChange, placeholder, style, mono, mult, minRows = 1, maxRows }) {
  if (mult) {
    const text = value || '';
    const lines = text.split('\n');
    const wrapRows = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 28)), 0);
    const rows = Math.max(minRows, Math.min(maxRows || wrapRows, wrapRows));
    return (
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="no-drag"
        spellCheck={false}
        rows={rows}
        style={{
          width: '100%', resize: 'vertical', boxSizing: 'border-box',
          background: 'transparent', color: 'inherit',
          border: 'none', outline: 'none', padding: 0,
          fontFamily: mono ? FONT_MONO : 'inherit',
          fontSize: 'inherit', lineHeight: 1.5,
          ...style,
        }}
      />
    );
  }
  return (
    <input
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="no-drag"
      spellCheck={false}
      style={{
        width: '100%', boxSizing: 'border-box',
        background: 'transparent', color: 'inherit',
        border: 'none', outline: 'none', padding: 0,
        fontFamily: mono ? FONT_MONO : 'inherit',
        fontSize: 'inherit',
        ...style,
      }}
    />
  );
}

function mediaSrc(thumb) {
  // Prefer the display URL first; Tauri converts local paths to asset:// there.
  // Backends may return snake_case, camelCase, or CLI-style output/file fields.
  const value =
    thumb?.url ||
    thumb?.src ||
    thumb?.image_url ||
    thumb?.imageUrl ||
    thumb?.video_url ||
    thumb?.videoUrl ||
    thumb?.audio_url ||
    thumb?.audioUrl ||
    thumb?.path ||
    thumb?.output ||
    thumb?.file ||
    thumb?.file_path ||
    thumb?.filePath ||
    thumb?.local_path ||
    thumb?.localPath ||
    '';
  const s = String(value);
  // Standard protocols + local paths + Tauri asset:// and custom atlasmedia:// protocols
  if (/^(https?:|data:|blob:|\/|asset:|atlasmedia:)/i.test(s)) return s;
  // Files whose extension clearly identifies them as media
  if (/\.(png|jpe?g|webp|gif|avif|mp4|mov|webm|m4v|mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(s)) return s;
  return '';
}

function isVideoThumb(thumb, src) {
  const value =
    src ||
    thumb?.video_url ||
    thumb?.videoUrl ||
    thumb?.url ||
    thumb?.path ||
    thumb?.output ||
    thumb?.file ||
    '';
  return thumb?.type === 'video' || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(value || ''));
}

function isAudioThumb(thumb, src) {
  const value = src || thumb?.audio_url || thumb?.audioUrl || thumb?.url || thumb?.path || thumb?.output || thumb?.file || '';
  return thumb?.type === 'audio' || /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(String(value || ''));
}

function MediaLightbox({ t, src, label, isVideo, isAudio, onClose }) {
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="no-drag"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(6,9,14,0.88)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          maxWidth: 'min(92vw, 1280px)',
          maxHeight: '82vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {isAudio ? (
          <div style={{ width: 'min(82vw, 720px)', padding: 24, borderRadius: 8, background: t.panel, boxShadow: '0 24px 80px rgba(0,0,0,0.65)' }}>
            <div style={{ marginBottom: 12, color: t.text, fontFamily: FONT_MONO, fontSize: 12 }}>{label || 'generated audio'}</div>
            <audio src={src} controls autoPlay style={{ width: '100%' }}/>
          </div>
        ) : isVideo ? (
          <video
            src={src}
            controls
            autoPlay
            playsInline
            style={{
              maxWidth: 'min(92vw, 1280px)',
              maxHeight: '82vh',
              borderRadius: 6,
              background: '#000',
              boxShadow: '0 24px 80px rgba(0,0,0,0.65)',
            }}
          />
        ) : (
          <img
            src={src}
            alt={label || 'generated image'}
            style={{
              maxWidth: 'min(92vw, 1280px)',
              maxHeight: '82vh',
              objectFit: 'contain',
              borderRadius: 6,
              background: t.bg2,
              boxShadow: '0 24px 80px rgba(0,0,0,0.65)',
            }}
          />
        )}
        <button
          type="button"
          title="Close preview"
          onClick={onClose}
          style={{
            position: 'absolute',
            top: -12,
            right: -12,
            width: 30,
            height: 30,
            borderRadius: 6,
            border: `1px solid ${t.borderStrong}`,
            background: t.panel,
            color: t.text,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}
        >
          <Icon name="close" size={14}/>
        </button>
      </div>
      {label && (
        <div style={{
          marginTop: 12,
          maxWidth: 'min(92vw, 1280px)',
          color: t.textMid,
          fontFamily: FONT_MONO,
          fontSize: 11,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{label}</div>
      )}
    </div>
  );
}

function MediaThumb({ t, thumb, h, selected, onClick, fallbackLabel, previewable = true }) {
  const [failed, setFailed] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const src = mediaSrc(thumb);
  const hasSelectionAction = !!onClick;
  const canPreview = previewable && !!src;
  const isInteractive = hasSelectionAction || canPreview;
  if (!src || failed) {
    return (
      <Placeholder
        theme="dark" w={'100%'} h={h}
        label={thumb?.label || fallbackLabel || ''}
        seed={thumb?.seed || thumb?.id || src || 'media'}
        radius={3} selected={selected}
        onClick={isInteractive ? onClick : undefined}
      />
    );
  }
  const label = thumb?.label || thumb?.id || fallbackLabel || '';
  const isVideo = isVideoThumb(thumb, src);
  const isAudio = isAudioThumb(thumb, src);
  return (
    <>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (hasSelectionAction) onClick();
          else if (canPreview) setOpen(true);
        }}
        className="mg-card no-drag"
        title={hasSelectionAction ? 'Select candidate' : (canPreview ? 'Open preview' : label)}
        style={{
          position: 'relative',
          width: '100%',
          height: h,
          borderRadius: 3,
          overflow: 'hidden',
          border: `1px solid ${selected ? t.accent : t.border}`,
          boxShadow: selected ? `0 0 0 1px ${t.accent}, 0 0 0 4px ${t.accentBg}` : 'none',
          background: t.bg2,
          cursor: hasSelectionAction ? 'pointer' : (canPreview ? 'zoom-in' : 'default'),
        }}
      >
        {isAudio ? (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', padding: '0 8px', boxSizing: 'border-box', background: t.panel }}>
            <audio src={src} controls preload="metadata" style={{ width: '100%' }} onError={() => setFailed(true)}/>
          </div>
        ) : isVideo ? (
          <video
            src={src}
            muted
            playsInline
            autoPlay
            loop
            preload="auto"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onError={() => setFailed(true)}
          />
        ) : (
          <img
            src={src}
            alt={label || 'generated image'}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onError={() => setFailed(true)}
          />
        )}
        {canPreview && (
          <button
            type="button"
            title="Open preview"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen(true);
            }}
            style={{
            position: 'absolute',
            top: 5,
            right: 5,
            width: 20,
            height: 20,
            borderRadius: 4,
            background: 'rgba(8,11,16,0.72)',
            border: `1px solid ${t.border}`,
            color: t.textMid,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            cursor: 'zoom-in',
          }}>
            <Icon name="eye" size={11}/>
          </button>
        )}
        {label && (
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            padding: '4px 6px',
            background: 'linear-gradient(180deg, transparent, rgba(15,20,28,0.82))',
            color: t.textMid,
            fontFamily: FONT_MONO,
            fontSize: 9,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>{label}</div>
        )}
      </div>
      {canPreview && open && (
        ReactDOM.createPortal(
          <MediaLightbox
            t={t}
            src={src}
          label={label || src}
          isVideo={isVideo}
          isAudio={isAudio}
          onClose={() => setOpen(false)}
          />,
          document.body
        )
      )}
    </>
  );
}

function PickCompareTile({ t, thumb, index, selected, tileHeight, onPick }) {
  const [failed, setFailed] = React.useState(false);
  const src = mediaSrc(thumb);
  const label = thumb?.label || thumb?.id || `pick ${index + 1}`;
  const isVideo = isVideoThumb(thumb, src);
  const isAudio = isAudioThumb(thumb, src);
  return (
    <div
      role="button"
      tabIndex={0}
      title={`Pick candidate ${index + 1}`}
      className="mg-card no-drag"
      onClick={(e) => { e.stopPropagation(); onPick(index); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick(index);
        }
      }}
      style={{
        position: 'relative',
        minWidth: 0,
        height: tileHeight,
        borderRadius: 6,
        border: `1px solid ${selected ? t.accent : t.border}`,
        background: t.bg2,
        overflow: 'hidden',
        cursor: 'pointer',
        boxShadow: selected ? `0 0 0 1px ${t.accent}, 0 0 0 4px ${t.accentBg}` : 'none',
        outline: 'none',
      }}
    >
      {src && !failed ? (
        isAudio ? (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', padding: 12, boxSizing: 'border-box' }}>
            <audio src={src} controls preload="metadata" style={{ width: '100%' }} onError={() => setFailed(true)}/>
          </div>
        ) : isVideo ? (
          <video
            src={src}
            muted
            playsInline
            preload="metadata"
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }}
            onError={() => setFailed(true)}
          />
        ) : (
          <img
            src={src}
            alt={label}
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            onError={() => setFailed(true)}
          />
        )
      ) : (
        <Placeholder
          theme="dark"
          w="100%"
          h={tileHeight}
          label={label}
          seed={thumb?.seed || thumb?.id || label}
          radius={5}
          selected={selected}
        />
      )}
      <div style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '7px 9px',
        background: 'linear-gradient(180deg, transparent, rgba(8,11,16,0.86))',
        color: t.text,
        fontFamily: FONT_MONO,
        fontSize: 10,
      }}>
        <span style={{ flex: 'none', color: selected ? t.accent : t.textMid }}>#{index + 1}</span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.textMid }}>{label}</span>
      </div>
    </div>
  );
}

function PickCompareLightbox({ t, thumbs, selectedIndex, onPick, onClose }) {
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cols = thumbs.length <= 1 ? 1 : thumbs.length <= 4 ? 2 : Math.min(4, Math.ceil(Math.sqrt(thumbs.length)));
  const tileHeight = thumbs.length <= 1 ? 'min(68vh, 640px)' : thumbs.length <= 4 ? 'min(38vh, 390px)' : 'min(29vh, 300px)';

  return (
    <div
      className="no-drag"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(6,9,14,0.9)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 22,
        boxSizing: 'border-box',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(94vw, 1320px)',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          background: t.panel,
          border: `1px solid ${t.borderStrong}`,
          borderRadius: 8,
          boxShadow: '0 24px 80px rgba(0,0,0,0.65)',
          padding: 12,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, color: t.textMid, fontFamily: FONT_MONO, fontSize: 11 }}>
            <Icon name="grid" size={13} color={t.accent}/>
            <span style={{ whiteSpace: 'nowrap' }}>Pick #{selectedIndex + 1} / {thumbs.length}</span>
          </div>
          <button
            type="button"
            title="Close compare"
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: `1px solid ${t.border}`,
              background: t.bg2,
              color: t.text,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flex: 'none',
            }}
          >
            <Icon name="close" size={13}/>
          </button>
        </div>
        <div
          className="mg-scroll"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gap: 10,
            minHeight: 0,
            overflow: 'auto',
            padding: 1,
          }}
        >
          {thumbs.map((thumb, i) => (
            <PickCompareTile
              key={i}
              t={t}
              thumb={{ ...thumb, label: thumb.label || `pick ${i + 1}` }}
              index={i}
              selected={i === selectedIndex}
              tileHeight={tileHeight}
              onPick={onPick}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SelectBody({ t, node, runResult, candidateThumbs, onPatch }) {
  const [compareOpen, setCompareOpen] = React.useState(false);
  const rawThumbs = (candidateThumbs && candidateThumbs.length)
    ? candidateThumbs
    : ((runResult && runResult.thumbs) || node.thumbs || []);
  const fallbackIndex = rawThumbs.findIndex(t => t.chosen);
  const selectedIndex = Math.min(
    Math.max(0, node.selectedIndex ?? runResult?.selectedIndex ?? (fallbackIndex >= 0 ? fallbackIndex : 0)),
    Math.max(0, rawThumbs.length - 1)
  );
  const thumbs = rawThumbs.map((thumb, i) => ({ ...thumb, chosen: i === selectedIndex }));
  const selectedThumb = thumbs[selectedIndex];
  if (thumbs.length === 0) {
    return (
      <div style={{
        padding: '14px 10px',
        color: t.textMute, fontFamily: FONT_MONO, fontSize: 10.5,
        textAlign: 'center',
        border: `1px dashed ${t.border}`,
        borderRadius: 4,
      }}>connect candidates →</div>
    );
  }
  const cols = thumbs.length === 1 ? 1 : thumbs.length <= 4 ? 2 : Math.min(4, Math.ceil(Math.sqrt(thumbs.length)));
  const choose = (i) => {
    const updated = thumbs.map((x, j) => ({ ...x, chosen: j === i }));
    onPatch({
      selectedIndex: i,
      thumbs: updated,
      footer: { ...(node.footer || {}), left: `pick #${i + 1}` },
    });
  };

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', columnGap: 8, rowGap: 3, marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            color: t.textMid,
            fontFamily: FONT_MONO,
            fontSize: 10.5,
            lineHeight: 1.25,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>pick #{selectedIndex + 1} / {thumbs.length}</div>
          <div title={selectedThumb?.label || selectedThumb?.id || ''} style={{
            color: t.textMute,
            fontFamily: FONT_MONO,
            fontSize: 9.5,
            lineHeight: 1.25,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>{selectedThumb?.label || selectedThumb?.id || `candidate ${selectedIndex + 1}`}</div>
        </div>
        <button
          type="button"
          title="Compare candidates"
          className="no-drag"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCompareOpen(true);
          }}
          style={{
            height: 22,
            minWidth: 32,
            borderRadius: 4,
            border: `1px solid ${t.border}`,
            background: t.bg2,
            color: t.textMid,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            padding: '0 6px',
            cursor: 'zoom-in',
            flex: 'none',
          }}
        >
          <Icon name="grid" size={11}/>
          <span style={{ fontFamily: FONT_MONO, fontSize: 9.5 }}>{thumbs.length}</span>
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 6 }}>
        {thumbs.map((thumb, i) => (
          <MediaThumb
            key={i}
            t={t}
            thumb={{ ...thumb, label: thumb.label || `pick ${i + 1}` }}
            h={thumbs.length === 1 ? 92 : 64}
            selected={i === selectedIndex}
            fallbackLabel={`pick ${i + 1}`}
            onClick={() => choose(i)}
          />
        ))}
      </div>
      {compareOpen && (
        ReactDOM.createPortal(
          <PickCompareLightbox
            t={t}
            thumbs={thumbs}
            selectedIndex={selectedIndex}
            onPick={(i) => {
              choose(i);
              setCompareOpen(false);
            }}
            onClose={() => setCompareOpen(false)}
          />,
          document.body
        )
      )}
    </>
  );
}

// Body renderer for each node kind, editable.
function EditableBody({ t, node, runResult, runOverride, candidateThumbs, onPatch }) {
  if (node.kind === 'prompt') {
    return (
      <EditableText
        value={node.prompt} mult mono
        placeholder="describe what to generate"
        onChange={(v) => onPatch({ prompt: v })}
        minRows={3}
        maxRows={7}
        style={{
          color: t.text,
          fontSize: 11,
          lineHeight: 1.5,
          resize: 'none',
          maxHeight: 118,
          overflowY: 'auto',
          paddingRight: 3,
        }}
      />
    );
  }
  if (node.kind === 'cli') {
    // PixVerse nodes: compact read-only summary card — all params live in the inspector
    if (_isPixVerseCli(node)) {
      const args = node.cli?.args || [];
      const mode = _pvMode(node);
      const sub = args[1] || 'image';
      const defaultModel = sub === 'image' ? 'gpt-image-2.0'
        : sub === 'modify' ? 'v5.5'
        : sub === 'voice' ? 'speech-2.8-hd'
        : sub === 'music' ? 'music-2.6'
        : 'v6';
      const model = _pvCliArg(args, '--model', defaultModel);
      const quality = _pvCliArg(args, '--quality', mode === 'image' ? '1080p' : '720p');
      const ratio = _pvCliArg(args, '--aspect-ratio', '16:9');
      const duration = mode === 'video' ? _pvCliArg(args, '--duration', '5') : null;
      const count = _pvCliArg(args, '--count', '1');
      const fields = mode === 'audio'
        ? sub === 'music'
          ? [
              { k: 'model', v: model },
              { k: 'duration', v: `${_pvCliArg(args, '--duration-seconds', '60')}s` },
              { k: 'lyrics', v: args.includes('--instrumental') ? 'instrumental' : args.includes('--auto-lyrics') ? 'auto' : 'custom' },
              { k: 'output', v: 'audio' },
            ]
          : [
              { k: 'model', v: model },
              { k: 'language', v: _pvCliArg(args, '--language', 'auto') },
              { k: 'speed', v: `${_pvCliArg(args, '--speed', '1')}×` },
              { k: 'output', v: 'audio' },
            ]
        : mode === 'asset'
          ? [
              { k: 'template', v: _pvCliArg(args, '--template-id', 'required') },
              { k: 'quality', v: quality },
              { k: 'ratio', v: ratio },
              { k: 'count', v: `${count}×` },
            ]
          : [
              { k: 'model', v: model },
              { k: 'quality', v: quality },
              { k: 'ratio', v: ratio },
              duration != null ? { k: 'dur', v: `${duration}s` } : { k: 'count', v: `${count}×` },
            ];
      // model gets its own full-width row; quality / ratio / dur share the second row
      const paramFields = fields.slice(1); // quality, ratio, dur/count
      // Thumbnails from run result (prefer runOverride during live run)
      const pvEffective = (runOverride?.thumbs?.length ? runOverride : null) ||
                          (runResult?.thumbs?.length ? runResult : null);
      const pvThumbs = pvEffective?.thumbs || [];
      const pvCols = pvThumbs.length === 1 ? 1 : pvThumbs.length <= 4 ? 2 : Math.min(4, Math.ceil(Math.sqrt(pvThumbs.length)));
      const pvThumbH = pvThumbs.length === 1 ? 80 : pvThumbs.length <= 4 ? 50 : 44;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Result thumbnails */}
          {pvThumbs.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${pvCols}, 1fr)`, gap: 4 }}>
              {pvThumbs.map((im, i) => (
                <MediaThumb
                  key={i}
                  t={t}
                  thumb={im}
                  h={pvThumbH}
                  selected={im.chosen}
                  fallbackLabel={mode === 'video' ? 'video' : 'image'}
                  previewable
                  onClick={() => {
                    const updated = pvThumbs.map((x, j) => ({ ...x, chosen: j === i }));
                    onPatch({ thumbs: updated });
                  }}
                />
              ))}
            </div>
          )}
          {/* Command summary card */}
          <div style={{ background: t.bg2, border: `1px solid ${t.border}`, borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
              padding: '5px 9px',
              background: t.panelHi,
              borderBottom: `1px solid ${t.border}`,
              fontFamily: FONT_MONO, fontSize: 10, color: t.amber,
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              <Icon name="terminal" size={10}/>
              <span>pixverse create {mode}</span>
            </div>
            {/* model — full width so long names never get clipped */}
            <div style={{
              padding: '4px 9px',
              borderBottom: `1px solid ${t.border}`,
              fontFamily: FONT_MONO, fontSize: 9.5,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              <span style={{ color: t.textMute }}>model</span>
              <span style={{ color: t.text, marginLeft: 5 }}>{model}</span>
            </div>
            {/* quality · ratio · dur/count — 3 columns */}
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${paramFields.length}, 1fr)` }}>
              {paramFields.map((f, i) => (
                <div key={i} style={{
                  padding: '4px 9px',
                  borderLeft: i > 0 ? `1px solid ${t.border}` : 'none',
                  fontFamily: FONT_MONO, fontSize: 9.5,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  minWidth: 0,
                }}>
                  <span style={{ color: t.textMute }}>{f.k}</span>
                  <span style={{ color: t.text, marginLeft: 5 }}>{f.v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    // Non-PixVerse CLI: editable terminal inline
    const cli = node.cli || { cmd: '', args: [] };
    return (
      <div style={{
        background: t.bg2,
        border: `1px solid ${t.border}`,
        borderRadius: 4,
        padding: '8px 10px',
        fontFamily: FONT_MONO, fontSize: 11,
        color: t.text, lineHeight: 1.55,
        wordBreak: 'break-word',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: t.green, flex: 'none' }}>$</span>
          <EditableText
            value={cli.cmd}
            placeholder="cmd"
            mult
            minRows={1}
            maxRows={2}
            onChange={(v) => onPatch({ cli: { ...cli, cmd: v } })}
            style={{ color: t.text, fontSize: 11, fontFamily: FONT_MONO, resize: 'none' }}
          />
        </div>
        {cli.args.map((a, i) => (
          <div key={i} style={{ paddingLeft: 10, color: t.textMid, display: 'flex', alignItems: 'flex-start', gap: 4 }}>
            <EditableText
              value={a}
              placeholder="--flag"
              mult
              minRows={1}
              maxRows={2}
              onChange={(v) => {
                const args = [...cli.args];
                if (v === '' && cli.args.length > 1) {
                  args.splice(i, 1);
                } else {
                  args[i] = v;
                }
                onPatch({ cli: { ...cli, args } });
              }}
              style={{ color: t.textMid, fontSize: 10.5, fontFamily: FONT_MONO, resize: 'none' }}
            />
          </div>
        ))}
        <div
          onClick={(e) => { e.stopPropagation(); onPatch({ cli: { ...cli, args: [...cli.args, ''] } }); }}
          style={{
            paddingLeft: 10, color: t.textMute, fontSize: 10,
            fontFamily: FONT_MONO, cursor: 'pointer',
          }}
        >+ flag</div>
      </div>
    );
  }
  if (node.kind === 'gen' || node.kind === 'motion') {
    const thumbs = (runResult && runResult.thumbs) || node.thumbs || [];
    if (thumbs.length === 0) {
      return (
        <div style={{
          padding: '14px 10px',
          color: t.textMute, fontFamily: FONT_MONO, fontSize: 10.5,
          textAlign: 'center',
          border: `1px dashed ${t.border}`,
          borderRadius: 4,
        }}>
          {node.kind === 'gen' ? 'awaiting prompt' : 'awaiting source image'}
        </div>
      );
    }
    const cols = thumbs.length === 1 ? 1 : thumbs.length <= 4 ? 2 : Math.min(4, Math.ceil(Math.sqrt(thumbs.length)));
    const thumbH = thumbs.length === 1 ? 86 : thumbs.length <= 4 ? 50 : 44;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 4 }}>
        {thumbs.map((im, i) => (
          <MediaThumb
            key={i}
            t={t}
            thumb={im}
            h={thumbH}
            selected={node.kind === 'motion' && im.chosen}
            fallbackLabel={node.kind === 'gen' ? 'image' : 'video'}
            previewable={node.kind !== 'gen'}
            onClick={node.kind === 'motion'
              ? () => {
                const updated = thumbs.map((x, j) => ({ ...x, chosen: j === i }));
                onPatch({ thumbs: updated });
              }
              : undefined}
          />
        ))}
      </div>
    );
  }
  if (node.kind === 'select') {
    return <SelectBody t={t} node={node} runResult={runResult} candidateThumbs={candidateThumbs} onPatch={onPatch}/>;
  }
  if (node.kind === 'asset') {
    const thumbs = node.thumbs || [];
    return (
      <MediaThumb t={t} thumb={thumbs[0] || { seed: node.id, label: node.title }} h={56} fallbackLabel={node.title}/>
    );
  }
  if (node.kind === 'output') {
    // Priority:
    //  1. runOverride — live result stored by the runner (own pass-through result)
    //  2. runResult   — persisted run result for this output node
    //  3. candidateThumbs — the chosen thumb read directly from the upstream node's
    //                       project.runResults (most reliable fallback; bypasses any
    //                       pass-through issues)
    //  4. node.thumbs — static thumbnails baked into the graph JSON
    const effectiveResult =
      (runOverride?.thumbs?.length ? runOverride : null) ||
      (runResult?.thumbs?.length ? runResult : null);
    const thumbs =
      effectiveResult?.thumbs ||
      (candidateThumbs?.length ? candidateThumbs : null) ||
      node.thumbs ||
      [];
    if (thumbs.length === 0) {
      return (
        <div style={{
          padding: '14px 10px',
          color: t.textMute, fontFamily: FONT_MONO, fontSize: 10.5,
          textAlign: 'center',
          border: `1px dashed ${t.border}`,
          borderRadius: 4,
        }}>awaiting final render</div>
      );
    }
    return <MediaThumb t={t} thumb={thumbs[0]} h={70} fallbackLabel={node.title}/>;
  }
  return null;
}

// Main editable node — selectable / draggable / connectable.
function EditorNode({
  t, node, selected,
  runOverride,                 // { state, progress } from current run
  runResult,                   // persisted result (for previews)
  candidateThumbs,             // live upstream thumbs for Pick nodes
  inputReadiness,              // input-port status map from required solid edges
  statusStyle = 'border',
  onMouseDown,                 // start node drag
  onPortMouseDown,             // start connection drag
  onSelect,
  onContextMenu,
  onPatch,                     // patch this node's properties
  onAction,                    // 'rerun' | 'duplicate' | 'delete' | 'edit'
}) {
  const headerColor = {
    prompt: t.accent, gen: t.accent, cli: t.amber, motion: t.amber,
    select: t.green, output: t.green, asset: PORT_COLORS.asset,
  }[node.kind] || t.accent;

  // Effective state: run override > stored
  const state = runOverride?.state || node.state || 'idle';
  const progress = runOverride?.progress ?? node.progress ?? 0;
  const isRunning = state === 'running';
  const isBlocked = state === 'blocked';
  const isWaiting = state === 'waiting_dependencies' || state === 'waiting_user';
  const isError = state === 'error' || isBlocked;
  const isDone = state === 'done';

  let borderColor = t.border;
  if (selected) borderColor = t.accent;
  else if (statusStyle === 'border') {
    if (isError) borderColor = t.red;
    else if (isRunning) borderColor = t.amber;
    else if (isWaiting) borderColor = t.amber;
    else if (isDone) borderColor = t.green;
    else if (state === 'queued') borderColor = t.textMute;
  }

  const displayWidth = nodeDisplayWidth(node);

  return (
    <div
      data-node-id={node.id}
      onClick={(e) => { e.stopPropagation(); onSelect && onSelect(node.id); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu && onContextMenu(node.id, e); }}
      style={{
        position: 'absolute', left: node.x, top: node.y, width: displayWidth,
        background: t.panel,
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        boxShadow: selected
          ? `0 0 0 1px ${t.accent}, 0 10px 28px rgba(0,0,0,0.55)`
          : isRunning
            ? `0 0 0 1px ${t.amber}55, 0 8px 20px rgba(0,0,0,0.4)`
            : '0 4px 14px rgba(0,0,0,0.3)',
        fontFamily: FONT_UI,
        zIndex: selected ? 3 : (isRunning ? 2 : 1),
        transition: 'box-shadow .15s, border-color .15s',
        userSelect: 'none',
      }}
    >
      {/* Top progress bar when running */}
      {isRunning && statusStyle !== 'ring' && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2,
          background: t.border, borderRadius: '8px 8px 0 0', overflow: 'hidden' }}>
          <div style={{ width: `${progress*100}%`, height: 2, background: t.amber, transition: 'width .2s linear' }}/>
        </div>
      )}

      {/* Header — draggable */}
      <div
        onMouseDown={(e) => onMouseDown && onMouseDown(node.id, e)}
        onDoubleClick={(e) => { e.stopPropagation(); onAction && onAction(node.id, 'edit'); }}
        style={{
          padding: '7px 10px',
          display: 'flex', alignItems: 'flex-start', gap: 6,
          flexWrap: 'wrap',
          borderBottom: `1px solid ${t.border}`,
          background: t.panel2,
          borderRadius: '7px 7px 0 0',
          cursor: 'grab',
        }}
      >
        <div style={{ width: 6, height: 6, borderRadius: 2, background: headerColor, marginTop: 4, flex: 'none' }}/>
        <EditableText
          value={node.title}
          onChange={(v) => onPatch({ title: v })}
          mult
          minRows={1}
          maxRows={3}
          style={{ color: t.text, fontSize: 11.5, fontWeight: 600, flex: '1 1 120px', minWidth: 0, resize: 'none', lineHeight: 1.25 }}
        />
        {node.badge && (
          <span style={{ flex: '0 1 auto', maxWidth: '100%', overflowWrap: 'anywhere' }}>
            <Pill bg={t.bg2} color={t.textMute} border={t.border}>{node.badge}</Pill>
          </span>
        )}
        {state === 'running' && (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.amber }} className="mg-pulse"/>
        )}
        {isWaiting && (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.amber }} className="mg-pulse"/>
        )}
        {state === 'done' && (<Icon name="check" size={11} color={t.green}/>)}
        {isError && (<Icon name="close" size={11} color={t.red}/>)}
      </div>

      {/* Body */}
      <div style={{ padding: node.kind === 'asset' ? 6 : node.kind === 'select' ? 12 : 10 }}>
        <EditableBody t={t} node={node} runResult={runResult} runOverride={runOverride} candidateThumbs={candidateThumbs} onPatch={onPatch}/>
      </div>

      {/* Footer */}
      {node.footer && (
        <div style={{
          padding: '5px 10px',
          borderTop: `1px solid ${t.border}`,
          color: t.textMute, fontFamily: FONT_MONO, fontSize: 9.5,
          display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 8, rowGap: 2, alignItems: 'start',
          background: t.bg2,
          borderRadius: '0 0 7px 7px',
        }}>
          <span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.35 }}>{node.footer.left}</span>
          <span style={{
            color: state === 'running' || isWaiting ? t.amber : state === 'done' ? t.green : isError ? t.red : t.textMute,
            whiteSpace: 'nowrap',
            justifySelf: 'end',
          }}>
            {isRunning ? `${Math.round(progress * 100)}%` :
             isBlocked ? 'blocked' :
             isError ? 'error' :
             isDone ? 'done' :
             state === 'waiting_dependencies' ? 'waiting inputs' :
             state === 'waiting_user' ? 'waiting pick' :
             state === 'queued' ? 'queued' :
             node.footer.right}
          </span>
        </div>
      )}

      {/* Visual ports (decorative — actual hit targets are added by EditorCanvas) */}
      {(node.ports || []).map((p, i) => {
        const readiness = p.side === 'left' ? inputReadiness?.[i] : null;
        const readinessColor = readiness?.state === 'ready' ? t.green
          : readiness?.state === 'waiting' ? t.amber
          : readiness?.state === 'blocked' ? t.red
          : t.textMute;
        const readinessLabel = readiness?.state === 'unconnected' ? 'open' : readiness?.state;
        return (
        <div key={i}
          title={readinessLabel ? `${p.label || p.kind}: ${readinessLabel}` : (p.label || p.kind)}
          onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown && onPortMouseDown(node.id, i, e); }}
          style={{
            position: 'absolute',
            [p.side]: -8, top: p.top - 8,
            width: 16, height: 16,
            display: 'flex', alignItems: 'center',
            flexDirection: p.side === 'left' ? 'row' : 'row-reverse',
            cursor: 'crosshair',
            zIndex: 4,
          }}
        >
          <div style={{
            width: 10, height: 10, borderRadius: '50%',
            background: PORT_COLORS[p.kind],
            border: `2px solid ${t.bg}`,
            boxShadow: readiness
              ? `0 0 0 1px ${readinessColor}, 0 0 0 3px ${readinessColor}33`
              : `0 0 0 1px ${PORT_COLORS[p.kind]}`,
            margin: 3,
          }}/>
          {p.label && (
            <div style={{
              position: 'absolute',
              [p.side === 'left' ? 'left' : 'right']: 18,
              top: 4,
              fontFamily: FONT_MONO, fontSize: 9, color: t.textMute,
              letterSpacing: 0.3, whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}>
              {p.label}
              {readinessLabel && <span style={{ color: readinessColor }}> · {readinessLabel}</span>}
            </div>
          )}
        </div>
      )})}

      {/* Selected → hover-style action chip stack on the right */}
      {selected && (
        <div style={{
          position: 'absolute', top: -34, right: 0,
          display: 'flex', gap: 4, alignItems: 'center',
          background: t.panel, border: `1px solid ${t.border}`,
          borderRadius: 6, padding: '3px 4px',
          fontFamily: FONT_MONO, fontSize: 10,
          boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
        }}>
          {[
            { i: 'play', a: 'rerun', tip: 'Run' },
            { i: 'vary', a: 'duplicate', tip: 'Duplicate' },
            { i: 'close', a: 'delete', tip: 'Delete' },
          ].map(b => (
            <div
              key={b.a}
              onClick={(e) => { e.stopPropagation(); onAction && onAction(node.id, b.a); }}
              title={b.tip}
              style={{
                width: 22, height: 22, borderRadius: 3,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: b.a === 'delete' ? t.red : t.textMid,
                cursor: 'pointer',
              }}
            >
              <Icon name={b.i} size={11}/>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

window.EditorNode = EditorNode;
window.EditableText = EditableText;
window.EditableBody = EditableBody;
