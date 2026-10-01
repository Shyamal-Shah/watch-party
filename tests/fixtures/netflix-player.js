// A simulated Netflix page API drives a real video for extension browser tests.
// The native-call log proves synchronization crossed the MAIN-world bridge.
window.nativeCalls = [];
window.netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
  getAllPlayerSessionIds: () => ['preview-session', 'watch-session'],
  getVideoPlayerBySessionId: id => id === 'watch-session' ? {
    seek(milliseconds) { window.nativeCalls.push(['seek', milliseconds]); document.querySelector('video').currentTime = milliseconds / 1000; },
    play() { window.nativeCalls.push(['play']); return document.querySelector('video').play(); },
    pause() { window.nativeCalls.push(['pause']); document.querySelector('video').pause(); },
    // Deliberately no setPlaybackRate: Netflix cannot get drift speed writes.
  } : { seek() { throw new Error('Wrong preview session'); } },
} }) } } } };
