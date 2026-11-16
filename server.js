// АПОЖ server: serves the static game and relays messages between the TV (host) and phones.
// Rooms live in memory. The server does not interpret game messages; it only routes them.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_FILES = new Set(['index.html', 'app.js', 'ui.js', 'audio.js', 'songs.js', 'youtube.js', 'net.js', 'phone.js', 'style.css', 'vendor/qrcode.mjs']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // a room survives a TV reload or a short outage
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024; // a 30 s recording is well under 2 MB
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// ---------- Static files ----------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
  if (path === '') path = 'index.html';
  if (!PUBLIC_FILES.has(path)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(500).end();
  }
});

// ---------- Rooms ----------

/** code -> { key, host: ws|null, peers: Map<peerId, ws>, touchedAt } */
const rooms = new Map();

function newCode() {
  for (;;) {
    const code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    if (!rooms.has(code)) return code;
  }
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastToPeers(room, msg) {
  for (const peer of room.peers.values()) send(peer, msg);
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  /** { role: 'host'|'peer', code, peerId? } once identified */
  let me = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'host') {
      // Resume the room if the TV still has its key, otherwise open a new one.
      let code = typeof msg.room === 'string' ? msg.room.toUpperCase() : '';
      let room = rooms.get(code);
      if (!room || room.key !== msg.key) {
        code = newCode();
        room = { key: randomBytes(12).toString('hex'), host: null, peers: new Map(), touchedAt: Date.now() };
        rooms.set(code, room);
      }
      if (room.host && room.host !== ws) room.host.close(4000, 'replaced');
      room.host = ws;
      room.touchedAt = Date.now();
      me = { role: 'host', code };
      send(ws, { t: 'room', room: code, key: room.key, peers: [...room.peers.keys()] });
      broadcastToPeers(room, { t: 'host-status', online: true });
      return;
    }

    if (msg.t === 'join') {
      const code = String(msg.room || '').toUpperCase();
      const peerId = String(msg.peerId || '').slice(0, 64);
      const room = rooms.get(code);
      if (!room || !peerId) {
        send(ws, { t: 'error', reason: 'no-room' });
        return;
      }
      const old = room.peers.get(peerId);
      if (old && old !== ws) old.close(4000, 'replaced');
      room.peers.set(peerId, ws);
      room.touchedAt = Date.now();
      me = { role: 'peer', code, peerId };
      send(ws, { t: 'joined', room: code, hostOnline: Boolean(room.host) });
      send(room.host, { t: 'peer-join', peerId });
      return;
    }

    if (!me) return;
    const room = rooms.get(me.code);
    if (!room) return;
    room.touchedAt = Date.now();

    if (me.role === 'peer' && msg.t === 'to-host') {
      send(room.host, { t: 'from-peer', peerId: me.peerId, msg: msg.msg });
    } else if (me.role === 'host' && msg.t === 'to-peer') {
      send(room.peers.get(msg.peerId), { t: 'from-host', msg: msg.msg });
    } else if (me.role === 'host' && msg.t === 'broadcast') {
      broadcastToPeers(room, { t: 'from-host', msg: msg.msg });
    }
  });

  ws.on('close', () => {
    if (!me) return;
    const room = rooms.get(me.code);
    if (!room) return;
    if (me.role === 'host' && room.host === ws) {
      room.host = null;
      broadcastToPeers(room, { t: 'host-status', online: false });
    } else if (me.role === 'peer' && room.peers.get(me.peerId) === ws) {
      room.peers.delete(me.peerId);
      send(room.host, { t: 'peer-leave', peerId: me.peerId });
    }
  });
});

// Keepalive: proxies drop idle sockets, and dead phones should leave their rooms.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.host && room.peers.size === 0 && now - room.touchedAt > ROOM_TTL_MS) rooms.delete(code);
  }
}, 25_000);

server.listen(PORT, () => console.log(`АПОЖ listening on :${PORT}`));
