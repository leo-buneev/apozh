// UI toolkit: DOM builder, screen switching, keyboard shortcuts and reusable widgets.

import * as audio from './audio.js';

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) node.style.setProperty(prop, v);
        else node.style[prop] = v;
      }
    }
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && (typeof value !== 'string' || key === 'value')) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ---------- Screens and keyboard ----------

const app = () => document.getElementById('app');
let keymap = new Map();
let cleanups = [];

// Registers cleanup work (timers, listeners) that runs when the screen changes.
export function onLeave(fn) {
  cleanups.push(fn);
}

// Builds a screen with `build()` and swaps it in. Building happens after the previous
// screen is torn down, so shortcuts and cleanups registered while building belong to the new one.
export function show(build) {
  audio.stop();
  for (const fn of cleanups.splice(0)) fn();
  keymap = new Map();
  closeModal();
  stopConfetti();
  const nodes = build();
  app().replaceChildren(el('div', { class: 'screen' }, nodes));
  window.scrollTo(0, 0);
}

// Codes are KeyboardEvent.code values, so shortcuts work with any keyboard layout.
export function bindKey(code, fn) {
  keymap.set(code, fn);
}

const KEY_LABELS = { Space: 'Пробел', Enter: 'Enter', Escape: 'Esc', Backspace: '⌫', ArrowLeft: '←', ArrowRight: '→' };

export function keyLabel(code) {
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

export function kbd(code) {
  return el('kbd', {}, keyLabel(code));
}

let modalKeymap = null;

document.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const target = e.target;
  const typing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
  if (typing && e.code !== 'Escape') return;
  const map = modalKeymap ?? keymap;
  const code = e.code === 'NumpadEnter' ? 'Enter' : e.code.replace(/^Numpad(\d)$/, 'Digit$1');
  const fn = map.get(code);
  if (!fn) return;
  e.preventDefault();
  fn();
});

/**
 * Big chunky button. `key` binds a shortcut and shows it on the button.
 * variant: primary | secondary | ghost | danger
 */
export function button(label, { onClick, key, variant = 'secondary', icon, disabled, cls = '', inModal = false } = {}) {
  const node = el('button', {
    class: `btn btn-${variant} ${cls}`,
    type: 'button',
    disabled,
    onclick: (e) => {
      e.currentTarget.blur();
      onClick?.(e);
    },
  },
  icon ? el('span', { class: 'btn-icon' }, icon) : null,
  el('span', { class: 'btn-label' }, label),
  key ? kbd(key) : null);
  if (key) {
    const handler = () => { if (!node.disabled && node.isConnected) node.click(); };
    if (inModal) modalKeymap?.set(key, handler);
    else bindKey(key, handler);
  }
  return node;
}

// ---------- Modal ----------

export function openModal(content, { onEscape } = {}) {
  modalKeymap = new Map();
  if (onEscape) modalKeymap.set('Escape', onEscape);
  const overlay = document.getElementById('overlay');
  const body = typeof content === 'function' ? content() : content;
  overlay.replaceChildren(el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === e.currentTarget) onEscape?.(); } },
    el('div', { class: 'modal' }, body)));
  overlay.classList.add('open');
}

export function isModalOpen() {
  return modalKeymap != null;
}

export function closeModal() {
  modalKeymap = null;
  const overlay = document.getElementById('overlay');
  overlay.classList.remove('open');
  overlay.replaceChildren();
}

// Buttons created inside a modal must register keys after openModal created the modal keymap,
// so modal content is passed as a function.
export function modalButton(label, opts) {
  return button(label, { ...opts, inModal: true });
}

// ---------- Players ----------

export const PLAYER_COLORS = ['#ff4f9a', '#ffd23f', '#3de0ff', '#8cff6b', '#b388ff', '#ff8a3d', '#4dffd2', '#ff6b6b', '#6b9bff', '#f5a3ff', '#c6ff3d', '#ffb3c7'];
export const PLAYER_EMOJIS = ['🦊', '🐸', '🐼', '🐙', '🦄', '🐯', '🐨', '🐧', '🦁', '🐵', '🐷', '🦉', '🐳', '🦖', '🐝', '🦩', '🐻', '🐰', '🦔', '🐌'];

export function avatar(player, size = 'md') {
  return el('span', { class: `avatar avatar-${size}`, style: { '--c': player.color } }, player.emoji);
}

export function playerTag(player, extra) {
  return el('span', { class: 'player-tag', style: { '--c': player.color } }, avatar(player, 'sm'), el('span', {}, player.name), extra);
}

// ---------- Waveform ----------

/**
 * Canvas waveform of an AudioBuffer. Highlights the played part while the buffer
 * with `tag` is playing.
 */
