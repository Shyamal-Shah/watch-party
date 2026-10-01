# Watch Party

A Manifest V3 Chrome extension for synchronized Netflix, Prime Video, and JioHotstar playback, with party codes and in-page chat. A small WebSocket relay lets people on different devices share playback and chat.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this project folder.
4. Open a supported streaming site and click the extension icon to create or join a party.

## Connect people on different devices

1. Deploy this project’s relay server on a host that provides a public HTTPS endpoint. The server needs Node.js 18 or later.
2. In the project folder, run `npm install` and `npm start`. The relay listens on port `8080`; `/health` is available for health checks.
3. In the extension popup, expand **Connect to a relay server**, enter the relay’s secure WebSocket URL (usually `wss://your-host/`), and save it. Chrome will ask permission to connect to that host.
4. Everyone in the party enters the same relay URL, then one person creates a party and shares the six character code. Others join using that code.

For local development, enter `ws://localhost:8080/`. A localhost URL only works for people using that same computer. Use the secure `wss://` address from your deployment for remote friends.

The relay forwards live chat and playback events and keeps no room history. Anyone who knows a room code can join it, so share codes with the intended group. Streaming sites can change their player implementation, which may affect video controls.
