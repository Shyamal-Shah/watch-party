# Watch Party

A Chrome extension for watching Netflix, Prime Video, and JioHotstar together, with a Node.js WebSocket relay for two people on different devices, plus optional voice and video calls.

## Install or update

1. Use Chrome 116 or later and open `chrome://extensions`.
2. Enable **Developer mode**, choose **Load unpacked**, and select this project's **extension/** folder (the folder containing `manifest.json`).
3. When updating, click **Reload** on the extension and refresh your streaming tabs.
4. Voice/video calls need a version 2.1 or later relay. This 2.2 extension update works with that relay without redeployment. Version 2 uses a new room protocol; create a new party after upgrading from version 1.

Each participant needs the extension and access to the same streaming title. The extension synchronizes each person's player; it does not transmit the movie.

**Moving from the old layout:** disable the copy loaded from the repository root, then use **Load unpacked** to load `extension/`. Start a new party after both people switch. A changed installation path may give the unpacked extension a new identity, so you may need to re-enter preferences and grant permissions again.

## Package and share

The `extension/` folder contains the complete Chrome extension. You can zip that folder directly, or build a release ZIP from the repository root:

```sh
npm run package:extension
```

The packaging command requires Python 3 available as `python3` and uses its standard library; no `npm install` is needed for packaging. Alternatively run `python3 scripts/package-extension.py` (on Windows, `py -3 scripts/package-extension.py`). It creates **`dist/watch-party-extension-v2.2.3.zip`**, with the version taken from `extension/manifest.json`. Generated archives are ignored by Git.

Send that ZIP to your friend. They extract it into a permanent folder, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the extracted folder containing `manifest.json`. This follows Chrome's [unpacked extension installation instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked). The ZIP includes `INSTALL.txt`; recipients do not need Node.js, Python, or the relay source. For updates, extract into the same folder, reload the extension, and refresh streaming tabs.

The relay source (`server.js`, `rtc-config.js`) and npm files stay at the repository root. `server.js` imports the shared protocol helpers from `extension/shared.js`, so deploy the repository with that folder included. Render's build and start commands remain `npm ci` and `npm start`.

## Run the relay

Use Node.js 20 or later.

```sh
npm ci
npm start
```

The relay listens on `0.0.0.0:8080`, or the port supplied by `PORT`. `/health` returns a JSON response. Use `ws://localhost:8080/` on the same computer. For friends on other computers, deploy the server behind HTTPS and use its public `wss://` URL. On Render, create a Node Web Service with build command `npm ci`, start command `npm start`, and health check path `/health`.

## Start and invite friends

1. Open a movie or episode on a supported site.
2. Open the extension. The default relay is already set to `wss://watch-party-i6o3.onrender.com/`. Allow Chrome access when prompted on starting or joining.
3. Enter your name and choose **Start a party**.
4. When connected, choose **Copy invite link** in the popup or player panel.
5. Friends open that link, choose **Join party** on the streaming page, enter a name on the Watch Party page, and click **Join**. The link fills in the room and relay URL automatically. Chrome may ask them to allow access to that server. After connecting, the extension returns to the original streaming tab and uses its existing player. Keep that tab open while entering your name; if it closes, reopen the invite to start again.

Version 2.2.2 fixes the invite flow creating a second streaming tab. If an older version opened a duplicate Netflix tab with a playback error, leave that party, close the duplicate, update/reload the extension, refresh the working streaming tab, and join again. This fixes the duplicate-tab flow; real Netflix playback still needs checking with a subscribed account.

You can also paste an invite link directly into the popup. Joining by a six character code still works when the same relay is configured. Only the chosen streaming tab participates; closing that tab leaves the party.

To use another relay, expand **Server settings**, enter its URL, and choose **Save**. Saved custom servers remain selected after updating. **Use default server** restores the shared server for your next party. Invite links use the server specified by the host. Local development still uses `ws://localhost:8080/`.

## Playback and room controls

