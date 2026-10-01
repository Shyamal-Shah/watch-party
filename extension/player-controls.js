// Netflix controls are sent to its page player; other sites use their video element.
(() => {
  const netflix = location.hostname === 'www.netflix.com';
  function command(changes) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const fail = code => reject(Object.assign(new Error('Netflix player command failed'), { code }));
      const finish = () => { clearTimeout(timeout); window.removeEventListener('message', receive); };
      const receive = event => {
        if (event.source !== window || event.origin !== location.origin
          || event.data?.type !== 'watch-party:netflix-reply' || event.data.id !== id) return;
        finish();
        if (event.data.ok === true) resolve({ rateSupported: event.data.rateSupported === true });
        else fail(event.data.code || 'FAILED');
      };
      const timeout = setTimeout(() => { finish(); fail('NOT_READY'); }, 2500);
      window.addEventListener('message', receive);
      window.postMessage({ type: 'watch-party:netflix-command', id, path: location.pathname, changes }, location.origin);
    });
  }
  async function apply(video, changes) {
    if (netflix) return command(changes);
    if (changes.time !== undefined) video.currentTime = changes.time;
    if (changes.rate !== undefined) video.playbackRate = changes.rate;
    if (changes.paused === true) video.pause();
    else if (changes.paused === false) await video.play();
    return { rateSupported: true };
  }
  globalThis.WatchPartyPlayer = { netflix, apply };
})();
