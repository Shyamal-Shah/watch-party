const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

function setup(player, sessions = ['preview', 'watch-old', 'watch-current']) {
  const callbacks = new Set(), calls = [], replies = [];
  const location = { hostname: 'www.netflix.com', origin: 'https://www.netflix.com', pathname: '/watch/123' };
  const window = {
    addEventListener: (type, callback) => callbacks.add(callback),
    removeEventListener: (type, callback) => callbacks.delete(callback),
    postMessage(data) {
      if (data.type === 'watch-party:netflix-reply') replies.push(data);
      queueMicrotask(() => { for (const callback of [...callbacks]) callback({ source: window, origin: location.origin, data }); });
    },
    netflix: player ? { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
      getAllPlayerSessionIds: () => sessions,
      getVideoPlayerBySessionId: id => { calls.push(id); return player; },
    } }) } } } } : undefined,
  };
  const context = vm.createContext({ window, location, crypto: { randomUUID }, setTimeout, clearTimeout });
  for (const file of ['netflix-bridge.js', 'player-controls.js']) {
    vm.runInContext(readFileSync(join(__dirname, '..', 'extension', file), 'utf8'), context);
  }
  // These throw if an integration ever silently falls back to video writes.
  const video = {
    set currentTime(value) { throw new Error('Unsafe direct seek'); },
    set playbackRate(value) { throw new Error('Unsafe direct rate'); },
    play() { throw new Error('Unsafe direct play'); },
    pause() { throw new Error('Unsafe direct pause'); },
  };
  return { context, window, location, video, calls, replies, apply: changes => context.WatchPartyPlayer.apply(video, changes) };
}

test('Netflix controls use the latest watch session, milliseconds, and native play/pause', async () => {
  const operations = [];
  const env = setup({ seek: value => operations.push(['seek', value]), play: () => operations.push(['play']), pause: () => operations.push(['pause']) });
  const result = await env.apply({ time: 17.123, paused: false, rate: 1.03 });
  assert.deepEqual(operations, [['seek', 17123], ['play']]);
  assert.equal(result.rateSupported, false);
  await env.apply({ paused: true });
  assert.deepEqual(operations.at(-1), ['pause']);
  assert.equal(env.calls[0], 'watch-current');
});

test('Netflix uses native speed control only when the player exposes it', async () => {
  let rate;
  const env = setup({ setPlaybackRate: value => { rate = value; } });
  assert.equal((await env.apply({ rate: 1.5 })).rateSupported, true);
  assert.equal(rate, 1.5);
});

test('missing or rejected Netflix APIs fail without touching the video element', async () => {
  await assert.rejects(setup(null).apply({ time: 10 }), error => error.code === 'NOT_READY');
  await assert.rejects(setup({}).apply({ time: 10 }), error => error.code === 'UNSUPPORTED');
  const env = setup({ seek: () => { throw new Error('Player rejected seek'); } });
  await assert.rejects(env.apply({ time: 10 }), error => error.code === 'FAILED');
  const blocked = setup({ play: () => Promise.reject(Object.assign(new Error('Click required'), { name: 'NotAllowedError' })) });
  await assert.rejects(blocked.apply({ paused: false }), error => error.code === 'AUTOPLAY');
});

test('bridge rejects invalid controls and commands for a different Netflix title', async () => {
  let writes = 0;
  const env = setup({ seek: () => { writes++; } });
  for (const changes of [{ time: -1 }, { time: Infinity }, { paused: 'yes' }, { rate: 100 }, { arbitrary: true }]) {
    await assert.rejects(env.apply(changes), error => error.code === 'INVALID');
  }
  env.window.postMessage({ type: 'watch-party:netflix-command', id: 'stale-test', path: '/watch/456', changes: { time: 10 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.replies.at(-1).code, 'STALE');
  assert.equal(writes, 0);
});

test('generic player controls still seek, change speed, and play/pause directly', async () => {
  const context = vm.createContext({ location: { hostname: 'www.primevideo.com' } });
  vm.runInContext(readFileSync(join(__dirname, '..', 'extension/player-controls.js'), 'utf8'), context);
  const video = { currentTime: 0, playbackRate: 1, paused: true, play() { this.paused = false; }, pause() { this.paused = true; } };
  await context.WatchPartyPlayer.apply(video, { time: 20, rate: 1.5, paused: false });
  assert.equal(video.currentTime, 20); assert.equal(video.playbackRate, 1.5); assert.equal(video.paused, false);
  await context.WatchPartyPlayer.apply(video, { paused: true }); assert.equal(video.paused, true);
});
