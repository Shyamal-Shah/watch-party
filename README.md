# Watch Party

A Chrome extension for watching Netflix, Prime Video, and JioHotstar together, with a Node.js WebSocket relay for people on different devices.

## Install or update

1. Use Chrome 116 or later and open `chrome://extensions`.
2. Enable **Developer mode**, choose **Load unpacked**, and select this project folder.
3. When updating, click **Reload** on the extension and refresh your streaming tabs.
4. Deploy the updated relay too. Version 2 uses a new room protocol; create a new party after upgrading from version 1.

Each participant needs the extension and access to the same streaming title. The extension synchronizes each person's player; it does not transmit the movie.

## Run the relay

Use Node.js 20 or later.

```sh
npm ci
npm start
```

The relay listens on `0.0.0.0:8080`, or the port supplied by `PORT`. `/health` returns a JSON response. Use `ws://localhost:8080/` on the same computer. For friends on other computers, deploy the server behind HTTPS and use its public `wss://` URL. On Render, create a Node Web Service with build command `npm ci`, start command `npm start`, and health check path `/health`.

## Start and invite friends

1. Open a movie or episode on a supported site.
2. Open the extension, expand **Server settings**, and save the relay URL. Allow Chrome access to that server when prompted.
3. Enter your name and choose **Start a party**.
4. When connected, choose **Copy invite link** in the popup or player panel.
5. Friends open that link, choose **Join party** on the streaming page, enter a name, and click **Join**. The link fills in the room and relay URL automatically. Chrome may ask them to allow access to that server.

You can also paste an invite link directly into the popup. Joining by a six character code still works when the same relay is configured. Only the chosen streaming tab participates; closing that tab leaves the party.

## Playback and room controls

- Late joiners receive the latest playback position, pause state, playback speed, participant list, and up to 100 recent chat messages.
- The host sends playback snapshots every five seconds. Followers check for drift each second, gently adjust speed for small differences, and seek for larger differences.
- Host buffering holds the shared timeline. Guest buffering is shown in the participant list; a recovered guest catches up to the current timeline.
- Reloaded and replaced video players resume synchronization when their metadata is available. If Chrome blocks autoplay, click **Resume sync** in the panel.
- When the host opens another title or episode, guests see **Open host’s video**. Click it to follow. Invite links point to the latest room title.
- **Only the host controls playback** is enabled by default. The host can uncheck it to let everyone play, pause, seek, and change speed. The relay enforces this setting.
- The participant list shows the host, reconnecting members, and buffering status. The host can remove another participant. That extension identity is blocked from rejoining the same room.
- If the host leaves, control moves to an online participant. After an unexpected host disconnect, the relay allows 45 seconds for reconnection before transferring control.

## Connection recovery

The popup and player panel show connecting, connected, reconnecting, and error states. Interrupted connections retry with increasing delays up to approximately 30 seconds. **Reconnect** retries immediately. A heartbeat every 20 seconds maintains the Chrome service worker connection and detects stale sockets.

Chat sent during a temporary outage appears as **Waiting for delivery**. Up to 50 pending messages are saved locally, retried on reconnection, and acknowledged by the relay to prevent duplicate delivery. Reconnecting participants recover their identity and the room's latest state. Playback controls are not queued during an outage; on reconnection the room's current timeline wins.

## Current limits

Rooms and chat history are held in relay memory. An empty room expires after 10 minutes, and a relay restart clears rooms. In that case, the extension shows an error and the host must create a new party. Rooms are limited to 50 participant identities. Removal is tied to an extension identity, not an account; a person using another browser profile can join again if they know the invite.

Player control uses the site's HTML video element. Changes to streaming players, ads, regional title differences, DRM behavior, and browser autoplay restrictions may affect synchronization. Real Netflix, Prime Video, and JioHotstar playback still needs manual checks with subscribed accounts.

## Development checks

```sh
npm test
npx playwright install chromium
npm run test:browser
```

The relay tests exercise actual WebSocket clients, permissions, reconnect identity, host transfer, message deduplication, room expiry, and invite validation. The browser test loads the extension in two separate Chromium profiles, with a generated WebM video on an intercepted streaming page. It covers invite joining, late sync, guest control enforcement, shared controls, reconnect chat, player reload/replacement, running playback, buffering, following a new title, and removal. It does not access paid streaming content.
