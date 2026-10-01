const byId = (id) => document.getElementById(id);
const msg = (text) => { byId("message").textContent = text; };
const getParty = () => new Promise((resolve) => chrome.storage.local.get("party", (v) => resolve(v.party)));
function showParty(party) {
  byId("active").classList.toggle("hidden", !party);
  byId("start").classList.toggle("hidden", !!party);
  if (party) byId("room-code").textContent = party.code;
}
function createCode() { return Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[n % 32]).join(""); }
async function saveParty(code) {
  const name = byId("name").value.trim() || "Guest";
  const party = { code, name, joinedAt: Date.now() };
  await chrome.storage.local.set({ party });
  showParty(party);
  msg("");
}
getParty().then(showParty);
chrome.storage.local.get("relayUrl", ({ relayUrl }) => { if (relayUrl) byId("relay-url").value = relayUrl; });
byId("create").addEventListener("click", () => saveParty(createCode()));
byId("join").addEventListener("click", async () => {
  const code = byId("code").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return msg("Enter a 6 character party code.");
  await saveParty(code);
});
byId("copy").addEventListener("click", async () => {
  const party = await getParty();
  await navigator.clipboard.writeText(party.code);
  byId("copy").textContent = "Copied!";
  setTimeout(() => { byId("copy").textContent = "Copy"; }, 1200);
});
byId("leave").addEventListener("click", async () => { await chrome.storage.local.remove("party"); showParty(null); });
byId("open-party").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /netflix\.com|primevideo\.com|amazon\.com\/gp\/video|jiohotstar\.com|hotstar\.com/.test(tab.url)) {
    chrome.tabs.sendMessage(tab.id, { type: "OPEN_PANEL" }).catch(() => {});
    window.close();
  } else msg("Open Netflix, Prime Video, or JioHotstar first.");
});
byId("save-relay").addEventListener("click", async () => {
  const raw = byId("relay-url").value.trim();
  if (!raw) { await chrome.storage.local.remove("relayUrl"); msg("Relay removed. This party is local to this browser."); return; }
  let url;
  try { url = new URL(raw); } catch { return msg("Enter a valid ws:// or wss:// URL."); }
  if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol)) return msg("Use a ws:// or wss:// relay URL.");
  const origin = `${url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:"}//${url.host}/*`;
  const allowed = await chrome.permissions.request({ origins: [origin] });
  if (!allowed) return msg("Chrome needs permission to connect to this relay.");
  url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  await chrome.storage.local.set({ relayUrl: url.toString() });
  msg("Relay saved. Your party will connect automatically.");
});
