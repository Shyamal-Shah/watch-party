const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { createRelay } = require('../server');
const P = require('../shared');

test('two Chrome profiles: invite, late join, sync, controls, reconnect chat and removal', async () => {
  const relay = createRelay();
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const relayUrl = `ws://127.0.0.1:${relay.server.address().port}/`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-party-e2e-'));
  const extension = path.join(temp, 'extension'); await fs.mkdir(extension);
  const manifest = require('../manifest.json');
  // Pregrant the test relay; production still asks via Chrome's permission prompt.
  manifest.host_permissions = [...manifest.host_permissions, 'http://127.0.0.1/*'];
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  for (const file of ['shared.js', 'background.js', 'content.js', 'content.css', 'popup.html', 'popup.js', 'popup.css']) await fs.copyFile(path.join(__dirname, '..', file), path.join(extension, file));
  const video = await fs.readFile(path.join(__dirname, 'fixtures/video.webm'));
  const contexts = [];
  const errors = [];
  async function browser(profile) {
    const context = await chromium.launchPersistentContext(path.join(temp, profile), {
      headless: true, channel: 'chromium', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required'],
    });
    contexts.push(context);
    await context.route('https://www.netflix.com/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Watch Party test player</title><body style="background:#18131e;color:white"><h1>Test movie</h1><video controls muted style="width:640px;height:360px" src="data:video/webm;base64,${video.toString('base64')}"></video></body>` }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
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
    const videoPagePromise = guest.context.waitForEvent('page');
    await joinPage.getByRole('button', { name: 'Join', exact: true }).click();
    const guestVideo = await videoPagePromise; await guestVideo.waitForLoadState();
    // Tabs opened by the extension can start their first request before Playwright attaches.
    await guestVideo.goto('https://www.netflix.com/watch/123');
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
    // Reloading a player restores state rather than resetting the room.
    await guestVideo.reload();
    await expect.poll(() => guestVideo.locator('video').evaluate(v => v.currentTime)).toBeGreaterThan(29);
    // Replacing the video element on a single-page site also restores sync.
    await guestVideo.locator('video').evaluate(v => v.replaceWith(v.cloneNode(true)));
    await expect.poll(() => guestVideo.locator('video').evaluate(v => v.currentTime)).toBeGreaterThan(29);
    await hostVideo.goto('https://www.netflix.com/watch/456');
    await expect(guestVideo.getByRole('button', { name: 'Open host’s video' })).toBeVisible();
    await guestVideo.getByRole('button', { name: 'Open host’s video' }).click();
    await expect(guestVideo).toHaveURL('https://www.netflix.com/watch/456');
    await expect(guestVideo.locator('#wp-root .status')).toContainText('Connected');
    await hostVideo.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(guestVideo.locator('#wp-root .removed')).toContainText('removed you');
    expect(errors).toEqual([]);
    await hostVideo.screenshot({ path: 'test-results/host-party.png' });
  } finally {
    for (const context of contexts) await context.close();
    await relay.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
