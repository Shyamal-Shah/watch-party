(() => {
  if (window.__watchPartyLoaded) return;
  window.__watchPartyLoaded = true;
  let party = null;
  let root;
  let chat;
  let panel;
  let lastSync = 0;
  const roomKey = (code) => `wp-room-${code}`;
  const video = () => document.querySelector("video");
  const send = (playback) => chrome.runtime.sendMessage({ type: "PLAYBACK", code: party?.code, playback }).catch(() => {});
  const addLine = (author, text, system = false) => {
    if (!chat) return;
    const line = document.createElement("div");
    line.className = `wp-line${system ? " wp-system" : ""}`;
    if (!system) { const b = document.createElement("b"); b.textContent = `${author}:`; line.append(b); }
    line.append(document.createTextNode(text)); chat.append(line); chat.scrollTop = chat.scrollHeight;
  };
  async function refreshChat() {
    if (!party || !chat) return;
    const data = await chrome.storage.local.get(roomKey(party.code));
    chat.replaceChildren();
    for (const item of (data[roomKey(party.code)]?.messages || []).slice(-80)) addLine(item.name, item.text);
  }
  function mount() {
    if (!party || root) return;
    root = document.createElement("div"); root.id = "wp-root";
    panel = document.createElement("section"); panel.id = "wp-panel"; panel.className = "wp-hidden";
    const head = document.createElement("header"); head.className = "wp-head";
    const info = document.createElement("div");
    const title = document.createElement("div"); title.className = "wp-title"; title.textContent = "Watch Party";
    const room = document.createElement("div"); room.className = "wp-room"; room.textContent = `ROOM ${party.code}`;
    info.append(title, room);
    const close = document.createElement("button"); close.className = "wp-close"; close.textContent = "×"; close.setAttribute("aria-label", "Close party chat");
    close.onclick = () => panel.classList.add("wp-hidden"); head.append(info, close);
    const state = document.createElement("div"); state.className = "wp-state"; state.innerHTML = "● &nbsp;Party active <b>· synced playback on</b>";
    chat = document.createElement("div"); chat.className = "wp-chat";
    const compose = document.createElement("form"); compose.className = "wp-compose";
    const input = document.createElement("input"); input.placeholder = "Say something…"; input.maxLength = 240;
    const button = document.createElement("button"); button.textContent = "Send"; compose.append(input, button);
    compose.onsubmit = async (event) => {
      event.preventDefault(); const text = input.value.trim(); if (!text) return;
      const key = roomKey(party.code); const result = await chrome.storage.local.get(key);
      const messages = result[key]?.messages || [];
      messages.push({ name: party.name || "Guest", text, at: Date.now() });
      await chrome.storage.local.set({ [key]: { messages: messages.slice(-100) } }); input.value = "";
      chrome.runtime.sendMessage({ type: "CHAT", code: party.code, name: party.name || "Guest", text }).catch(() => {});
    };
    const foot = document.createElement("div"); foot.className = "wp-foot"; foot.textContent = "Playback and chat sync across tabs in this browser.";
    panel.append(head, state, chat, compose, foot);
    const toggle = document.createElement("button"); toggle.id = "wp-toggle"; toggle.textContent = "✦"; toggle.title = "Open Watch Party";
    toggle.onclick = () => panel.classList.toggle("wp-hidden");
    root.append(panel, toggle); document.documentElement.append(root); refreshChat();
  }
  function connectVideo() {
    const player = video(); if (!player || player.dataset.wpBound) return;
    player.dataset.wpBound = "1";
    for (const event of ["play", "pause", "seeked"]) player.addEventListener(event, () => {
      if (Date.now() - lastSync < 900) return;
      send({ action: event, time: player.currentTime, paused: player.paused, rate: player.playbackRate });
    });
  }
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "OPEN_PANEL" && panel) panel.classList.remove("wp-hidden");
    if (message.type === "SYNC_PLAYBACK" && party && message.code === party.code) {
      const player = video(); if (!player) return;
      const p = message.playback; lastSync = Date.now();
      if (Number.isFinite(p.time) && Math.abs(player.currentTime - p.time) > 1.5) player.currentTime = p.time;
      player.playbackRate = p.rate || 1;
      if (p.paused) player.pause(); else player.play().catch(() => {});
      setTimeout(() => { lastSync = 0; }, 1100);
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.party) { party = changes.party.newValue || null; if (!party) { root?.remove(); root = null; panel = null; chat = null; } else { mount(); refreshChat(); connectVideo(); } }
    if (party && changes[roomKey(party.code)]) refreshChat();
  });
  chrome.storage.local.get("party", (result) => { party = result.party || null; if (party) { mount(); connectVideo(); } });
  new MutationObserver(connectVideo).observe(document.documentElement, { childList: true, subtree: true });
})();
