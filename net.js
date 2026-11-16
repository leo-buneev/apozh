// Link between the TV (host) and phones through the АПОЖ server's WebSocket relay.

import qrcode from './vendor/qrcode.mjs';

// The static GitHub Pages copy has no server, so phones are unavailable there.
export const HAS_SERVER = location.protocol.startsWith('http') && !location.hostname.endsWith('github.io');

/** WebSocket that reconnects by itself and comes back quickly when a phone wakes up. */
export class Link {
  constructor({ onOpen, onMessage, onStatus } = {}) {
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.ws = null;
    this.retry = 0;
    this.timer = 0;
    this.status = 'connecting';
    const wake = () => { if (!this.isOpen()) this.reconnectNow(); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
    window.addEventListener('online', wake);
  }

  start() {
    this.connect();
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus?.(status);
  }

  connect() {
    clearTimeout(this.timer);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('online');
      this.onOpen?.();
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.onMessage?.(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.setStatus('offline');
      const delay = Math.min(8000, 400 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  reconnectNow() {
    const old = this.ws;
    this.ws = null;
    if (old) { old.onclose = null; try { old.close(); } catch {} }
    this.retry = 0;
    this.connect();
  }

  send(msg) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }
}

/**
 * TV side. Keeps the room code across reloads so phones stay connected, and tracks
 * which phone belongs to which player name.
 * onEvent(type, data): 'status' | 'phones' | 'message' ({ peerId, name, msg }) | 'hello' ({ peerId, name })
 */
export function createHost(onEvent) {
  const saved = JSON.parse(localStorage.getItem('apozh.room') || 'null');
  const state = { room: saved?.room ?? null, key: saved?.key ?? null, status: 'connecting' };
  const phones = new Map(); // peerId -> { name }
  let roster = { players: [], inGame: false };

  const link = new Link({
    onOpen: () => link.send({ t: 'host', room: state.room, key: state.key }),
    onStatus: (status) => {
      state.status = status;
      if (status !== 'online') { phones.clear(); onEvent('phones'); }
      onEvent('status');
    },
    onMessage: (m) => {
      if (m.t === 'room') {
        state.room = m.room;
        state.key = m.key;
        localStorage.setItem('apozh.room', JSON.stringify({ room: m.room, key: m.key }));
        phones.clear();
        for (const peerId of m.peers) phones.set(peerId, { name: null });
        // Phones that were already in the room re-introduce themselves on roster.
        link.send({ t: 'broadcast', msg: { t: 'roster', ...roster } });
        onEvent('status');
        onEvent('phones');
      } else if (m.t === 'peer-join') {
        phones.set(m.peerId, { name: null });
        sendTo(m.peerId, { t: 'roster', ...roster });
        onEvent('phones');
      } else if (m.t === 'peer-leave') {
        phones.delete(m.peerId);
        onEvent('phones');
      } else if (m.t === 'from-peer') {
        const phone = phones.get(m.peerId) ?? { name: null };
        phones.set(m.peerId, phone);
        if (m.msg?.t === 'hello') {
          // One phone per player: a newer phone for the same name replaces the older one.
          for (const [id, p] of phones) if (id !== m.peerId && p.name === m.msg.name) p.name = null;
          phone.name = String(m.msg.name || '').slice(0, 16) || null;
          onEvent('phones');
          onEvent('hello', { peerId: m.peerId, name: phone.name });
        } else {
          onEvent('message', { peerId: m.peerId, name: phone.name, msg: m.msg });
        }
      }
    },
  });

  function sendTo(peerId, msg) {
    return link.send({ t: 'to-peer', peerId, msg });
  }

  return {
    state,
    start: () => link.start(),
    joinUrl: () => (state.room ? `${location.origin}${location.pathname}#join=${state.room}` : null),
    sendTo,
    setRoster(players, inGame) {
      roster = { players, inGame };
      link.send({ t: 'broadcast', msg: { t: 'roster', ...roster } });
    },
    phoneOf(name) {
      for (const [id, p] of phones) if (p.name === name) return id;
      return null;
    },
    namedPhones() {
      return [...phones.values()].map((p) => p.name).filter(Boolean);
    },
    phoneCount: () => phones.size,
  };
}

export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
}

export function newPeerId() {
  let id = localStorage.getItem('apozh.peerId');
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('apozh.peerId', id);
  }
  return id;
}
