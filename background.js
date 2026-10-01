chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "PLAYBACK") {
    chrome.tabs.query({}).then((tabs) => {
      for (const tab of tabs) {
        if (tab.id === sender.tab?.id || !tab.url) continue;
        if (/netflix\.com|primevideo\.com|amazon\.com\/gp\/video|jiohotstar\.com|hotstar\.com/.test(tab.url)) {
          chrome.tabs.sendMessage(tab.id, { type: "SYNC_PLAYBACK", code: message.code, playback: message.playback }).catch(() => {});
        }
      }
    });
  }
});