- Late joiners receive the latest playback position, pause state, playback speed, participant list, and up to 100 recent chat messages.
- The host sends playback snapshots every five seconds. Followers check for drift each second and seek for larger differences. Prime Video and JioHotstar also gently adjust speed for small differences. Netflix uses discrete seeks through its player controls.
- Sync waits for playable data before changing the player, spaces seek corrections at least three seconds apart (five seconds on Netflix), and avoids overlapping automatic control requests. A host's own playback snapshots do not drive its player.
- Host buffering holds the shared timeline. Guest buffering is shown in the participant list; a recovered guest catches up to the current timeline.
- Reloaded and replaced video players resume synchronization when their metadata is available. If Chrome blocks autoplay, click **Resume sync** in the panel.
- When the host's player opens another title or episode at a new URL, the guest's party tab follows automatically and sync resumes once the new player loads. This also follows the streaming service's own next-episode autoplay. The extension does not click next-episode buttons or bypass sign-in, ads, or access restrictions. **Open host’s video** remains available as a manual retry; repeated room updates do not repeatedly navigate a guest who has been redirected to sign-in. Invite links point to the latest room title.
- **Only the host controls playback** is enabled by default. The host can uncheck it to let everyone play, pause, seek, and change speed. The relay enforces this setting.
- The participant list shows the host, reconnecting members, and buffering status. The host can remove another participant. That extension identity is blocked from rejoining the same room, but can join a new room with a different code. Removal notices apply to the original party tab; a fresh invite to another room remains joinable. Version 2.2.1 fixes stale removal notices hiding new invitations. After updating, reload the extension and refresh streaming tabs.
- If the host leaves, control moves to an online participant. After an unexpected host disconnect, the relay allows 45 seconds for reconnection before transferring control.

## Voice and video calls

1. Both people join the same watch party. A third person will see a room-full message.
2. Choose **Voice / video call** in the popup or player panel. A separate call window opens, so calls survive streaming-page reloads and episode changes.
3. Choose **Join voice call** and allow microphone access, or choose **Listen only** to receive your friend's media without granting device access.
4. Choose **Turn camera on** for video. Camera access is requested separately; cameras start off.
5. **Mute mic** and **Turn camera off** stop those capture tracks. **Mute speakers** silences incoming call audio. **Leave call** or closing the call window releases your devices while keeping the watch party active.

The call window shows local and remote previews, microphone/camera status, connection errors, and a reconnect button. Leaving the party or being removed also releases your camera and microphone. During a temporary relay outage, enabled local devices remain active while the call reconnects; their status stays visible in the call window.

### Devices and call quality

Expand **Microphone, camera & speakers** in the call window to choose devices. Choices are saved in this Chrome profile. Changing an active input replaces its track in the current call and releases the previous device; a failed switch keeps the previous track. Choosing an input while it is off does not start capture. If an input disconnects, choose an available device or **System default**, then turn it on again.

Chrome may hide device names or extra devices until you grant access. Speaker selection changes only incoming call audio; the movie keeps its own audio output. If speaker selection is unsupported, use your system sound settings. **Choose another speaker** appears when the browser supports an output permission picker. These controls use [enumerateDevices](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices) and [setSinkId](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId).

The call quality indicator samples [WebRTC statistics](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/getStats) every two seconds. It shows round-trip latency, recent received packet loss and jitter where available, and combined send/receive bitrate. **Fair** means latency above 250 ms, loss above 2%, or jitter above 30 ms; **Poor** means above 500 ms, 5%, or 50 ms respectively. **Good** means the available measurements are below those thresholds. This is a local network estimate, not a measurement of your friend's listening experience or the movie's streaming quality. Missing statistics and inactive media are shown explicitly.

Media uses a direct WebRTC connection when possible. The Node relay only forwards call setup messages between the two room members; it does not receive or record audio/video. Both people must opt into the call. An updated 2.1 relay is required; `/health` reports `"voiceVideo": true` and `"maxParticipants": 2`.

### Connecting across restrictive networks

By default, callers use Google's public STUN server (`stun:stun.l.google.com:19302`). Some network combinations require a TURN media relay. The Render WebSocket server does not provide TURN itself.

