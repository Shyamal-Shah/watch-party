importScripts('shared.js');
const P = WatchParty;
let party = null;
let token = '';
let room = null;
let meId = '';
let status = 'idle';
let error = '';
let socket = null;
let retryTimer, heartbeat, connectTimeout;
let attempt = 0;
let lastSeen = 0;
let halfRtt = 0;
let pending = [];
let stopped = false;
let callTabId = null;
let callSession = null;
let callPort = null;
let chain = Promise.resolve();
const enqueue = work => {
  const result = chain.then(work);
  chain = result.catch(console.error);
  return result;
};
function view() {
  return { party: party ? { code: party.code, name: party.name, relayUrl: party.relayUrl, mediaUrl: party.mediaUrl } : null,
    tabId: party?.tabId, room, meId, status, error, pending, retrySeconds: Math.min(30, 2 ** attempt) };
}
async function publish() { await chrome.storage.local.set({ roomView: view() }); }
async function saveSession() { await chrome.storage.local.set({ party, pendingChats: pending }); }
async function followHost(joined = false) {
  if (!party || meId === room.hostId) return;
  const target = P.mediaUrl(room.mediaUrl);
  const key = P.mediaKey(target);
  if (!target || (!joined && party.followedMedia === key)) return;
  // Remember each destination even if the service redirects to login. Subsequent
  // playback snapshots must not interrupt sign-in or repeatedly reload the tab.
  party.followedMedia = key;
  try {
    const tab = await chrome.tabs.get(party.tabId);
    if (P.mediaKey(tab.pendingUrl || tab.url) !== key) await chrome.tabs.update(tab.id, { url: target });
  } catch {
    error = 'Could not follow the host’s video. Use Open host’s video in the party panel to retry.';
  }
}
function teardown() {
  clearTimeout(retryTimer); clearTimeout(connectTimeout); clearInterval(heartbeat);
  const old = socket;
  socket = null;
  old?.close();
}
function send(packet) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(packet)); return true;
}
function scheduleReconnect() {
  if (!party || stopped) return;
  status = 'reconnecting';
  error = 'Connection lost. Rejoining automatically; chat messages will wait for delivery.';
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)) + Math.random() * 500;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => enqueue(connect), delay);
}
async function connect() {
  if (!party || stopped || socket) return;
  status = attempt ? 'reconnecting' : 'connecting';
  await publish();
  const ws = new WebSocket(party.relayUrl);
  socket = ws;
  connectTimeout = setTimeout(() => { if (socket === ws) ws.close(); }, 15_000);
  ws.addEventListener('open', () => enqueue(async () => {
    if (socket !== ws) return;
    lastSeen = Date.now();
    const secret = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token + '|' + party.relayUrl));
    const relayToken = Array.from(new Uint8Array(secret), n => n.toString(16).padStart(2, '0')).join('');
    if (socket !== ws) return;
    send({ type: 'join', v: 2, code: party.code, token: relayToken, name: party.name, create: party.create, mediaUrl: party.mediaUrl });
    send({ type: 'ping', clientTime: Date.now() });
    heartbeat = setInterval(() => {
      if (socket !== ws) return;
      if (Date.now() - lastSeen > 55_000) ws.close();
      else send({ type: 'ping', clientTime: Date.now() });
    }, 20_000);
  }));
  ws.addEventListener('message', event => enqueue(async () => {
    if (socket !== ws) return;
    let packet;
    try { packet = JSON.parse(event.data); } catch { return; }
    if (!packet || typeof packet !== 'object') return;
    lastSeen = Date.now();
    if (packet.type === 'pong') {
      if (Number.isFinite(packet.clientTime)) halfRtt = Math.min(1000, Math.max(0, Date.now() - packet.clientTime) / 2);
      return;
    }
    if (['signal', 'call-config'].includes(packet.type)) {
      if (callTabId != null && callSession && (packet.type === 'signal' ? packet.peerSession : packet.session) === callSession) {
        try { callPort?.postMessage({ type: 'CALL_PACKET', packet }); } catch { /* The call window closed. */ }
      }
      return;
    }
    if (packet.type === 'removed') {
      stopped = true; teardown(); party = null; room = null; pending = [];
      status = 'removed'; error = packet.message;
      await saveSession(); await publish(); return;
    }
    if (packet.type === 'error') {
      error = String(packet.message || 'The relay rejected this action.');
      if (packet.fatal) { stopped = true; status = 'error'; teardown(); }
      await publish(); return;
    }
    if (packet.type === 'ack') {
      pending = pending.filter(item => item.id !== packet.id);
      await saveSession(); await publish(); return;
    }
    if (!['room', 'joined'].includes(packet.type) || packet.room?.code !== party.code) return;
    if (!P.validRoom(packet.room) || !Number.isFinite(packet.serverTime)) {
      stopped = true; status = 'error'; error = 'The relay returned an invalid room. Update the relay and extension together.'; teardown(); await publish(); return;
    }
    room = packet.room;
    if (room.playback) room.playback = { ...room.playback, time: P.position(room.playback, packet.serverTime + halfRtt), updatedAt: Date.now() };
    if (packet.type === 'joined') {
      clearTimeout(connectTimeout);
      meId = packet.meId; status = 'connected'; error = ''; attempt = 0;
      party.create = false;
      const tab = party.tabId != null ? await chrome.tabs.get(party.tabId).catch(() => null) : null;
      if (!tab) {
        const opened = await chrome.tabs.create({ url: room.mediaUrl });
        party.tabId = opened.id;
      }
      await saveSession();
      for (const item of pending) send({ type: 'chat', id: item.id, text: item.text });
    }
    await followHost(packet.type === 'joined');
    // Room snapshots also acknowledge delivered chat, including after reconnect.
    pending = pending.filter(item => !room.messages.some(m => m.id === item.id && m.memberId === meId));
    await saveSession(); await publish();
  }));
  ws.addEventListener('close', () => enqueue(async () => {
    if (socket !== ws) return;
    teardown(); scheduleReconnect(); await publish();
  }));
  ws.addEventListener('error', () => { if (socket === ws) ws.close(); });
}
async function leave() {
  callSession = null;
  send({ type: 'leave' });
  teardown(); party = null; room = null; meId = ''; pending = [];
  status = 'idle'; error = ''; stopped = false; attempt = 0;
  await saveSession(); await publish();
}
async function handle(message, sender) {
  const bound = party && sender.tab?.id === party.tabId;
  if (message.type === 'GET_VIEW') return { ...view(), bound: !!bound };
  if (message.type === 'OPEN_INVITE') {
    const invite = P.parseInvite(message.url);
    if (!invite) throw new Error('Invalid invite link.');
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') + '#invite=' + encodeURIComponent(message.url) });
    return {};
  }
  const extensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  if (message.type === 'OPEN_CALL' && (bound || extensionPage)) {
    if (!party || status !== 'connected') throw new Error('Connect to a party first.');
    if (!room?.capabilities?.voiceVideo) throw new Error('The host needs to update the relay for voice and video calls.');
    const tab = callTabId != null ? await chrome.tabs.get(callTabId).catch(() => null) : null;
    if (tab && tab.url?.startsWith(chrome.runtime.getURL('call.html'))) {
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
    } else {
      const window = await chrome.windows.create({ url: chrome.runtime.getURL('call.html'), type: 'popup', width: 430, height: 720 });
      callTabId = window.tabs?.[0]?.id ?? null;
      await chrome.storage.session.set({ callTabId });
    }
    return {};
  }
  const callPage = sender.url === chrome.runtime.getURL('call.html') && sender.tab?.id === callTabId;
  if (message.type.startsWith('CALL_')) {
    if (!callPage) throw new Error('Open the call window from the party controls.');
    if (message.type === 'CALL_STOP') {
      if (callSession === message.session) { send({ type: 'call-stop', session: callSession }); callSession = null; }
      return {};
    }
    if (!party || status !== 'connected' || !room?.capabilities?.voiceVideo) throw new Error('Wait for the party to reconnect.');
    if (message.type === 'CALL_READY') {
      if (message.code !== party.code) throw new Error('The party changed. Join the new call when you are ready.');
      callSession = message.session;
      send({ type: 'call-ready', session: callSession, mic: !!message.mic, camera: !!message.camera });
    } else if (message.session === callSession) {
      if (message.type === 'CALL_SIGNAL') send({ type: 'signal', session: callSession, to: message.to, peerSession: message.peerSession, data: message.data });
      if (message.type === 'CALL_MEDIA') send({ type: 'call-media', session: callSession, mic: !!message.mic, camera: !!message.camera });
    }
    return {};
  }
  if (message.type === 'START_PARTY' && extensionPage) {
    const relayUrl = P.relayUrl(message.relayUrl || P.DEFAULT_RELAY_URL);
    if (!await chrome.permissions.contains({ origins: [P.permissionOrigin(relayUrl)] })) throw new Error('Allow access to the relay server first.');
    if (!/^[A-Z0-9]{6}$/.test(message.code)) throw new Error('Enter a six character room code.');
    if (message.create && !P.mediaUrl(message.mediaUrl)) throw new Error('Open a supported video first.');
    await leave();
    party = { v: 2, code: message.code, name: String(message.name || 'Guest').slice(0, 24), relayUrl,
      create: !!message.create, mediaUrl: P.mediaUrl(message.mediaUrl), tabId: message.tabId ?? null };
    await chrome.storage.local.set({ relayUrl, displayName: party.name });
    await saveSession(); await connect(); return {};
  }
  if (message.type === 'LEAVE' && (bound || extensionPage)) { await leave(); return {}; }
  if (message.type === 'RETRY' && (bound || extensionPage)) {
    stopped = false; attempt = 0; error = ''; teardown(); await connect(); return {};
  }
  if (!bound && !extensionPage) throw new Error('This tab is not in the party.');
  if (message.type === 'CHAT') {
    if (!party || stopped) throw new Error('Join an active room first.');
    const text = String(message.text || '').trim().slice(0, 500);
    if (!text) return {};
    if (pending.length >= 50) throw new Error('50 messages are waiting. Reconnect before sending more.');
    const item = { id: crypto.randomUUID(), text, name: party.name };
    pending.push(item); await saveSession(); await publish();
    if (status === 'connected') send({ type: 'chat', id: item.id, text });
    return {};
  }
  if (message.type === 'PLAYBACK' && bound && status === 'connected') {
    if (room?.hostOnly && meId !== room.hostId) return {};
    send({ type: 'playback', playback: message.playback, reason: message.reason, revision: message.revision, mediaUrl: P.mediaUrl(message.mediaUrl) });
    return {};
  }
  if (message.type === 'PRESENCE' && bound && status === 'connected') { send({ type: 'presence', buffering: !!message.buffering }); return {}; }
  if (['SETTINGS', 'KICK'].includes(message.type)) {
    if (status !== 'connected' || meId !== room?.hostId) throw new Error('Only the connected host can change room controls.');
    send(message.type === 'KICK' ? { type: 'kick', id: message.id } : { type: 'settings', hostOnly: !!message.hostOnly }); return {};
  }
  if (message.type === 'OPEN_VIDEO' && party && P.mediaUrl(room?.mediaUrl)) {
    await chrome.tabs.update(party.tabId, { url: room.mediaUrl, active: true });
    party.followedMedia = P.mediaKey(room.mediaUrl);
    if (error.startsWith('Could not follow the host')) error = '';
    await saveSession(); await publish(); return {};
  }
  return {};
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'call-window') return;
  enqueue(async () => {
    if (port.sender?.url !== chrome.runtime.getURL('call.html') || port.sender.tab?.id !== callTabId) { port.disconnect(); return; }
    const previous = callPort;
    callPort = port;
    if (previous) {
      send({ type: 'call-stop', session: callSession }); callSession = null;
      previous.disconnect();
    }
    port.onDisconnect.addListener(() => enqueue(async () => {
      if (callPort !== port) return;
      callPort = null;
      send({ type: 'call-stop', session: callSession }); callSession = null;
    }));
  });
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  enqueue(() => handle(message, sender)).then(respond, e => respond({ rpcError: e.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(id => enqueue(async () => {
  if (callTabId === id) {
    send({ type: 'call-stop', session: callSession }); callSession = null; callTabId = null;
    await chrome.storage.session.remove('callTabId');
  }
  if (party?.tabId === id) await leave();
}));
chrome.alarms.create('relay-recovery', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => enqueue(connect));
enqueue(async () => {
  const call = await chrome.storage.session.get('callTabId');
  callTabId = call.callTabId ?? null;
  const saved = await chrome.storage.local.get(['party', 'identityToken', 'pendingChats']);
  token = saved.identityToken || Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({ identityToken: token });
  party = saved.party?.v === 2 ? saved.party : null;
  pending = party ? saved.pendingChats || [] : [];
  await publish(); await connect();
});
