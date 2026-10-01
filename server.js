const http = require('node:http');
const { createHash } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const P = require('./shared');

function createRelay({ roomTtl = 10 * 60_000, hostGrace = 45_000, sweepInterval = 5_000 } = {}) {
  const rooms = new Map();
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: true, service: 'watch-party-relay', protocol: 2 }));
  });
  const wss = new WebSocketServer({ server, maxPayload: 16_384 });
  const send = (socket, packet) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(packet)); };
  function snapshot(room) {
    return {
      code: room.code, hostId: room.hostId, hostOnly: room.hostOnly, revision: room.revision,
      mediaUrl: room.mediaUrl, playback: room.playback, messages: room.messages,
      participants: [...room.members.values()].filter(m => !room.banned.has(m.id)).map(m => ({
        id: m.id, name: m.name, online: !!m.socket, buffering: m.buffering,
      })),
    };
  }
  function publish(room) {
    const packet = { type: 'room', room: snapshot(room), serverTime: Date.now() };
    for (const member of room.members.values()) send(member.socket, packet);
  }
  function electHost(room) {
    const host = room.members.get(room.hostId);
    if (host?.socket || (host && Date.now() - host.offlineAt < hostGrace)) return;
    const next = [...room.members.values()].find(m => m.socket);
    if (next && next.id !== room.hostId) { room.hostId = next.id; publish(room); }
  }
  function detach(socket, explicit = false) {
    const room = socket.room;
    const member = room?.members.get(socket.memberId);
    if (!member || member.socket !== socket) return;
    member.socket = null;
    member.offlineAt = explicit ? 0 : Date.now();
    member.buffering = false;
    room.touchedAt = Date.now();
    if (explicit) room.members.delete(member.id);
    socket.room = null;
    electHost(room);
    publish(room);
  }
  wss.on('connection', socket => {
    socket.lastSeen = Date.now();
    socket.windowStart = Date.now();
    socket.count = 0;
    const error = (message, fatal = false) => send(socket, { type: 'error', message, fatal });
    socket.on('error', () => {});
    socket.on('message', raw => {
      let packet;
      try { packet = JSON.parse(raw.toString()); } catch { return error('Invalid message.'); }
      if (!packet || typeof packet !== 'object') return;
      if (Date.now() - socket.windowStart > 10_000) { socket.count = 0; socket.windowStart = Date.now(); }
      if (++socket.count > 150) return socket.close(1008, 'Too many messages');
      socket.lastSeen = Date.now();
      if (packet.type === 'ping') return send(socket, { type: 'pong', clientTime: packet.clientTime, serverTime: Date.now() });
      if (packet.type === 'join') {
        if (socket.room) return error('Already joined.', true);
        if (packet.v !== 2 || !/^[A-Z0-9]{6}$/.test(packet.code) || !/^[a-f0-9]{64}$/.test(packet.token)) return error('Update your extension and use a valid room code.', true);
        const id = createHash('sha256').update(packet.token).digest('hex').slice(0, 24);
        let room = rooms.get(packet.code);
        if (packet.create) {
          if (room && room.hostId !== id) return error('This code is in use. Create another party.', true);
          const url = P.mediaUrl(packet.mediaUrl);
          if (!url) return error('Open a supported video to create a party.', true);
          room ||= { code: packet.code, hostId: id, hostOnly: true, revision: 0, mediaUrl: url,
            playback: null, members: new Map(), banned: new Set(), messages: [], seen: new Set(), touchedAt: Date.now() };
          rooms.set(room.code, room);
        }
        if (!room) return error('Room not found or expired. Ask the host to create a new party.', true);
        if (room.banned.has(id)) return error('You were removed from this party.', true);
        if (!room.members.has(id) && room.members.size >= 50) return error('This room is full (50 participants).', true);
        const previous = room.members.get(id);
        const member = { id, name: String(packet.name || 'Guest').trim().slice(0, 24) || 'Guest', socket, buffering: false, offlineAt: null };
        room.members.set(id, member);
        if (previous?.socket) previous.socket.close(4001, 'Connection replaced');
        socket.room = room;
        socket.memberId = id;
        room.touchedAt = Date.now();
        electHost(room);
        send(socket, { type: 'joined', meId: id, room: snapshot(room), serverTime: Date.now() });
        publish(room);
        return;
      }
      const room = socket.room;
      const member = room?.members.get(socket.memberId);
      if (!room || member?.socket !== socket) return error('Join a room first.');
      room.touchedAt = Date.now();
      if (packet.type === 'leave') { detach(socket, true); socket.close(1000); return; }
      if (packet.type === 'settings') {
        if (member.id !== room.hostId) return error('Only the host can change room controls.');
        if (typeof packet.hostOnly === 'boolean') room.hostOnly = packet.hostOnly;
        publish(room); return;
      }
      if (packet.type === 'kick') {
        if (member.id !== room.hostId || packet.id === room.hostId) return error('Only the host can remove other participants.');
        const target = room.members.get(packet.id);
        if (!target) return;
        room.banned.add(target.id);
        send(target.socket, { type: 'removed', message: 'The host removed you from this party.' });
        const targetSocket = target.socket;
        room.members.delete(target.id);
        targetSocket?.close(4003, 'Removed');
        publish(room); return;
      }
      if (packet.type === 'presence') {
        if (member.buffering !== Boolean(packet.buffering)) { member.buffering = Boolean(packet.buffering); publish(room); }
        return;
      }
      if (packet.type === 'chat') {
        if (typeof packet.id !== 'string' || packet.id.length > 80 || typeof packet.text !== 'string' || !packet.text.trim()) return;
        const key = `${member.id}:${packet.id}`;
        if (!room.seen.has(key)) {
          room.seen.add(key);
          if (room.seen.size > 1000) room.seen.delete(room.seen.values().next().value);
          room.messages.push({ id: packet.id, memberId: member.id, name: member.name, text: packet.text.trim().slice(0, 500), at: Date.now() });
          room.messages = room.messages.slice(-100);
          publish(room);
        }
        send(socket, { type: 'ack', id: packet.id }); return;
      }
      if (packet.type === 'playback') {
        const p = packet.playback;
        const host = member.id === room.hostId;
        if (room.hostOnly && !host) { error('Playback is controlled by the host.'); publish(room); return; }
        if (packet.reason === 'tick' && (!host || packet.revision !== room.revision)) return;
        if (!p || !Number.isFinite(p.time) || p.time < 0 || !Number.isFinite(p.rate) || p.rate < 0.25 || p.rate > 4 || typeof p.paused !== 'boolean') return;
        const url = P.mediaUrl(packet.mediaUrl);
        if (!url || (!host && P.mediaKey(url) !== P.mediaKey(room.mediaUrl))) return error('Open the host’s video before controlling playback.');
        if (host) room.mediaUrl = url;
        room.revision++;
        room.playback = { time: p.time, paused: p.paused, rate: p.rate, buffering: host && Boolean(p.buffering), updatedAt: Date.now(), actorId: member.id };
        publish(room);
      }
    });
    socket.on('close', () => detach(socket));
  });
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const socket of wss.clients) if (now - socket.lastSeen > 65_000) socket.terminate();
    for (const [code, room] of rooms) {
      electHost(room);
      let changed = false;
      for (const [id, member] of room.members) if (!member.socket && id !== room.hostId && now - member.offlineAt > hostGrace) { room.members.delete(id); changed = true; }
      if (changed) publish(room);
      if (![...room.members.values()].some(m => m.socket) && now - room.touchedAt > roomTtl) rooms.delete(code);
    }
  }, sweepInterval);
  sweep.unref();
  server.on('close', () => clearInterval(sweep));
  return { server, wss, rooms, close: async () => {
    clearInterval(sweep);
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
  } };
}
if (require.main === module) {
  createRelay().server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('Watch Party relay ready'));
}
module.exports = { createRelay };
