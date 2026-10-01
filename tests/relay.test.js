const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createRelay } = require('../server');
const P = require('../shared');
const mediaUrl = 'https://www.netflix.com/watch/123';
const secret = () => randomBytes(32).toString('hex');

async function setup(t, options) {
  const relay = createRelay(options);
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.server.address().port}`;
  async function client(token = secret()) {
    const ws = new WebSocket(url);
    const messages = [];
    const waiters = new Set();
    ws.on('message', raw => {
      const packet = JSON.parse(raw.toString()); messages.push(packet);
      for (const check of waiters) check();
    });
    await once(ws, 'open');
    return { ws, token, messages,
      send: value => ws.send(JSON.stringify(value)),
      join: (code, create = false) => ws.send(JSON.stringify({ type: 'join', v: 2, code, token, create, name: create ? 'Host' : 'Guest', mediaUrl })),
      wait(predicate) {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { waiters.delete(check); reject(new Error('Timed out waiting for packet')); }, 2000);
          const check = () => {
            const i = messages.findIndex(predicate);
            if (i !== -1) { clearTimeout(timeout); waiters.delete(check); resolve(messages.splice(i, 1)[0]); }
          };
          waiters.add(check); check();
        });
      },
    };
  }
  return { client, relay, url };
}
const playback = (time, extra = {}) => ({ type: 'playback', reason: 'play', mediaUrl, playback: { time, paused: false, rate: 1, buffering: false, ...extra } });

test('late join receives playback, host identity, roster and prior chat', async t => {
  const { client } = await setup(t);
  const host = await client(); host.join('ABC123', true);
  const created = await host.wait(p => p.type === 'joined');
  host.send(playback(25));
  host.send({ type: 'chat', id: 'message-1', text: 'Welcome' });
  await host.wait(p => p.type === 'ack');
  const guest = await client(); guest.join('ABC123');
  const joined = await guest.wait(p => p.type === 'joined');
  assert.equal(joined.room.hostId, created.meId);
  assert.equal(joined.room.participants.length, 2);
  assert.equal(joined.room.messages[0].text, 'Welcome');
  assert.equal(joined.room.playback.time, 25);
  assert.ok(P.position(joined.room.playback, joined.serverTime) >= 25);
});

test('host-only enforcement, shared control, stale heartbeat protection, and buffering', async t => {
  const { client, relay } = await setup(t);
  const host = await client(); host.join('ABC123', true); await host.wait(p => p.type === 'joined');
  const guest = await client(); guest.join('ABC123'); await guest.wait(p => p.type === 'joined');
  host.send(playback(10)); await host.wait(p => p.room?.revision === 1);
  guest.send(playback(99)); await guest.wait(p => p.type === 'error' && /controlled/.test(p.message));
  assert.equal(relay.rooms.get('ABC123').playback.time, 10);
  guest.send({ type: 'settings', hostOnly: false }); await guest.wait(p => p.type === 'error' && /host/.test(p.message));
  host.send({ type: 'settings', hostOnly: false }); await guest.wait(p => p.room?.hostOnly === false);
  guest.send(playback(50, { paused: true })); await host.wait(p => p.room?.revision === 2);
  host.send({ ...playback(11), reason: 'tick', revision: 1 });
  host.send({ type: 'ping', clientTime: Date.now() }); await host.wait(p => p.type === 'pong');
  assert.equal(relay.rooms.get('ABC123').playback.time, 50);
  host.send(playback(52, { buffering: true }));
  const held = await guest.wait(p => p.room?.playback?.buffering);
  assert.equal(P.position(held.room.playback, Date.now() + 10000), 52);
});

test('chat retries are acknowledged without duplicates, room isolation is enforced', async t => {
  const { client, relay } = await setup(t);
  const host = await client(); host.join('ABC123', true); await host.wait(p => p.type === 'joined');
  const other = await client(); other.join('XYZ123', true); await other.wait(p => p.type === 'joined');
  host.send({ type: 'chat', id: 'same', text: 'Hello' }); await host.wait(p => p.type === 'ack');
  host.send({ type: 'chat', id: 'same', text: 'Hello' }); await host.wait(p => p.type === 'ack');
  assert.equal(relay.rooms.get('ABC123').messages.length, 1);
  assert.equal(relay.rooms.get('XYZ123').messages.length, 0);
});

test('host can remove a guest, and that identity cannot rejoin', async t => {
  const { client } = await setup(t);
  const host = await client(); host.join('ABC123', true); await host.wait(p => p.type === 'joined');
  const guest = await client(); guest.join('ABC123'); const joined = await guest.wait(p => p.type === 'joined');
  guest.send({ type: 'kick', id: joined.room.hostId }); await guest.wait(p => p.type === 'error');
  host.send({ type: 'kick', id: joined.meId }); await guest.wait(p => p.type === 'removed');
  const again = await client(guest.token); again.join('ABC123');
  const rejected = await again.wait(p => p.type === 'error');
  assert.equal(rejected.fatal, true); assert.match(rejected.message, /removed/);
});

test('reconnecting preserves identity and host, explicit leave transfers control', async t => {
  const { client } = await setup(t);
  const host = await client(); host.join('ABC123', true); const original = await host.wait(p => p.type === 'joined');
  const guest = await client(); guest.join('ABC123'); const joined = await guest.wait(p => p.type === 'joined');
  host.ws.close(); await once(host.ws, 'close');
  const back = await client(host.token); back.join('ABC123'); const restored = await back.wait(p => p.type === 'joined');
  assert.equal(restored.meId, original.meId); assert.equal(restored.room.hostId, original.meId);
  assert.equal(restored.room.participants.length, 2);
  back.send({ type: 'leave' });
  const transferred = await guest.wait(p => p.room?.hostId === joined.meId);
  assert.equal(transferred.room.participants.length, 1);
});

test('lost host transfers after grace, empty rooms expire, unknown joins fail', async t => {
  const { client, relay } = await setup(t, { hostGrace: 30, roomTtl: 50, sweepInterval: 10 });
  const absent = await client(); absent.join('ZZZ123'); assert.equal((await absent.wait(p => p.type === 'error')).fatal, true);
  const host = await client(); host.join('ABC123', true); await host.wait(p => p.type === 'joined');
  const guest = await client(); guest.join('ABC123'); const joined = await guest.wait(p => p.type === 'joined');
  host.ws.close(); await guest.wait(p => p.room?.hostId === joined.meId);
  guest.ws.close(); await once(guest.ws, 'close');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(relay.rooms.has('ABC123'), false);
});

test('create retries are idempotent for their host, unsupported URLs and malformed packets are rejected', async t => {
  const { client } = await setup(t);
  const host = await client(); host.join('ABC123', true); const first = await host.wait(p => p.type === 'joined');
  host.ws.close(); await once(host.ws, 'close');
  const back = await client(host.token); back.join('ABC123', true); assert.equal((await back.wait(p => p.type === 'joined')).room.hostId, first.meId);
  back.send(null); back.send({ type: 'ping', clientTime: 1 }); await back.wait(p => p.type === 'pong');
  const bad = await client(); bad.send({ type: 'join', v: 2, token: bad.token, code: 'BAD123', create: true, mediaUrl: 'https://evil.example' });
  assert.equal((await bad.wait(p => p.type === 'error')).fatal, true);
});

test('invite URLs round-trip server and title without accepting lookalike domains', () => {
  const link = P.invite(mediaUrl + '?track=1', 'ABC123', 'https://relay.example/ws');
  assert.deepEqual(P.parseInvite(link), { code: 'ABC123', mediaUrl: mediaUrl + '?track=1', relay: 'wss://relay.example/ws' });
  assert.equal(P.parseInvite(link.replace('www.netflix.com', 'www.netflix.com.evil.test')), null);
  assert.equal(P.parseInvite('javascript:alert(1)'), null);
  assert.equal(P.mediaUrl('https://www.amazon.com/orders'), null);
  assert.throws(() => P.relayUrl('wss://user:password@example.com'));
  assert.equal(P.position({ time: 10, paused: false, buffering: false, rate: 2, updatedAt: 1000 }, 2000), 12);
});

test('parties admit two people, reserve reconnecting slots, and free explicit departures', async t => {
  const { client, url } = await setup(t);
  const host = await client(); host.join('ABC123', true); await host.wait(p => p.type === 'joined');
  const guest = await client(); guest.join('ABC123'); await guest.wait(p => p.type === 'joined');
  const third = await client(); third.join('ABC123');
  assert.match((await third.wait(p => p.type === 'error')).message, /Only two/);
  guest.ws.close(); await once(guest.ws, 'close');
  third.join('ABC123'); assert.match((await third.wait(p => p.type === 'error')).message, /Only two/);
  const returned = await client(guest.token); returned.join('ABC123');
  const restored = await returned.wait(p => p.type === 'joined');
  assert.equal(restored.room.participants.length, 2);
  assert.equal(restored.room.capabilities.maxParticipants, 2);
  returned.send({ type: 'leave' }); await once(returned.ws, 'close');
  third.join('ABC123'); assert.equal((await third.wait(p => p.type === 'joined')).room.participants.length, 2);
  const health = await (await fetch(url.replace('ws:', 'http:') + '/health')).json();
  assert.equal(health.voiceVideo, true); assert.equal(health.maxParticipants, 2);
});

test('call signaling is opt-in, scoped to the room and session, and cleared on disconnect', async t => {
  const { client, relay } = await setup(t, { iceConfig: { iceServers: [], iceTransportPolicy: 'all' } });
  const host = await client(); host.join('ABC123', true); const a = await host.wait(p => p.type === 'joined');
  const guest = await client(); guest.join('ABC123'); const b = await guest.wait(p => p.type === 'joined');
  const outsider = await client(); outsider.join('XYZ123', true); const c = await outsider.wait(p => p.type === 'joined');
  const aSession = 'a'.repeat(32), bSession = 'b'.repeat(32), cSession = 'c'.repeat(32);
  const signal = { type: 'signal', session: aSession, peerSession: bSession, to: b.meId, data: { description: { type: 'offer', sdp: 'v=0' } } };
  host.send({ type: 'call-media', mic: true }); // Cannot opt in without a valid session.
  host.send({ type: 'ping', clientTime: 1 }); await host.wait(p => p.type === 'pong');
  assert.equal(relay.rooms.get('ABC123').members.get(a.meId).call, null);
  host.send(signal); // Not in a call yet.
  host.send({ type: 'call-ready', session: aSession, mic: true, camera: false });
  assert.deepEqual((await host.wait(p => p.type === 'call-config')).iceServers, []);
  guest.send({ type: 'call-ready', session: bSession, mic: false, camera: false });
  await guest.wait(p => p.type === 'call-config');
  assert.equal(guest.messages.filter(p => p.type === 'signal').length, 0);
  outsider.send({ type: 'call-ready', session: cSession }); await outsider.wait(p => p.type === 'call-config');
  host.send({ ...signal, to: c.meId, peerSession: cSession }); // Cannot signal across rooms.
  host.send({ ...signal, peerSession: 'stale-session-00000' });
  host.send({ ...signal, from: 'forged-sender' });
  const offer = await guest.wait(p => p.type === 'signal');
  assert.equal(offer.from, a.meId); assert.equal(offer.session, aSession);
  assert.equal(offer.peerSession, bSession);
  assert.equal(outsider.messages.filter(p => p.type === 'signal').length, 0);
  assert.equal(guest.messages.filter(p => p.type === 'signal').length, 0);
  assert.equal(relay.rooms.get('ABC123').messages.length, 0);
  host.send({ type: 'call-media', session: aSession, mic: false, camera: true });
  await guest.wait(p => p.room?.participants.some(m => m.id === a.meId && m.call?.camera));
  host.ws.close(); await once(host.ws, 'close');
  const offline = await guest.wait(p => p.room?.participants.some(m => m.id === a.meId && !m.online));
  assert.equal(offline.room.participants.find(m => m.id === a.meId).call, null);
  guest.send({ type: 'call-stop', session: bSession });
  await guest.wait(p => p.room?.participants.every(m => m.call === null));
});

test('TURN configuration validates URLs and requires TURN for relay-only calls', () => {
  const { readIceConfig } = require('../rtc-config');
  assert.throws(() => readIceConfig({ ICE_SERVERS: 'not json' }));
  assert.throws(() => readIceConfig({ ICE_SERVERS: '[{"urls":"https://example.com"}]' }));
  assert.throws(() => readIceConfig({ ICE_SERVERS: '[]', ICE_TRANSPORT_POLICY: 'relay' }));
  const config = readIceConfig({ ICE_SERVERS: '[{"urls":"turns:example.com:5349","username":"test","credential":"secret"}]', ICE_TRANSPORT_POLICY: 'relay' });
  assert.equal(config.iceTransportPolicy, 'relay');
  assert.equal(config.iceServers[0].username, 'test');
});
