let relay = null;
let relayUrl = "";
let roomCode = "";
let reconnectTimer = null;
let outbox = [];

function connectRelay() {
  if (!relayUrl || !roomCode || relay?.readyState === WebSocket.OPEN || relay?.readyState === WebSocket.CONNECTING) return;
  try {
    relay = new WebSocket(relayUrl);
    relay.addEventListener("open", () => {
      relay.send(JSON.stringify({ type: "join", code: roomCode }));
      for (const packet of outbox.splice(0)) if (packet.code === roomCode) relay.send(JSON.stringify(packet));
    });
    relay.addEventListener("message", (event) => {
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (packet.code !== roomCode) return;
      if (packet.type === "playback") broadcastTabs({ type: "SYNC_PLAYBACK", code: roomCode, playback: packet.playback });
      if (packet.type === "chat" && typeof packet.name === "string" && typeof packet.text === "string") {
        const key = `wp-room-${roomCode}`;
        chrome.storage.local.get(key, (result) => {
          const messages = result[key]?.messages || [];
          messages.push({ name: packet.name.slice(0, 24), text: packet.text.slice(0, 240), at: packet.at || Date.now() });
          chrome.storage.local.set({ [key]: { messages: messages.slice(-100) } });
        });
      }
    });
    relay.addEventListener("close", () => {
      relay = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectRelay, 3000);
    });
    relay.addEventListener("error", () => relay?.close());
  } catch {
    relay = null;
  }
}

function broadcastTabs(message) {
  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (tab.url && /netflix\.com|primevideo\.com|amazon\.com\/gp\/video|jiohotstar\.com|hotstar\.com/.test(tab.url)) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }
  });
}

function sendRelay(packet) {
  if (relay?.readyState === WebSocket.OPEN) relay.send(JSON.stringify(packet));
  else if (relayUrl && packet.code === roomCode && packet.type === "chat") outbox.push(packet);
}

function loadPartySettings() {
  chrome.storage.local.get(["party", "relayUrl"], ({ party, relayUrl: savedUrl }) => {
    const nextCode = party?.code || "";
    const nextUrl = savedUrl || "";
    if (nextCode !== roomCode || nextUrl !== relayUrl) {
      relay?.close();
      relay = null;
      outbox = [];
      clearTimeout(reconnectTimer);
      roomCode = nextCode;
      relayUrl = nextUrl;
    }
    connectRelay();
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "PLAYBACK" && message.code) {
    broadcastTabs({ type: "SYNC_PLAYBACK", code: message.code, playback: message.playback });
    if (message.code === roomCode) sendRelay({ type: "playback", code: roomCode, playback: message.playback });
  }
  if (message.type === "CHAT" && message.code === roomCode) {
    sendRelay({ type: "chat", code: roomCode, name: message.name, text: message.text, at: Date.now() });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.party || changes.relayUrl)) loadPartySettings();
});
chrome.runtime.onStartup.addListener(loadPartySettings);
chrome.runtime.onInstalled.addListener(loadPartySettings);
chrome.alarms.create("relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "relay-keepalive") {
    if (relay?.readyState === WebSocket.OPEN) relay.send(JSON.stringify({ type: "ping" }));
    else loadPartySettings();
  }
});
loadPartySettings();
