// Runs in Netflix's MAIN world. No extension APIs or room data cross this bridge.
(() => {
  if (window.__watchPartyNetflixBridge) return;
  window.__watchPartyNetflixBridge = true;
  const commandType = 'watch-party:netflix-command';
  const replyType = 'watch-party:netflix-reply';
  function nativePlayer() {
    const manager = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    const ids = manager?.getAllPlayerSessionIds?.();
    if (!Array.isArray(ids) || !ids.length) return null;
    // Prefer the most recent watch session over a trailer/preview session.
    const watch = ids.filter(id => typeof id === 'string' && /watch/i.test(id));
    const candidates = watch.length ? watch : ids;
    return manager.getVideoPlayerBySessionId?.(candidates[candidates.length - 1]) || null;
  }
  window.addEventListener('message', async event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.type !== commandType
      || typeof data.id !== 'string' || data.id.length > 64) return;
    const reply = result => window.postMessage({ type: replyType, id: data.id, ...result }, location.origin);
    const changes = data.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)
      || Object.keys(changes).some(key => !['time', 'paused', 'rate'].includes(key))
      || (changes.time !== undefined && (!Number.isFinite(changes.time) || changes.time < 0 || changes.time > 86400))
      || (changes.paused !== undefined && typeof changes.paused !== 'boolean')
      || (changes.rate !== undefined && (!Number.isFinite(changes.rate) || changes.rate < 0.25 || changes.rate > 4))) {
      reply({ ok: false, code: 'INVALID' }); return;
    }
    if (!/^\/watch\/\d+\/?$/.test(location.pathname) || data.path !== location.pathname) {
      reply({ ok: false, code: 'STALE' }); return;
    }
    try {
      const player = nativePlayer();
      if (!player) { reply({ ok: false, code: 'NOT_READY' }); return; }
      // Never fall back to writing HTMLVideoElement.currentTime on Netflix.
      if (changes.time !== undefined) {
        if (typeof player.seek !== 'function') { reply({ ok: false, code: 'UNSUPPORTED' }); return; }
        await player.seek(Math.round(changes.time * 1000));
      }
      if (data.path !== location.pathname) { reply({ ok: false, code: 'STALE' }); return; }
      const rateSupported = typeof player.setPlaybackRate === 'function';
      if (changes.rate !== undefined && rateSupported) await player.setPlaybackRate(changes.rate);
      if (changes.paused !== undefined) {
        const method = changes.paused ? 'pause' : 'play';
        if (typeof player[method] !== 'function') { reply({ ok: false, code: 'UNSUPPORTED' }); return; }
        if (data.path !== location.pathname) { reply({ ok: false, code: 'STALE' }); return; }
        await player[method]();
      }
      reply({ ok: true, rateSupported });
    } catch (error) {
      reply({ ok: false, code: error?.name === 'NotAllowedError' ? 'AUTOPLAY' : 'FAILED' });
    }
  });
})();