export function waveform(buffer, { tag, bars = 120, height = 110, cls = '' } = {}) {
  const canvas = el('canvas', { class: `wave ${cls}` });
  const values = audio.peaks(buffer, bars);
  let raf = 0;

  function draw() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round((rect.height || height) * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, w, h);
    const progress = tag ? audio.progressOf(tag) : null;
    const step = w / bars;
    const barW = Math.max(1, step * 0.62);
    const style = getComputedStyle(canvas);
    const on = style.getPropertyValue('--wave-on').trim() || '#ffd23f';
    const off = style.getPropertyValue('--wave-off').trim() || 'rgba(255,255,255,.35)';
    for (let i = 0; i < bars; i++) {
      const v = Math.max(0.04, Math.pow(values[i], 0.8));
      const bh = v * h * 0.92;
      const x = i * step + (step - barW) / 2;
      g.fillStyle = progress != null && i / bars <= progress ? on : off;
      roundRect(g, x, (h - bh) / 2, barW, bh, barW / 2);
    }
    if (progress != null) raf = requestAnimationFrame(draw);
    else raf = 0;
  }

  const unsubscribe = audio.onPlaybackChange(() => {
    if (!raf) raf = requestAnimationFrame(draw);
  });
  const ro = new ResizeObserver(() => draw());
  ro.observe(canvas);
  canvas.style.height = height / 16 + 'rem';
  onLeave(() => { unsubscribe(); ro.disconnect(); cancelAnimationFrame(raf); });
  return canvas;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, Math.min(r, h / 2));
  else g.rect(x, y, w, h);
  g.fill();
}

/** Play/stop toggle for a buffer, kept in sync with the global player. */
export function playButton(label, buffer, { tag, key, variant = 'secondary', onPlay, cls = '' } = {}) {
  const btn = button(label, {
    key, variant, cls: `btn-play ${cls}`, icon: '▶',
    onClick: () => {
      if (audio.playingTag() === tag) { audio.stop(); return; }
      if (audio.play(typeof buffer === 'function' ? buffer() : buffer, { tag })) onPlay?.();
    },
  });
  const icon = btn.querySelector('.btn-icon');
  const sync = () => {
    const playing = audio.playingTag() === tag;
    btn.classList.toggle('playing', playing);
    icon.textContent = playing ? '■' : '▶';
  };
  const unsubscribe = audio.onPlaybackChange(sync);
  onLeave(unsubscribe);
  return btn;
}

// ---------- Recorder widget ----------

/**
 * Big record button with a live level graph and a time ring.
 * onDone(buffer) gets the processed recording.
 */
export function recorder({ maxSeconds = 20, key = 'Space', onDone, idleText = 'Нажми и пой', hint } = {}) {
  const BARS_PER_SECOND = 10;
  const totalBars = maxSeconds * BARS_PER_SECOND;
  const levels = [];
  let session = null;
  let state = 'idle'; // idle | starting | recording

  const ringLen = 2 * Math.PI * 54;
  const ring = el('div', { class: 'rec-ring' });
  ring.innerHTML = `<svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="54"/><circle class="progress" cx="60" cy="60" r="54" stroke-dasharray="${ringLen}" stroke-dashoffset="${ringLen}"/></svg>`;
  const progressCircle = ring.querySelector('.progress');
  const face = el('span', { class: 'rec-face' }, '🎤');
  const recBtn = el('button', { class: 'rec-btn', type: 'button', onclick: (e) => { e.currentTarget.blur(); toggle(); } }, face);
  ring.append(recBtn);
  const time = el('div', { class: 'rec-time' }, `0,0 / ${maxSeconds} с`);
  const caption = el('div', { class: 'rec-caption' }, idleText, ' ', kbd(key));
  const canvas = el('canvas', { class: 'rec-levels' });
  const error = el('div', { class: 'error' });
  const root = el('div', { class: 'recorder' },
    el('div', { class: 'rec-main' }, ring, el('div', { class: 'rec-side' }, caption, time, canvas, hint ? el('div', { class: 'rec-hint' }, hint) : null)),
    error);
  bindKey(key, toggle);

  function drawLevels() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, w, h);
    const step = w / totalBars;
    const barW = Math.max(1, step * 0.6);
    for (let i = 0; i < totalBars; i++) {
      const v = i < levels.length ? Math.min(1, Math.pow(levels[i] * 1.6, 0.7)) : 0;
      const bh = Math.max(h * 0.05, v * h * 0.95);
      g.fillStyle = i < levels.length ? '#ff4f9a' : 'rgba(255,255,255,.15)';
      roundRect(g, i * step + (step - barW) / 2, (h - bh) / 2, barW, bh, barW / 2);
    }
  }
  requestAnimationFrame(drawLevels);

  async function toggle() {
    if (state === 'idle') begin();
    else if (state === 'recording') end();
  }

  async function begin() {
    state = 'starting';
    error.textContent = '';
    levels.length = 0;
    root.classList.add('starting');
    caption.replaceChildren('Включаю микрофон…');
    let bucket = 0;
    let bucketCount = 0;
    try {
      session = await audio.startRecording({
        onLevel: (peak, seconds) => {
          if (state !== 'recording') return;
          bucket = Math.max(bucket, peak);
          bucketCount++;
          // ~85 ms per block at 48 kHz; aim for BARS_PER_SECOND bars.
          while (levels.length < Math.floor(seconds * BARS_PER_SECOND)) { levels.push(bucket); bucket = 0; }
          time.textContent = `${seconds.toFixed(1).replace('.', ',')} / ${maxSeconds} с`;
          progressCircle.setAttribute('stroke-dashoffset', String(ringLen * (1 - Math.min(1, seconds / maxSeconds))));
          drawLevels();
          if (seconds >= maxSeconds) end();
        },
      });
    } catch (e) {
      state = 'idle';
      root.classList.remove('starting');
      caption.replaceChildren(idleText, ' ', kbd(key));
      error.textContent = audio.micErrorText(e);
      return;
    }
    if (!root.isConnected) { session.cancel(); return; }
    state = 'recording';
    root.classList.remove('starting');
    root.classList.add('recording');
    face.textContent = '■';
    caption.replaceChildren('Идёт запись! Стоп — ', kbd(key));
  }

  function end() {
    if (state !== 'recording') return;
    state = 'idle';
    root.classList.remove('recording');
    face.textContent = '🎤';
    progressCircle.setAttribute('stroke-dashoffset', String(ringLen));
    caption.replaceChildren(idleText, ' ', kbd(key));
    const buffer = session.finish();
    session = null;
    if (!buffer) {
      error.textContent = 'Почти ничего не записалось. Пой громче и ближе к микрофону, не меньше пары секунд.';
      return;
    }
    onDone?.(buffer);
  }

  onLeave(() => { session?.cancel(); session = null; state = 'idle'; });
  return root;
}

