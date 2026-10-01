/* Shared, dependency-free protocol helpers for the extension and relay. */
(function (root) {
  const hosts = new Set(['www.netflix.com', 'www.primevideo.com', 'www.amazon.com', 'www.jiohotstar.com', 'www.hotstar.com']);
  function mediaUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password) return null;
      if (url.hostname === 'www.amazon.com' && !url.pathname.startsWith('/gp/video/')) return null;
      url.hash = '';
      return url.href;
    } catch { return null; }
  }
  function mediaKey(value) {
    const safe = mediaUrl(value);
    if (!safe) return '';
    const url = new URL(safe);
    return url.origin + url.pathname.replace(/\/$/, '');
  }
  function relayUrl(value) {
    const url = new URL(value);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Enter a ws:// or wss:// server URL without credentials or a fragment.');
    return url.href;
  }
  function permissionOrigin(value) {
    const url = new URL(relayUrl(value));
    return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.hostname}/*`;
  }
  function position(state, now = Date.now()) {
    if (!state) return 0;
    const elapsed = state.paused || state.buffering || state.ended ? 0 : Math.max(0, now - state.updatedAt) / 1000;
    return Math.max(0, state.time + elapsed * state.rate);
  }
  function invite(url, code, relay) {
    const safe = mediaUrl(url);
    if (!safe || !/^[A-Z0-9]{6}$/.test(code)) throw new Error('Open a supported video before inviting friends.');
    return `${safe}#watchparty=${encodeURIComponent(JSON.stringify({ v: 2, code, relay: relayUrl(relay) }))}`;
  }
  function parseInvite(value) {
    try {
      const url = new URL(value);
      if (!mediaUrl(value) || !url.hash.startsWith('#watchparty=')) return null;
      const data = JSON.parse(decodeURIComponent(url.hash.slice(12)));
      if (data.v !== 2 || !/^[A-Z0-9]{6}$/.test(data.code)) return null;
      return { code: data.code, relay: relayUrl(data.relay), mediaUrl: mediaUrl(value) };
    } catch { return null; }
  }
  function validRoom(room) {
    return !!room && /^[A-Z0-9]{6}$/.test(room.code) && typeof room.hostId === 'string'
      && typeof room.hostOnly === 'boolean' && Number.isInteger(room.revision) && !!mediaUrl(room.mediaUrl)
      && Array.isArray(room.participants) && room.participants.length <= 2
      && room.participants.every(m => m && typeof m.id === 'string' && typeof m.name === 'string' && typeof m.online === 'boolean')
      && Array.isArray(room.messages) && room.messages.length <= 100
      && room.messages.every(m => m && typeof m.id === 'string' && typeof m.memberId === 'string' && typeof m.name === 'string' && typeof m.text === 'string')
      && (room.activities === undefined || (Array.isArray(room.activities) && room.activities.length <= 100 && room.activities.every(validActivity)))
      && (room.playback === null || (Number.isFinite(room.playback?.time) && room.playback.time >= 0
        && Number.isFinite(room.playback.rate) && room.playback.rate >= 0.25 && room.playback.rate <= 4
        && Number.isFinite(room.playback.updatedAt) && typeof room.playback.paused === 'boolean'));
  }
  function validActivity(item) {
    return !!item && item.kind === 'activity' && typeof item.id === 'string' && typeof item.memberId === 'string'
      && typeof item.name === 'string' && ['play', 'pause', 'forward', 'rewind', 'rate', 'episode', 'next-episode', 'ended'].includes(item.action)
      && Number.isFinite(item.at) && item.at >= 0 && item.at <= 8.64e15
      && Number.isFinite(item.time) && item.time >= 0 && !!mediaUrl(item.mediaUrl)
      && (item.mediaTitle === undefined || typeof item.mediaTitle === 'string')
      && (!['forward', 'rewind', 'episode', 'next-episode'].includes(item.action) || (Number.isFinite(item.fromTime) && item.fromTime >= 0))
      && (item.action !== 'rate' || (Number.isFinite(item.rate) && item.rate >= 0.25 && item.rate <= 4))
      && (item.previousMediaUrl === undefined || !!mediaUrl(item.previousMediaUrl));
  }
  // Track only messages still available in the relay's recent history. The
  // first snapshot is a baseline; repeated snapshots and our own texts don't
  // create notifications. Persisting this state also covers reconnects.
  function updateChatUnread(previous, key, messages, meId) {
    const current = previous?.key === key && previous.initialized === true
      && Array.isArray(previous.seenIds) && Array.isArray(previous.unreadIds) ? previous : null;
    const seen = new Set(current?.seenIds || []);
    const unread = new Set(current?.unreadIds || []);
    const incoming = messages.filter(m => m.memberId !== meId);
    const unreadIds = [...new Set(incoming.filter(m => unread.has(m.id) || (current && !seen.has(m.id))).map(m => m.id))];
    return { key, initialized: true, seenIds: [...new Set(messages.map(m => m.id))], unreadIds };
  }
  function readChatUnread(state, messages, throughId) {
    const index = messages.findIndex(m => m.id === throughId);
    if (!state || index < 0) return state;
    // A reader may still be showing an older snapshot. Never clear newer texts
    // that arrived after the last message it actually displayed.
    const readIds = new Set(messages.slice(0, index + 1).map(m => m.id));
    return { ...state, unreadIds: state.unreadIds.filter(id => !readIds.has(id)) };
  }
  const DEFAULT_RELAY_URL = 'wss://watch-party-i6o3.onrender.com/';
  const api = { DEFAULT_RELAY_URL, mediaUrl, mediaKey, relayUrl, permissionOrigin, position, invite, parseInvite, validRoom, updateChatUnread, readChatUnread };
  if (typeof module !== 'undefined') module.exports = api;
  else root.WatchParty = api;
})(globalThis);
