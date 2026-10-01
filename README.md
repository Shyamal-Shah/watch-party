# Watch Party

A Manifest V3 Chrome extension prototype for synchronized Netflix, Prime Video, and JioHotstar playback, with a party code and in-page chat.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this project folder.
4. Open a supported streaming site and click the extension icon to create or join a party.

Playback and chat are shared between supported tabs using the same Chrome profile. The party code is not a network room: connecting different people or devices requires a hosted signaling and chat service. Streaming sites can also change their player implementation, which may affect video controls.
