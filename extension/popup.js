const P = WatchParty;
const $ = id => document.getElementById(id);
const msg = text => { $('message').textContent = text; };
let current = null;
let incoming = null;
let starting = false;
const sourceTab = new URL(location.href).searchParams.get('sourceTab');
async function request(packet) {
  const response = await chrome.runtime.sendMessage(packet);
  if (response?.rpcError) throw new Error(response.rpcError);
  return response;
}
function show(view) {
  const previousError = current?.error;
  current = view;
  const party = view?.party;
  $('active').classList.toggle('hidden', !party || !!incoming);
  $('start').classList.toggle('hidden', !!party && !incoming);
  $('relay-settings').classList.toggle('hidden', !!party && !incoming);
  if (party) {
    $('room-code').textContent = party.code;
    $('connection').textContent = ({ connected: 'Connected', connecting: 'Connecting to party…', reconnecting: 'Reconnecting automatically…', error: 'Unable to connect' })[view.status] || view.status;
    const count = view.room?.participants.filter(m => m.online).length || 0;
    $('party-info').textContent = `${count} / 2 watching${view.meId && view.meId === view.room?.hostId ? ' · You are the host' : ''}${view.pending?.length ? ` · ${view.pending.length} messages waiting` : ''}`;
    $('copy-invite').disabled = !view.room || view.status !== 'connected';
    $('retry').classList.toggle('hidden', view.status === 'connected');
  }
  const unrelatedRemoval = view?.status === 'removed' && incoming
    && (incoming.code !== view.removal?.code || incoming.relay !== view.removal?.relayUrl);
  if (view?.error && !unrelatedRemoval) msg(view.error);
  else if ($('message').textContent === previousError || $('message').textContent === view?.error) msg('');
}
function fillInvite(invite) {
  incoming = invite;
  $('code').value = invite.code; $('relay-url').value = invite.relay;
  $('invite-info').classList.remove('hidden');
  $('invite-info').textContent = `Join room ${invite.code} on ${new URL(invite.relay).host}. Joining replaces your current party.`;
  $('create').classList.add('hidden'); show(current);
}
function createCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), n => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n % 32]).join('');
}
async function start(create) {
  if (starting) return;
  starting = true;
  $('create').disabled = $('join').disabled = true;
  try {
    const pasted = P.parseInvite($('code').value.trim());
    if (pasted) fillInvite(pasted);
    const code = create ? createCode() : $('code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('Enter a six character code or a valid invite link.');
    const relay = P.relayUrl($('relay-url').value.trim() || P.DEFAULT_RELAY_URL);
    // Keep the permission request directly inside this button's user gesture.
    const allowed = await chrome.permissions.request({ origins: [P.permissionOrigin(relay)] });
    if (!allowed) throw new Error('Allow connection to this server to join the party.');
    let tab;
    if (!create && sourceTab !== null) {
      const id = /^\d+$/.test(sourceTab) ? Number(sourceTab) : NaN;
      tab = Number.isSafeInteger(id) ? await chrome.tabs.get(id).catch(() => null) : null;
      if (!tab || !P.mediaUrl(tab.pendingUrl || tab.url)) throw new Error('The original streaming tab closed or changed. Open the invite again from your video tab.');
    } else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const supported = P.mediaUrl(tab?.pendingUrl || tab?.url);
    let mediaUrl = incoming?.code === code ? incoming.mediaUrl : supported;
    if (create) {
      const player = tab?.id ? await chrome.tabs.sendMessage(tab.id, { type: 'GET_PLAYER' }).catch(() => null) : null;
      if (!player?.hasVideo || !supported) throw new Error('Open a video on Netflix, Prime Video, or JioHotstar first. Refresh the streaming tab if you just installed the extension.');
      mediaUrl = player.mediaUrl;
    }
    await request({ type: 'START_PARTY', create, code, relayUrl: relay, name: $('name').value.trim() || 'Guest', mediaUrl, tabId: supported ? tab.id : null, focusOnJoin: !create && sourceTab !== null });
    incoming = null; $('invite-info').classList.add('hidden'); $('create').classList.remove('hidden');
    msg(''); show(await request({ type: 'GET_VIEW' }));
  } catch (e) { msg(e.message === 'Invalid URL' ? 'Enter a relay server URL or paste an invite link first.' : e.message); $('relay-settings').open = true; }
  finally { starting = false; $('create').disabled = $('join').disabled = false; }
}
$('create').onclick = () => start(true);
$('join').onclick = () => start(false);
$('code').addEventListener('paste', () => setTimeout(() => { const parsed = P.parseInvite($('code').value.trim()); if (parsed) fillInvite(parsed); }, 0));
$('copy-code').onclick = async () => { try { await navigator.clipboard.writeText(current.party.code); msg('Room code copied.'); } catch (e) { msg(e.message); } };
$('copy-invite').onclick = async () => {
  try { await navigator.clipboard.writeText(P.invite(current.room.mediaUrl, current.party.code, current.party.relayUrl)); msg('Invite copied. Your friends can open this link with the extension installed.'); } catch (e) { msg(e.message); }
};
$('leave').onclick = async () => { await request({ type: 'LEAVE' }); msg(''); show(await request({ type: 'GET_VIEW' })); };
$('open-call').onclick = () => request({ type: 'OPEN_CALL' }).catch(e => msg(e.message));
$('retry').onclick = () => request({ type: 'RETRY' }).catch(e => msg(e.message));
$('open-party').onclick = async () => {
  try {
    await chrome.tabs.update(current.tabId, { active: true });
    await chrome.tabs.sendMessage(current.tabId, { type: 'OPEN_PANEL' });
  } catch { msg('The player is loading. Refresh the streaming tab if the panel does not appear.'); }
};
$('save-relay').onclick = async () => {
  try {
    const relay = P.relayUrl($('relay-url').value.trim());
    if (!await chrome.permissions.request({ origins: [P.permissionOrigin(relay)] })) throw new Error('Server permission was declined.');
    await chrome.storage.local.set({ relayUrl: relay }); $('relay-url').value = relay; msg('Server saved. Start or join a party.');
  } catch (e) { msg(e.message); }
};
$('default-relay').onclick = async () => {
  try {
    $('relay-url').value = P.DEFAULT_RELAY_URL;
    await chrome.storage.local.set({ relayUrl: P.DEFAULT_RELAY_URL });
    msg('Default server selected. Chrome may ask for access when you start or join.');
  } catch (e) { msg(e.message); }
};
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.roomView) show(changes.roomView.newValue); });
(async () => {
  const saved = await chrome.storage.local.get(['relayUrl', 'displayName']);
  $('relay-url').value = saved.relayUrl || P.DEFAULT_RELAY_URL; $('name').value = saved.displayName || '';
  show(await request({ type: 'GET_VIEW' }));
  if (location.hash.startsWith('#invite=')) {
    try { const parsed = P.parseInvite(decodeURIComponent(location.hash.slice(8))); if (parsed) fillInvite(parsed); } catch { msg('Invalid invite link.'); }
  }
})();