// ---------- Effects ----------

export function countdown(seconds, onDone) {
  const overlay = el('div', { class: 'countdown' });
  document.body.append(overlay);
  let n = seconds;
  let timer = 0;
  const finish = () => {
    clearTimeout(timer);
    overlay.remove();
  };
  const tick = () => {
    // Hold the count while the pause menu is open.
    if (isModalOpen()) { timer = setTimeout(tick, 250); return; }
    if (n === 0) {
      finish();
      audio.jingle('go');
      onDone();
      return;
    }
    audio.jingle('tick');
    overlay.replaceChildren(el('div', { class: 'countdown-num', key: n }, String(n)));
    n--;
    timer = setTimeout(tick, 800);
  };
  tick();
  onLeave(finish);
  return finish;
}

let confettiRaf = 0;

export function stopConfetti() {
  cancelAnimationFrame(confettiRaf);
  confettiRaf = 0;
  const canvas = document.getElementById('confetti');
  canvas?.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

export function confetti({ count = 180, duration = 4200 } = {}) {
  const canvas = document.getElementById('confetti');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  const g = canvas.getContext('2d');
  const colors = PLAYER_COLORS;
  const parts = Array.from({ length: count }, () => ({
    x: Math.random() * canvas.width,
    y: -Math.random() * canvas.height * 0.6,
    vx: (Math.random() - 0.5) * 4 * dpr,
    vy: (2 + Math.random() * 4) * dpr,
    size: (6 + Math.random() * 10) * dpr,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
    shape: Math.random() < 0.3 ? 'circle' : 'rect',
  }));
  const startedAt = performance.now();
  cancelAnimationFrame(confettiRaf);
  const frame = (now) => {
    const t = now - startedAt;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.globalAlpha = t > duration - 800 ? Math.max(0, (duration - t) / 800) : 1;
    for (const p of parts) {
      p.x += p.vx + Math.sin((t / 300) + p.rot) * dpr;
      p.y += p.vy;
      p.vy += 0.04 * dpr;
      p.rot += p.vr;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.fillStyle = p.color;
      if (p.shape === 'circle') { g.beginPath(); g.arc(0, 0, p.size / 2.5, 0, Math.PI * 2); g.fill(); }
      else g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      g.restore();
    }
    if (t < duration) confettiRaf = requestAnimationFrame(frame);
    else g.clearRect(0, 0, canvas.width, canvas.height);
  };
  confettiRaf = requestAnimationFrame(frame);
}

// The logo letters periodically swap places: АПОЖ ↔ ЖОПА.
export function logo(size = 'lg') {
  const letters = ['А', 'П', 'О', 'Ж'];
  const node = el('div', { class: `logo logo-${size}`, 'aria-label': 'АПОЖ', role: 'img' },
    letters.map((ch, i) => el('span', { class: 'logo-letter', style: { '--i': i } }, ch)));
  if (size === 'lg') {
    const timer = setInterval(() => {
      node.classList.add('flip');
      setTimeout(() => node.classList.remove('flip'), 1700);
    }, 7000);
    onLeave(() => clearInterval(timer));
  }
  return node;
}

export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
