const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createRelay } = require('../server');
const P = require('../extension/shared');

for (const hostOffers of [true, false]) test(`two Chrome profiles: sync and voice/video (${hostOffers ? 'host' : 'guest'} makes the offer)`, async () => {
  const relay = createRelay({ iceConfig: { iceServers: [], iceTransportPolicy: 'all' } });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const relayUrl = `ws://127.0.0.1:${relay.server.address().port}/`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-party-e2e-'));
  const extension = path.join(temp, 'extension'); await fs.mkdir(extension);
  const manifest = require('../extension/manifest.json');
  // Pregrant the test relay; production still asks via Chrome's permission prompt.
  manifest.host_permissions = [...manifest.host_permissions, 'http://127.0.0.1/*'];
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  for (const file of ['shared.js', 'background.js', 'content.js', 'content.css', 'popup.html', 'popup.js', 'popup.css', 'call.html', 'call.js', 'call.css']) await fs.copyFile(path.join(__dirname, '..', 'extension', file), path.join(extension, file));
  const video = await fs.readFile(path.join(__dirname, 'fixtures/video.webm'));
  const identities = ['0'.repeat(64), '1'.repeat(64)].map(value => {
    const secret = createHash('sha256').update(value + '|' + relayUrl).digest('hex');
    return { value, id: createHash('sha256').update(secret).digest('hex').slice(0, 24) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const contexts = [];
  const errors = [];
  async function browser(profile) {
    const context = await chromium.launchPersistentContext(path.join(temp, profile), {
      headless: true, channel: 'chromium', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    contexts.push(context);
    await context.route('https://www.netflix.com/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Watch Party test player</title><body style="background:#18131e;color:white"><h1>Test movie</h1><video controls muted style="width:640px;height:360px" src="data:video/webm;base64,${video.toString('base64')}"></video></body>` }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_VIEW' }));
    const identity = identities[(profile === 'host') === hostOffers ? 0 : 1].value;
    await worker.evaluate(value => { token = value; }, identity);
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    return { context, worker, popup, id };
  }
  try {
    const host = await browser('host');
    const hostVideo = await host.context.newPage(); await hostVideo.goto('https://www.netflix.com/watch/123');
    await hostVideo.waitForFunction(() => document.querySelector('video').readyState >= 2);
    await hostVideo.evaluate(() => { document.querySelector('video').currentTime = 17; });
    const tabId = await host.popup.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.netflix.com/watch/123' }))[0].id);
    const started = await host.popup.evaluate(args => chrome.runtime.sendMessage({ type: 'START_PARTY', create: true, code: 'ABC123', name: 'Host', mediaUrl: 'https://www.netflix.com/watch/123', ...args }), { tabId, relayUrl });
    expect(started.rpcError).toBeUndefined();
    await expect(hostVideo.locator('#wp-root .status')).toContainText('Connected');
    await expect.poll(() => relay.rooms.get('ABC123')?.playback?.time).toBeGreaterThan(16);
    const guest = await browser('guest');
    const invite = await guest.context.newPage();
    await invite.goto(P.invite('https://www.netflix.com/watch/123', 'ABC123', relayUrl));
    await expect(invite.getByText('You’re invited to Watch Party ABC123.')).toBeVisible();
    const joinPagePromise = guest.context.waitForEvent('page');
    await invite.getByRole('button', { name: 'Join party', exact: true }).click();
    const joinPage = await joinPagePromise; await joinPage.waitForLoadState();
    await expect(joinPage.locator('#relay-url')).toHaveValue(relayUrl);
    await joinPage.locator('#name').fill('Guest');
    await joinPage.getByRole('button', { name: 'Join', exact: true }).click();
    // Joining binds the original invite/player tab, preserving its loaded video.
    const guestVideo = invite;
    await expect(guestVideo.locator('#wp-root .status')).toContainText('Connected');
    await expect.poll(() => guestVideo.locator('video').evaluate(v => v.currentTime)).toBeGreaterThan(16);
    await expect(guestVideo.locator('#wp-root .people')).toContainText('Host');
    await expect(hostVideo.locator('#wp-root .people')).toContainText('Guest');
    // Guests cannot override a host-only room; local seeks return to its timeline.
    await guestVideo.locator('video').evaluate(v => { v.currentTime = 1; });
    await expect.poll(() => guestVideo.locator('video').evaluate(v => v.currentTime)).toBeGreaterThan(16);
    // Shared control is enforced by the relay, and can be changed by the host.
    await hostVideo.locator('#wp-root input[type=checkbox]').uncheck();
    await expect(guestVideo.locator('#wp-root .note')).toContainText('Everyone can control');
    await guestVideo.waitForTimeout(1500); // Allow the prior programmatic seek events to settle.
    await guestVideo.locator('video').evaluate(v => { v.currentTime = 30; });
    await expect.poll(() => relay.rooms.get('ABC123').playback.time).toBeGreaterThan(29);
    await expect.poll(() => hostVideo.locator('video').evaluate(v => v.currentTime)).toBeGreaterThan(29);
    await hostVideo.locator('#wp-root input[type=checkbox]').check();
    await hostVideo.waitForTimeout(1500);
    await hostVideo.locator('video').evaluate(v => v.play());
    await expect.poll(() => guestVideo.locator('video').evaluate(v => v.paused)).toBe(false);
    await expect.poll(async () => Math.abs((await hostVideo.locator('video').evaluate(v => v.currentTime)) - (await guestVideo.locator('video').evaluate(v => v.currentTime)))).toBeLessThan(1.5);
    // Guest buffering is visible; host buffering holds the shared timeline.
    await guestVideo.locator('video').evaluate(v => v.dispatchEvent(new Event('waiting')));
    await expect(hostVideo.locator('#wp-root .people')).toContainText('Buffering');
    await guestVideo.locator('video').evaluate(v => v.dispatchEvent(new Event('canplay')));
    await hostVideo.locator('video').evaluate(v => v.dispatchEvent(new Event('waiting')));
    await expect.poll(() => guestVideo.locator('video').evaluate(v => v.paused)).toBe(true);
    await hostVideo.locator('video').evaluate(v => v.dispatchEvent(new Event('playing')));
    await expect.poll(() => guestVideo.locator('video').evaluate(v => v.paused)).toBe(false);
    // Calls use real peer connections and fake devices in two separate Chrome profiles.
    const hostCallPromise = host.context.waitForEvent('page');
    await hostVideo.getByRole('button', { name: 'Voice / video call' }).click();
    const hostCall = await hostCallPromise;
    await hostCall.waitForLoadState();
    await hostCall.evaluate(() => {
      window.restoreMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Denied in test', 'NotAllowedError'));
    });
    await hostCall.getByRole('button', { name: 'Join voice call' }).click();
    await expect(hostCall.locator('#call-message')).toContainText('access was denied');
    expect(await hostCall.locator('#local-video').evaluate(v => v.srcObject)).toBeNull();
    await hostCall.evaluate(() => { navigator.mediaDevices.getUserMedia = window.restoreMedia; });
    await hostCall.getByRole('button', { name: 'Join voice call' }).click();
    await expect(hostCall.locator('#local-media')).toContainText('Microphone on');
    const guestCallPromise = guest.context.waitForEvent('page');
    await guestVideo.getByRole('button', { name: 'Voice / video call' }).click();
    let guestCall = await guestCallPromise;
    // A user can receive the call without granting device access.
    await guestCall.getByRole('button', { name: 'Listen only' }).click();
    await expect(hostCall.locator('#call-status')).toHaveText('Call connected', { timeout: 15000 });
    await expect(guestCall.locator('#call-status')).toHaveText('Call connected');
    await expect(guestCall.locator('#local-media')).toContainText('Microphone off');
    await expect.poll(() => guestCall.evaluate(async () => {
      const stats = await peer.pc.getStats();
      return [...stats.values()].filter(s => s.type === 'inbound-rtp' && s.kind === 'audio').reduce((sum, s) => sum + s.bytesReceived, 0);
    })).toBeGreaterThan(0);
    await guestCall.getByRole('button', { name: 'Turn mic on', exact: true }).click();
    await hostCall.getByRole('button', { name: 'Turn camera on', exact: true }).click();
    await guestCall.getByRole('button', { name: 'Turn camera on', exact: true }).click();
    await expect.poll(() => guestCall.locator('#remote-video').evaluate(v => v.videoWidth)).toBeGreaterThan(0);
    await expect.poll(() => hostCall.locator('#remote-video').evaluate(v => v.videoWidth)).toBeGreaterThan(0);
    await hostCall.getByRole('button', { name: 'Mute mic', exact: true }).click();
    await expect(guestCall.locator('#remote-media')).toContainText('Mic off');
    expect(await hostCall.locator('#local-video').evaluate(v => v.srcObject.getAudioTracks().length)).toBe(0);
    await guestCall.getByRole('button', { name: 'Mute speakers', exact: true }).click();
    expect(await guestCall.locator('#remote-video').evaluate(v => v.muted)).toBe(true);
    await hostCall.getByRole('button', { name: 'Turn camera off', exact: true }).click();
    await expect(guestCall.locator('#remote-placeholder')).toBeVisible();
    expect(await hostCall.locator('#local-video').evaluate(v => v.srcObject.getVideoTracks().length)).toBe(0);
    await guestCall.close();
    await expect.poll(() => [...relay.rooms.get('ABC123').members.values()].find(m => m.name === 'Guest').call).toBeNull();
    await expect(guestVideo.locator('#wp-root .status')).toContainText('Connected');
    const reopened = guest.context.waitForEvent('page');
    await guestVideo.getByRole('button', { name: 'Voice / video call' }).click();
    guestCall = await reopened;
    await guestCall.getByRole('button', { name: 'Join voice call' }).click();
    await expect(guestCall.locator('#call-status')).toHaveText('Call connected', { timeout: 15000 });
    // A dropped connection queues chat, then delivers it once after rejoining.
    let block = true;
    const refuse = socket => { if (block) socket.close(); };
    relay.wss.on('connection', refuse);
    const room = relay.rooms.get('ABC123');
    const member = [...room.members.values()].find(m => m.name === 'Guest');
    const guestId = member.id; member.socket.terminate();
    await expect(guestVideo.locator('#wp-root .status')).toContainText('Reconnecting');
    await guestVideo.locator('#wp-root input[type=text]').fill('Message during reconnect');
    await guestVideo.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(guestVideo.locator('#wp-root .pending')).toContainText('Waiting for delivery');
    block = false;
    await expect(guestVideo.locator('#wp-root .status')).toContainText('Connected', { timeout: 15_000 });
    await expect(guestVideo.locator('#wp-root .pending')).toHaveCount(0);
    await expect(hostVideo.locator('#wp-root .chat')).toContainText('Message during reconnect');
    expect(room.messages.filter(m => m.text === 'Message during reconnect')).toHaveLength(1);
    expect([...room.members.values()].find(m => m.name === 'Guest').id).toBe(guestId);
    relay.wss.off('connection', refuse);
    await expect(guestCall.locator('#call-status')).toHaveText('Call connected', { timeout: 15000 });
    await expect(hostCall.locator('#call-status')).toHaveText('Call connected');
    // Reloading a player restores state rather than resetting the room.
    await guestVideo.reload();
    await expect(guestCall.locator('#call-status')).toHaveText('Call connected');
    await expect.poll(() => guestVideo.locator('video').evaluate(v => v.currentTime)).toBeGreaterThan(29);
    // Replacing the video element on a single-page site also restores sync.
    await guestVideo.locator('video').evaluate(v => v.replaceWith(v.cloneNode(true)));
    await expect.poll(() => guestVideo.locator('video').evaluate(v => v.currentTime)).toBeGreaterThan(29);
    await hostVideo.goto('https://www.netflix.com/watch/456');
    // The guest follows the host's next title without clicking a follow button.
    await expect(guestVideo).toHaveURL('https://www.netflix.com/watch/456');
    await expect(guestVideo.locator('#wp-root .status')).toContainText('Connected');
    await hostVideo.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(guestVideo.locator('#wp-root .removed')).toContainText('removed you');
    await expect(guestCall.locator('#call-status')).toContainText('party ended');
    expect(await guestCall.locator('#local-video').evaluate(v => v.srcObject)).toBeNull();
    await hostCall.getByRole('button', { name: 'Leave call', exact: true }).click();
    expect(await hostCall.locator('#local-video').evaluate(v => v.srcObject)).toBeNull();
    await expect(hostVideo.locator('#wp-root .status')).toContainText('Connected');
    await hostCall.screenshot({ path: 'test-results/call-window.png' });
    expect(errors).toEqual([]);
    await hostVideo.screenshot({ path: 'test-results/host-party.png' });
  } finally {
    for (const context of contexts) await context.close();
    await relay.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
