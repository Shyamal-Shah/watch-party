const http = require("node:http");
const { WebSocketServer } = require("ws");

const port = Number(process.env.PORT || 8080);
const rooms = new Map();
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "watch-party-relay" }));
    return;
  }
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("Watch Party relay is running. Connect using WebSocket.");
});
const sockets = new WebSocketServer({ server, maxPayload: 8192 });

sockets.on("connection", (socket) => {
  let joinedRoom = null;
  socket.on("message", (raw) => {
    let packet;
    try { packet = JSON.parse(raw.toString()); } catch { return; }
    if (packet.type === "ping") {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: "pong" }));
      return;
    }
    const code = typeof packet.code === "string" ? packet.code.toUpperCase() : "";
    if (packet.type === "join") {
      if (!/^[A-Z0-9]{6}$/.test(code)) return socket.close(1008, "Invalid room code");
      if (joinedRoom) rooms.get(joinedRoom)?.delete(socket);
      joinedRoom = code;
      if (!rooms.has(code)) rooms.set(code, new Set());
      rooms.get(code).add(socket);
      socket.send(JSON.stringify({ type: "joined", code }));
      return;
    }
    if (!joinedRoom || code !== joinedRoom) return;
    let outgoing;
    if (packet.type === "chat") {
      if (typeof packet.text !== "string" || !packet.text.trim()) return;
      outgoing = { type: "chat", code, name: String(packet.name || "Guest").slice(0, 24), text: packet.text.trim().slice(0, 240), at: Date.now() };
    } else if (packet.type === "playback") {
      const value = packet.playback || {};
      if (!["play", "pause", "seeked"].includes(value.action) || !Number.isFinite(value.time)) return;
      outgoing = { type: "playback", code, playback: { action: value.action, time: Math.max(0, value.time), paused: Boolean(value.paused), rate: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(value.rate) ? value.rate : 1 } };
    } else return;
    const encoded = JSON.stringify(outgoing);
    for (const peer of rooms.get(code) || []) {
      if (peer !== socket && peer.readyState === 1) peer.send(encoded);
    }
  });
  socket.on("close", () => {
    if (!joinedRoom) return;
    const peers = rooms.get(joinedRoom);
    peers?.delete(socket);
    if (peers?.size === 0) rooms.delete(joinedRoom);
  });
});

server.listen(port, "0.0.0.0", () => console.log(`Watch Party relay listening on ${port}`));
