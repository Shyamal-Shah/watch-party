(() => {
  if (window.__watchPartyLoaded) return;
  window.__watchPartyLoaded = true;
  const P = WatchParty;
  const controls = WatchPartyPlayer;
  let incomingInvite = P.parseInvite(location.href);
  let inviteUrl = location.href;
  let inviteDismissed = false;
  let dismissedRemoval = null;
  let view = null, tabId = null, player = null, playerEvents = null;
  let root, ui, panel, statusLine, note, people, chat, input, hostOnly, hostSettings, retry, follow, unlock, inviteButton;
  let chatToggle, unreadBadge, readingChat = false;
  let suppressUntil = 0, expectedSeek = null, buffering = false, autoplayBlocked = false, correctionRate = null;
  let lastSyncSeek = -Infinity, applying = false, controlEpoch = 0, rateUnsupported = false, playerError = '';
  let localActionAt = 0, lastPublish = 0, lastMedia = '', lastPeople = '', lastChat = '', localError = '';
  const active = () => view?.party && view.tabId === tabId;
  const isHost = () => view?.room?.hostId === view?.meId;
  const canControl = () => isHost() || view?.room?.hostOnly === false;
  async function request(message) {
    try {
      const result = await chrome.runtime.sendMessage(message);
      if (result?.rpcError) throw new Error(result.rpcError);
      return result;
    } catch (e) { localError = e.message; render(); return null; }
  }
  function el(tag, text, parent, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    if (parent) parent.append(node);
    return node;
  }
  function button(text, parent, action) {
    const b = el('button', text, parent); b.type = 'button'; b.onclick = action; return b;
  }
  function mount() {
    if (root || !document.documentElement) return;
    root = document.createElement('div'); root.id = 'wp-root';
    ui = root.attachShadow({ mode: 'open' });
    const style = el('style', '', ui);
    style.textContent = `
      :host{all:initial;font-family:Arial,sans-serif;color:#f8f4f8}*{box-sizing:border-box;font-family:Arial,sans-serif}button,input{font:inherit}button{cursor:pointer;border:1px solid #534251;border-radius:7px;background:#302331;color:#fff;padding:7px 10px;font-size:12px}button:hover{background:#50304a}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #fc8cba;outline-offset:2px}[hidden]{display:none!important}.panel{color:#f8f4f8;width:340px;max-width:calc(100vw - 24px);max-height:calc(100vh - 90px);background:#17131b;border:1px solid #624255;border-radius:15px;box-shadow:0 16px 60px #000a;display:flex;flex-direction:column;overflow:auto;margin-bottom:10px}header{display:flex;justify-content:space-between;align-items:center;padding:14px;background:#322032;font-size:14px}header small{display:block;color:#dfbad0;font-size:11px;margin-top:5px}.status{padding:10px 14px;color:#efb8cf;font-size:12px;line-height:1.5}.note{padding:0 14px 10px;color:#bfb2c5;font-size:11px;line-height:1.5}.actions{display:flex;gap:5px;padding:0 12px 10px;flex-wrap:wrap}.people{padding:0 14px 10px;max-height:120px;overflow:auto;font-size:12px}.person{display:flex;gap:7px;align-items:center;margin:5px 0}.person span{flex:1}.person button{font-size:10px;padding:3px 5px}.settings{padding:0 12px 10px;font-size:12px}.chat{height:180px;min-height:90px;overflow:auto;border-top:1px solid #3a2b3a;padding:10px 14px;font-size:12px;line-height:1.5}.line{margin:5px 0;overflow-wrap:anywhere}.line b{color:#f994be}.pending{opacity:.65}form{display:flex;gap:6px;padding:10px;border-top:1px solid #3a2b3a}input[type=text]{min-width:0;flex:1;color:#fff;background:#29212d;border:1px solid #5a4356;border-radius:7px;padding:9px;font-size:12px}.toggle{float:right;width:48px;height:48px;border-radius:16px;background:#d94483;font-size:23px}.invite{padding:16px;font-size:13px;line-height:1.6}.invite p{margin:0 0 10px}.invite button{margin-right:6px}
    `;
    style.textContent += `
      .toggle{position:relative}.unread-badge{position:absolute;top:-6px;right:-6px;min-width:23px;height:23px;padding:0 5px;border:2px solid #17131b;border-radius:999px;background:#ff668e;color:#17131b;font-size:11px;line-height:19px;font-weight:700;text-align:center;pointer-events:none}
    `;
    root.addEventListener('keydown', event => event.stopPropagation());
    document.documentElement.append(root);
  }
  function showInvite() {
    if (!incomingInvite || inviteDismissed || active()) return;
    mount(); if (!root || ui.querySelector('.invite')) return;
    const box = el('section', '', ui, 'panel invite');
    el('p', `You’re invited to Watch Party ${incomingInvite.code}.`, box);
    button('Join party', box, () => request({ type: 'OPEN_INVITE', url: location.href.includes('#watchparty=') ? location.href : P.invite(incomingInvite.mediaUrl, incomingInvite.code, incomingInvite.relay) }));
    button('Dismiss', box, () => { inviteDismissed = true; root.remove(); root = null; });
  }
  function buildPanel() {
    mount(); if (!root || panel) return;
    ui.querySelector('.invite')?.remove();
    panel = el('section', '', ui, 'panel');
    const header = el('header', '', panel);
    const title = el('div', 'Watch Party', header);
    el('small', `Room ${view.party.code}`, title);
    panel.id = 'wp-party-panel';
    panel.addEventListener('scroll', markChatRead, { passive: true });
    button('×', header, () => setPanelOpen(false)).setAttribute('aria-label', 'Hide chat');
    statusLine = el('div', '', panel, 'status'); statusLine.setAttribute('role', 'status');
    note = el('div', '', panel, 'note'); note.setAttribute('aria-live', 'polite');
    const actions = el('div', '', panel, 'actions');
    inviteButton = button('Copy invite', actions, async () => {
      try { await navigator.clipboard.writeText(P.invite(view.room.mediaUrl, view.party.code, view.party.relayUrl)); localError = 'Invite copied.'; } catch (e) { localError = e.message; }
      render();
      setTimeout(() => { localError = ''; render(); }, 2500);
    });
    retry = button('Reconnect', actions, () => { localError = ''; request({ type: 'RETRY' }); });
    follow = button('Open host’s video', actions, () => request({ type: 'OPEN_VIDEO' }));
    unlock = button('Resume sync', actions, async () => {
      if (!player) return;
      autoplayBlocked = false;
      try { await controls.apply(player, { paused: false }); playerError = ''; applyState(true); }
      catch (error) { controlFailure(error); }
      render();
    });
    button('Voice / video call', actions, () => request({ type: 'OPEN_CALL' }));
    button('Leave', actions, () => request({ type: 'LEAVE' }));
    hostSettings = el('label', '', panel, 'settings');
    hostOnly = el('input', '', hostSettings); hostOnly.type = 'checkbox';
    hostSettings.append(document.createTextNode(' Only the host controls playback'));
    hostOnly.onchange = () => request({ type: 'SETTINGS', hostOnly: hostOnly.checked });
    people = el('div', '', panel, 'people'); people.setAttribute('aria-label', 'Participants');
    chat = el('div', '', panel, 'chat'); chat.setAttribute('role', 'log'); chat.setAttribute('aria-label', 'Party chat');
    chat.addEventListener('scroll', markChatRead, { passive: true });
    const form = el('form', '', panel);
    input = el('input', '', form); input.type = 'text'; input.placeholder = 'Say something…'; input.maxLength = 500; input.setAttribute('aria-label', 'Chat message');
    const send = el('button', 'Send', form); send.type = 'submit';
    form.onsubmit = async event => {
      event.preventDefault(); if (!input.value.trim()) return;
      const result = await request({ type: 'CHAT', text: input.value });
      if (result) input.value = '';
    };
    chatToggle = button('✦', ui, () => setPanelOpen(panel.hidden)); chatToggle.className = 'toggle';
    chatToggle.setAttribute('aria-controls', panel.id);
    unreadBadge = el('span', '', chatToggle, 'unread-badge'); unreadBadge.setAttribute('aria-hidden', 'true');
  }
  function setPanelOpen(open) {
    if (!panel) return;
    panel.hidden = !open;
    if (open) {
      chat.scrollTop = chat.scrollHeight;
      panel.scrollTop = panel.scrollHeight;
    }
    render();
    requestAnimationFrame(markChatRead);
  }
  function markChatRead() {
    if (readingChat || !active() || !view.unreadCount || !panel || panel.hidden || !chat?.clientHeight
      || document.visibilityState !== 'visible' || !document.hasFocus()
      || chat.scrollHeight - chat.scrollTop - chat.clientHeight > 2) return;
    const bounds = chat.getBoundingClientRect(), panelBounds = panel.getBoundingClientRect();
    if (bounds.bottom > Math.min(innerHeight, panelBounds.bottom) || bounds.bottom <= Math.max(0, panelBounds.top)) return;
    const throughId = view.room?.messages.at(-1)?.id;
    if (!throughId) return;
    readingChat = true;
    // Acknowledge the displayed snapshot, so a simultaneous incoming message
    // remains unread until it has also been rendered in the visible chat.
    chrome.runtime.sendMessage({ type: 'CHAT_READ', code: view.party.code, relayUrl: view.party.relayUrl, throughId })
      .catch(() => {}).finally(() => { readingChat = false; });
  }
  function render() {
    // Same-document navigation can deliver a new invitation without reloading.
    if (inviteUrl !== location.href) {
      const previousUrl = inviteUrl;
      inviteUrl = location.href;
      const nextInvite = P.parseInvite(inviteUrl);
      // Keep an invitation if the player only strips its fragment during startup.
      if ((nextInvite || P.mediaKey(previousUrl) !== P.mediaKey(inviteUrl)) && JSON.stringify(nextInvite) !== JSON.stringify(incomingInvite)) {
        incomingInvite = nextInvite; inviteDismissed = false;
        if (!panel) ui?.querySelectorAll('.invite').forEach(node => node.remove());
      }
    }
    if (root && !root.isConnected && document.documentElement) document.documentElement.append(root);
    if (!active()) {
      if (panel) { root?.remove(); root = null; panel = null; lastPeople = ''; lastChat = ''; }
      const removal = view?.removal;
      const sameInvite = !incomingInvite || (incomingInvite.code === removal?.code && incomingInvite.relay === removal?.relayUrl);
      const showRemoval = view?.status === 'removed' && removal && removal.tabId === tabId && sameInvite && dismissedRemoval !== removal.id;
      if (!showRemoval) ui?.querySelector('.removed')?.remove();
      if (showRemoval) {
        mount();
        if (root && !ui.querySelector('.removed')) {
          ui.querySelector('.invite')?.remove();
          const box = el('section', view.error, ui, 'panel invite removed');
          button('Dismiss', box, () => { dismissedRemoval = removal.id; root.remove(); root = null; render(); });
        }
      } else showInvite();
      return;
    }
    buildPanel(); if (!panel) return;
    const unread = view.unreadCount || 0;
    unreadBadge.hidden = !unread;
    unreadBadge.textContent = unread > 99 ? '99+' : String(unread);
    const chatLabel = `${panel.hidden ? 'Open' : 'Close'} party chat${unread ? `, ${unread} unread message${unread === 1 ? '' : 's'}` : ''}`;
    chatToggle.setAttribute('aria-label', chatLabel); chatToggle.title = chatLabel;
    chatToggle.setAttribute('aria-expanded', String(!panel.hidden));
    const connected = view.status === 'connected';
    const count = view.room?.participants.filter(p => p.online).length || 0;
    statusLine.textContent = `${{ connected: 'Connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', error: 'Unable to join', removed: 'Removed' }[view.status] || 'Offline'} · ${count} / 2 watching${isHost() ? ' · You are the host' : ''}`;
    const different = view.room && P.mediaKey(view.room.mediaUrl) !== P.mediaKey(location.href);
    note.textContent = view.error || localError || playerError || (!player ? 'Waiting for a video player…' : different ? 'The host is watching a different video.' : autoplayBlocked ? 'Chrome needs a click to resume playback.' : buffering ? 'Your video is buffering…' : view.room?.playback?.buffering ? 'Waiting for the host to finish buffering…' : !view.room?.playback ? 'Waiting for the host’s playback…' : view.room.hostOnly ? 'Playback follows the host.' : 'Everyone can control playback.');
    if (controls.netflix && rateUnsupported && player && view.room?.playback && Math.abs(player.playbackRate - view.room.playback.rate) > 0.001) note.textContent += ' Choose the host’s playback speed in Netflix; automatic speed control is unavailable.';
    inviteButton.disabled = !connected || !view.room;
    retry.hidden = connected; follow.hidden = !different || isHost(); unlock.hidden = !autoplayBlocked;
    unlock.disabled = applying;
    hostSettings.hidden = !isHost(); hostOnly.checked = view.room?.hostOnly !== false; hostOnly.disabled = !connected;
    const roster = JSON.stringify([view.room?.participants, view.room?.hostId, connected]);
    if (roster !== lastPeople) {
      lastPeople = roster; people.replaceChildren();
      for (const member of view.room?.participants || []) {
        const row = el('div', '', people, 'person');
        el('span', `${member.name}${member.id === view.room.hostId ? ' · Host' : ''}${member.id === view.meId ? ' (you)' : ''}${!member.online ? ' · Reconnecting' : member.buffering ? ' · Buffering' : ''}${member.call ? ' · In call' : ''}`, row);
        if (isHost() && member.id !== view.meId) {
          const kick = button('Remove', row, () => request({ type: 'KICK', id: member.id }));
          kick.disabled = !connected;
        }
      }
    }
    const history = JSON.stringify([view.room?.messages, view.pending]);
    if (lastChat !== history) {
      lastChat = history;
      const stick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
      chat.replaceChildren();
      for (const message of [...(view.room?.messages || []), ...(view.pending || []).map(m => ({ ...m, pending: true }))]) {
        const line = el('div', '', chat, `line${message.pending ? ' pending' : ''}`);
        el('b', `${message.name}: `, line); line.append(document.createTextNode(message.text));
        if (message.pending) el('small', ' · Waiting for delivery', line);
      }
      if (stick) chat.scrollTop = chat.scrollHeight;
    }
    requestAnimationFrame(markChatRead);
  }
  function discoverPlayer() {
    const next = [...document.querySelectorAll('video')].sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0] || null;
    if (next === player) return;
    playerEvents?.abort(); player = next;
    buffering = false; autoplayBlocked = false; expectedSeek = null;
    lastSyncSeek = -Infinity; applying = false; controlEpoch++; rateUnsupported = false; playerError = '';
    if (!player) return;
    playerEvents = new AbortController();
    const on = (type, callback) => player.addEventListener(type, callback, { signal: playerEvents.signal });
    for (const type of ['play', 'pause', 'seeked', 'ratechange']) on(type, () => {
      if (type === 'seeked' && expectedSeek !== null && Math.abs(player.currentTime - expectedSeek) < 1) { expectedSeek = null; return; }
      if (performance.now() < suppressUntil || !active()) return;
      if (!canControl()) { applyState(true); return; }
      localActionAt = performance.now();
      publishPlayback(type);
    });
    on('waiting', () => { buffering = true; request({ type: 'PRESENCE', buffering }); if (isHost()) publishPlayback('buffering'); render(); });
    on('playing', () => {
      const wasBuffering = buffering; buffering = false; autoplayBlocked = false;
      request({ type: 'PRESENCE', buffering });
      if (isHost() && wasBuffering) publishPlayback('buffering');
      render();
    });
    on('canplay', () => { if (!isHost()) { buffering = false; request({ type: 'PRESENCE', buffering }); applyState(true); } });
    on('loadedmetadata', () => {
      applyState(true);
      if (isHost() && (!view.room?.playback || P.mediaKey(view.room.mediaUrl) !== P.mediaKey(location.href))) publishPlayback('media');
    });
    applyState(true);
  }
  function publishPlayback(reason) {
    if (!active() || !player || player.readyState < 1 || view.status !== 'connected' || !canControl()) return;
    if (reason === 'tick' && (!isHost() || performance.now() < suppressUntil)) return;
    lastPublish = Date.now();
    request({ type: 'PLAYBACK', reason, revision: view.room?.revision, mediaUrl: P.mediaUrl(location.href), playback: {
      time: player.currentTime, paused: player.paused, rate: reason !== 'ratechange' && correctionRate !== null && Math.abs(player.playbackRate - correctionRate) < 0.001 ? view.room.playback.rate : player.playbackRate, buffering,
    } });
  }
  function controlFailure(error) {
    if (error.code === 'AUTOPLAY' || error.name === 'NotAllowedError') autoplayBlocked = true;
    else if (controls.netflix && ['NOT_READY', 'STALE'].includes(error.code)) playerError = 'Waiting for Netflix’s player controls. Start the video in Netflix if needed.';
    else if (controls.netflix && error.code === 'UNSUPPORTED') playerError = 'Netflix’s player controls are unavailable. Reload the video to retry sync.';
    else playerError = 'This player could not apply sync. Reload the video and try again.';
  }
  async function applyState(force = false) {
    const p = view?.room?.playback;
    // Metadata alone does not mean the streaming player is ready for controls.
    if (applying || !active() || view.status !== 'connected' || !p || !player || player.readyState < 3 || player.seeking || player.error) return;
    if (P.mediaKey(view.room.mediaUrl) !== P.mediaKey(location.href)) return;
    if (!force && performance.now() - localActionAt < 1000) return;
    // The host's own echoes must not drive its player during startup or buffering.
    if (isHost() && p.actorId === view.meId) return;
    let target = P.position(p);
    if (Number.isFinite(player.duration)) target = Math.min(target, Math.max(0, player.duration - 0.05));
    const difference = target - player.currentTime;
    const paused = p.paused || p.buffering;
    const changes = {};
    const now = performance.now();
    if (Math.abs(difference) > (paused ? 0.2 : 1.2) && now - lastSyncSeek >= (controls.netflix ? 5000 : 3000)) {
      lastSyncSeek = now; expectedSeek = target; changes.time = target;
    }
    // Netflix gets discrete native seeks. Avoid repeatedly changing its speed
    // to correct small drift, and never write its HTML video element's rate.
    const rate = !controls.netflix && !isHost() && !paused && Math.abs(difference) > 0.2 && Math.abs(difference) <= 1.2 ? p.rate * (difference > 0 ? 1.03 : 0.97) : p.rate;
    correctionRate = rate === p.rate ? null : rate;
    if (!rateUnsupported && Math.abs(player.playbackRate - rate) > 0.001) changes.rate = rate;
    if (paused && !player.paused) changes.paused = true;
    else if (!paused && player.paused && !autoplayBlocked) changes.paused = false;
    if (changes.time !== undefined && !autoplayBlocked) changes.paused = paused;
    if (!Object.keys(changes).length) return;
    const controlledPlayer = player, epoch = controlEpoch;
    applying = true; suppressUntil = now + 1200;
    try {
      const result = await controls.apply(controlledPlayer, changes);
      if (epoch === controlEpoch && active()) {
        rateUnsupported = !result.rateSupported; playerError = '';
      }
    } catch (error) { if (epoch === controlEpoch && active()) controlFailure(error); }
    finally { if (epoch === controlEpoch) { applying = false; suppressUntil = performance.now() + 1200; render(); } }
  }
  function update(next) {
    const wasActive = active(); const previousHost = isHost();
    const partyKey = state => state?.party ? `${state.party.relayUrl}|${state.party.code}` : '';
    const previousParty = partyKey(view);
    view = next;
    if (previousParty !== partyKey(view)) {
      root?.remove(); root = null; panel = null; lastPeople = ''; lastChat = ''; localError = '';
      controlEpoch++; applying = false; playerError = ''; lastSyncSeek = -Infinity;
      inviteDismissed = false;
    }
    if (active()) {
      discoverPlayer(); render(); applyState();
      if (isHost() && (!view.room?.playback || !previousHost || !wasActive)) publishPlayback('initial');
    } else { playerEvents?.abort(); playerEvents = null; player = null; render(); }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'GET_PLAYER') {
      const video = document.querySelector('video');
      respond({ hasVideo: !!video, mediaUrl: P.mediaUrl(location.href) });
    }
    if (message.type === 'OPEN_PANEL') { setPanelOpen(true); respond({}); }
  });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.roomView) update(changes.roomView.newValue); });
  request({ type: 'GET_VIEW' }).then(initial => {
    if (!initial) return;
    tabId = initial.clientTabId ?? (initial.bound ? initial.tabId : null);
    update(initial);
  });
  // The chosen tab can become bound after a join. Ask once on each room change.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.party) request({ type: 'GET_VIEW' }).then(next => { if (next) { tabId = next.clientTabId ?? (next.bound ? next.tabId : tabId); update(next); } });
  });
  window.addEventListener('hashchange', render);
  window.addEventListener('focus', () => requestAnimationFrame(markChatRead));
  document.addEventListener('visibilitychange', () => requestAnimationFrame(markChatRead));
  document.addEventListener('fullscreenchange', () => { if (root) (document.fullscreenElement || document.documentElement).append(root); });
  setInterval(() => {
    if (!active()) { render(); return; }
    discoverPlayer();
    const currentMedia = P.mediaKey(location.href);
    if (lastMedia !== currentMedia) { lastMedia = currentMedia; if (isHost()) publishPlayback('media'); }
    applyState();
    if (Date.now() - lastPublish >= 5000) publishPlayback('tick');
    render();
  }, 1000);
})();