To enable TURN, set `ICE_SERVERS` in your relay hosting environment to a JSON array supplied by your TURN provider, for example:

```json
[
  { "urls": "stun:stun.l.google.com:19302" },
  {
    "urls": ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349?transport=tcp"],
    "username": "YOUR_TURN_USERNAME",
    "credential": "YOUR_TURN_CREDENTIAL"
  }
]
```

These are example hostnames and credentials: replace them with a working TURN service, keep the configuration in your hosting environment, and restart the relay. TURN credentials are supplied to participants who join calls, so use provider credentials with appropriate expiry and usage limits. `ICE_TRANSPORT_POLICY=relay` forces calls through TURN and requires a TURN entry; the default `all` tries direct connections too.

The call implementation follows the [WebRTC offer/answer model](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling) and requests devices through [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia). Internet calling still needs manual checks on separate networks with your chosen TURN service.

## Connection recovery

The popup and player panel show connecting, connected, reconnecting, and error states. Interrupted connections retry with increasing delays up to approximately 30 seconds. **Reconnect** retries immediately. A heartbeat every 20 seconds maintains the Chrome service worker connection and detects stale sockets.

Chat sent during a temporary outage appears as **Waiting for delivery**. Up to 50 pending messages are saved locally, retried on reconnection, and acknowledged by the relay to prevent duplicate delivery. Reconnecting participants recover their identity and the room's latest state. Playback controls are not queued during an outage; on reconnection the room's current timeline wins.

## Current limits

Rooms and chat history are held in relay memory. An empty room expires after 10 minutes, and a relay restart clears rooms. In that case, the extension shows an error and the host must create a new party. Rooms are limited to two participant identities, including temporarily reconnecting participants. Removal is tied to an extension identity, not an account; a person using another browser profile can join again if they know the invite.

Prime Video and JioHotstar use the site's HTML video element. Starting with version 2.2.3, Netflix seek, play, and pause use its internal page player through a Chrome MAIN-world content script, following the integration approach used in [asbplayer's Netflix controls](https://github.com/asbplayer/asbplayer/blob/master/extension/src/entrypoints/netflix-page.ts). Direct video-element seeks are a suspected cause of the M7375 error during party joining; the earlier tab fix alone did not change those controls. Netflix's interface is undocumented and can change. When it is unavailable, the panel reports that controls are not ready instead of attempting direct seeks. Netflix speed sync is available only if its player exposes native speed controls; otherwise match the host's speed using Netflix's own menu.

If Netflix already shows M7375, leave the party, update/reload the extension, reload the Netflix page so a fresh player starts, and rejoin. Changes to streaming players, ads, regional title differences, DRM behavior, and browser autoplay restrictions may affect synchronization. Real Netflix, Prime Video, and JioHotstar playback still needs manual checks with subscribed accounts.

## Development checks

```sh
npm test
npx playwright install chromium
npm run test:browser
```

The relay tests exercise actual WebSocket clients, permissions, reconnect identity, host transfer, message deduplication, room expiry, and invite validation. The browser tests load the extension in two separate Chromium profiles, with a generated WebM video on an intercepted streaming page. It covers invite joining, late sync, guest control enforcement, shared controls, reconnect chat, player reload/replacement, running playback, buffering, following a new title, and removal. They also use fake microphones/cameras with real WebRTC connections to verify received audio packets, video frames, both offer directions, listen-only mode, permission denial, device toggles, closing/reopening calls, reconnection, and device cleanup on removal. They do not access paid streaming content or real user devices.

The Netflix control tests verify native seek values in milliseconds, watch-session selection, play/pause, optional speed support, malformed/stale commands, and unavailable APIs without direct video-element fallbacks. Browser tests simulate Netflix's page player around a real video and check that joins reuse one streaming tab and synchronization actually calls the page player across Chrome's isolated/MAIN world boundary. This simulation does not reproduce Netflix's DRM player or establish that an error on a subscribed account has been resolved.
