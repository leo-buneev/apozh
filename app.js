// АПОЖ: party game where a song is sung, reversed, imitated, reversed again and guessed.
// One computer drives the game; its screen is meant to be shown on a TV.

import * as audio from './audio.js';
import {
  el, show, button, playButton, waveform, recorder, avatar, playerTag, openModal, closeModal,
  modalButton, countdown, confetti, logo, plural, kbd, onLeave, parseSong, songCard, PLAYER_COLORS, PLAYER_EMOJIS,
} from './ui.js';
import { SONG_CATEGORIES } from './songs.js';
import { HAS_SERVER, createHost, qrSvg } from './net.js';

// A phone opens the same site with #join=CODE and becomes a remote microphone.
const JOIN_CODE = location.hash.match(/^#join=([A-Za-z]{4})$/)?.[1]?.toUpperCase() ?? null;

// ---------- Persistence ----------

const STORE_PREFIX = 'apozh.';

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); } catch {}
}

const settings = {
  players: load('players', null) ?? Array.from({ length: 4 }, (_, i) => ({ name: '', emoji: PLAYER_EMOJIS[i] })),
  categories: load('categories', null) ?? SONG_CATEGORIES.map((c) => c.id),
  circles: load('circles', 1),
  customSongs: load('customSongs', ''),
};

let rosterTimer = 0;

function saveSettings() {
  for (const [key, value] of Object.entries(settings)) save(key, value);
  clearTimeout(rosterTimer);
  rosterTimer = setTimeout(syncRoster, 300);
}

// ---------- Songs ----------

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10; // keeps guessers within the 1–8 digit shortcuts
const SINGER_MAX_SECONDS = 20;
const MIMIC_MAX_SECONDS = 30;


function customSongs() {
  return settings.customSongs.split('\n').map((s) => s.trim()).filter(Boolean);
}

function songPool() {
  const pool = [];
  for (const cat of SONG_CATEGORIES) {
    if (settings.categories.includes(cat.id)) pool.push(...cat.songs);
  }
  pool.push(...customSongs());
  return [...new Set(pool)];
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Songs not played recently come first; recently played ones go to the end, oldest first.
function buildDeck() {
  const pool = songPool();
  const used = load('used', []);
  const usedSet = new Set(used);
  const inPool = new Set(pool);
  return [...shuffle(pool.filter((s) => !usedSet.has(s))), ...used.filter((s) => inPool.has(s))];
}

function drawSong() {
  if (!game.deck.length) game.deck = buildDeck();
  const song = game.deck.shift();
  const used = load('used', []).filter((s) => s !== song);
  used.push(song);
  save('used', used.slice(-600));
  return song;
}

// ---------- Game state ----------

let game = null;

function startGame() {
  const players = settings.players
    .map((p, i) => ({ name: p.name.trim(), emoji: p.emoji, color: PLAYER_COLORS[i % PLAYER_COLORS.length] }))
    .filter((p) => p.name);
  const n = players.length;
  const order = shuffle([...players.keys()]);
  const plan = [];
  // Every circle each player sings once and repeats once; the mimic offset changes per circle.
  for (let c = 0; c < settings.circles; c++) {
    const offset = (c % (n - 1)) + 1;
    for (let i = 0; i < n; i++) plan.push({ singer: order[i], mimic: order[(i + offset) % n] });
  }
  game = { id: Date.now().toString(36), players, plan, index: 0, rounds: [], deck: buildDeck() };
  syncRoster();
  requestWakeLock();
  screenIntro();
}

function currentRound() {
  if (!game.rounds[game.index]) {
    game.rounds[game.index] = {
      ...game.plan[game.index],
      id: `${game.id}-${game.index}`,
      remote: null, useComputer: false,
      song: null, original: null, reversed: null, attempt: null, result: null,
      guessedBy: undefined, listens: 0,
    };
  }
  return game.rounds[game.index];
}

function guessers(round) {
  return [...game.players.keys()].filter((i) => i !== round.singer && i !== round.mimic);
}

function isGuessed(round) {
  return Number.isInteger(round.guessedBy);
}

function scores() {
  const result = game.players.map(() => 0);
  for (const r of game.rounds) {
    if (!r || !isGuessed(r)) continue;
    result[r.guessedBy]++;
    result[r.singer]++;
    result[r.mimic]++;
  }
  return result;
}

function finishedRounds() {
  return game.rounds.filter((r) => r && r.guessedBy !== undefined);
}

function nextRound() {
  game.index++;
  if (game.index >= game.plan.length) screenFinal();
  else screenIntro();
}

// ---------- Phones ----------

// Name of the screen on display; phone messages are only acted on where they make sense.
let screenName = '';
const phoneListeners = new Set();

// Subscribes the screen being built to phone events; unsubscribes when it is left.
function onPhones(fn) {
  phoneListeners.add(fn);
  onLeave(() => phoneListeners.delete(fn));
}

function notifyPhones(type, data) {
  for (const fn of [...phoneListeners]) fn(type, data);
}

const host = HAS_SERVER && !JOIN_CODE ? createHost(handleHostEvent) : null;

function handleHostEvent(type, data) {
  if (type === 'message') handlePhoneMessage(data);
  notifyPhones(type, data);
}

function rosterPlayers() {
  const list = game
    ? game.players
    : settings.players.map((p, i) => ({ name: p.name.trim(), emoji: p.emoji, color: PLAYER_COLORS[i % PLAYER_COLORS.length] })).filter((p) => p.name);
  return list.map(({ name, emoji, color }) => ({ name, emoji, color }));
}

function syncRoster() {
  host?.setRoster(rosterPlayers(), Boolean(game));
}

function singerPhone(round) {
  return host?.phoneOf(game.players[round.singer].name) ?? null;
}

function sendSing(round) {
  const peerId = singerPhone(round);
  if (!peerId) return false;
  if (!round.song) round.song = drawSong();
  if (round.remote?.peerId !== peerId) round.remote = { peerId, state: 'sent' };
  host.sendTo(peerId, { t: 'sing', round: round.id, song: round.song, maxSeconds: SINGER_MAX_SECONDS, mimic: game.players[round.mimic].name });
  return true;
}

function cancelRemote(round) {
  if (!round?.remote) return;
  host?.sendTo(round.remote.peerId, { t: 'cancel' });
  round.remote = null;
}

function handlePhoneMessage({ peerId, name, msg }) {
  if (msg?.t === 'add') {
    addPlayerFromPhone(String(msg.name || '').trim().slice(0, 16));
    return;
  }
  if (!game) return;
  const round = game.rounds[game.index];
  if (!round || msg.round !== round.id || game.players[round.singer].name !== name || screenName !== 'intro') return;
  if (msg.t === 'skip') {
    round.song = drawSong();
    sendSing(round);
  } else if (msg.t === 'status') {
    round.remote = { peerId, state: msg.state };
    notifyPhones('round-status');
  } else if (msg.t === 'audio') {
    audio.decodeBuffer(msg).then((buffer) => {
      if (!game || game.rounds[game.index] !== round || screenName !== 'intro') return;
      round.original = buffer;
      round.reversed = audio.reverse(buffer);
      round.attempt = round.result = null;
      round.remote = null;
      host.sendTo(peerId, { t: 'got', round: round.id });
      audio.jingle('win');
      screenMimic(round);
    }).catch(() => {});
  }
}

function addPlayerFromPhone(name) {
  if (!name || game) return;
  if (settings.players.some((p) => p.name.trim().toLowerCase() === name.toLowerCase())) return;
  let slot = settings.players.find((p) => !p.name.trim());
  if (!slot) {
    if (settings.players.length >= MAX_PLAYERS) return;
    const taken = new Set(settings.players.map((p) => p.emoji));
    slot = { name: '', emoji: PLAYER_EMOJIS.find((e) => !taken.has(e)) ?? '🙂' };
    settings.players.push(slot);
  }
  slot.name = name;
  saveSettings();
  syncRoster();
  notifyPhones('players');
}

function qrBox(url) {
  const box = el('div', { class: 'qr' });
  box.innerHTML = qrSvg(url);
  return box;
}

// ---------- Wake lock and unload guard ----------

let wakeLock = null;

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && game) requestWakeLock();
});

window.addEventListener('beforeunload', (e) => {
  if (game && game.rounds.some((r) => r?.original)) e.preventDefault();
});

// ---------- Shared pieces ----------

const STEPS = ['Песня', 'Повтор', 'Угадываем', 'Ответ'];

function topbar(step) {
  return el('header', { class: 'topbar' },
    logo('sm'),
    el('div', { class: 'topbar-round' }, 'Раунд ', el('b', {}, game.index + 1), ' из ', game.plan.length),
    el('ol', { class: 'steps' }, STEPS.map((s, i) => el('li', { class: i === step ? 'active' : i < step ? 'done' : '' }, s))),
    button('Меню', { key: 'Escape', variant: 'ghost', onClick: openMenu }));
}

function scoreboard({ highlight = [] } = {}) {
  const sc = scores();
  const order = [...game.players.keys()].sort((a, b) => sc[b] - sc[a]);
  return el('div', { class: 'scoreboard' },
    order.map((i) => el('div', { class: 'score-item' + (highlight.includes(i) ? ' bump' : ''), style: { '--c': game.players[i].color } },
      avatar(game.players[i], 'sm'),
      el('span', { class: 'score-name' }, game.players[i].name),
      el('b', { class: 'score-points' }, sc[i]),
      highlight.includes(i) ? el('span', { class: 'score-delta' }, '+1') : null)));
}

function openMenu() {
  openModal(() => [
    el('h2', {}, 'Пауза'),
    el('div', { class: 'modal-actions' },
      modalButton('Продолжить', { key: 'Escape', variant: 'primary', onClick: closeModal }),
      modalButton('Закончить игру и показать итоги', { key: 'KeyF', onClick: () => { closeModal(); screenFinal(); } }),
      modalButton('Выйти в главное меню', { key: 'KeyQ', variant: 'danger', onClick: () => { closeModal(); screenHome(); } })),
    el('p', { class: 'muted' }, 'При выходе в меню записи этой игры пропадут.'),
  ], { onEscape: closeModal });
}

// ---------- Screen: home / setup ----------

function screenHome() {
  screenName = 'home';
  if (game) cancelRemote(game.rounds[game.index]);
  game = null;
  syncRoster();
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;

  const error = el('div', { class: 'error' });
  const playersBox = el('div', { class: 'players-grid' });
  const playersCount = el('span', { class: 'count' });
  const roundsInfo = el('div', { class: 'rounds-info' });
  const catsBox = el('div', { class: 'chips' });

  function namedCount() {
    return settings.players.filter((p) => p.name.trim()).length;
  }

  function updateCounts() {
    const n = namedCount();
    playersCount.textContent = n ? `${n}` : '';
    const rounds = n * settings.circles;
    roundsInfo.textContent = n >= MIN_PLAYERS
      ? `${rounds} ${plural(rounds, 'раунд', 'раунда', 'раундов')} · примерно ${Math.round(rounds * 2.5)} мин`
      : `Нужно хотя бы ${MIN_PLAYERS} игрока`;
  }

  // 📱 next to players whose phone is connected; updated in place so typing is not interrupted.
  const badges = [];
  function updateBadges() {
    const names = new Set(host?.namedPhones() ?? []);
    badges.forEach((b, i) => { b.hidden = !names.has(settings.players[i]?.name.trim()); });
  }

  function renderPlayers(focusIndex) {
    badges.length = 0;
    playersBox.replaceChildren(...settings.players.map((p, i) => {
      const badge = el('span', { class: 'phone-badge', title: 'Телефон подключён' }, '📱');
      badges.push(badge);
      const input = el('input', {
        class: 'player-input', value: p.name, placeholder: `Игрок ${i + 1}`, maxLength: 16,
        oninput: (e) => { p.name = e.target.value; saveSettings(); updateCounts(); updateBadges(); },
        onkeydown: (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const inputs = playersBox.querySelectorAll('.player-input');
          if (i < inputs.length - 1) inputs[i + 1].focus();
          else if (p.name.trim()) addPlayer();
        },
      });
      return el('div', { class: 'player-row', style: { '--c': PLAYER_COLORS[i % PLAYER_COLORS.length] } },
        el('button', {
          class: 'avatar avatar-md avatar-btn', type: 'button', title: 'Сменить зверя',
          style: { '--c': PLAYER_COLORS[i % PLAYER_COLORS.length] },
          onclick: () => {
            const taken = new Set(settings.players.map((x) => x.emoji));
            const start = PLAYER_EMOJIS.indexOf(p.emoji);
            for (let k = 1; k <= PLAYER_EMOJIS.length; k++) {
              const next = PLAYER_EMOJIS[(start + k) % PLAYER_EMOJIS.length];
              if (!taken.has(next)) { p.emoji = next; break; }
            }
            saveSettings();
            renderPlayers();
          },
        }, p.emoji),
        input,
        badge,
        settings.players.length > MIN_PLAYERS
          ? el('button', { class: 'icon-btn', type: 'button', title: 'Убрать', onclick: () => { settings.players.splice(i, 1); saveSettings(); renderPlayers(); } }, '✕')
          : null);
    }));
    if (settings.players.length < MAX_PLAYERS) {
      playersBox.append(el('button', { class: 'add-player', type: 'button', onclick: () => addPlayer() }, '+ Добавить игрока'));
    }
    updateCounts();
    updateBadges();
    if (focusIndex != null) playersBox.querySelectorAll('.player-input')[focusIndex]?.focus();
  }

  function addPlayer() {
    if (settings.players.length >= MAX_PLAYERS) return;
    const taken = new Set(settings.players.map((p) => p.emoji));
    settings.players.push({ name: '', emoji: PLAYER_EMOJIS.find((e) => !taken.has(e)) ?? '🙂' });
    saveSettings();
    renderPlayers(settings.players.length - 1);
  }

  function renderCats() {
    catsBox.replaceChildren(...SONG_CATEGORIES.map((cat) => {
      const on = settings.categories.includes(cat.id);
      return el('button', {
        class: 'chip' + (on ? ' on' : ''), type: 'button',
        onclick: () => {
          settings.categories = on ? settings.categories.filter((c) => c !== cat.id) : [...settings.categories, cat.id];
          saveSettings();
          renderCats();
        },
      }, el('span', { class: 'chip-emoji' }, cat.emoji), cat.name, el('span', { class: 'chip-count' }, cat.songs.length));
    }));
  }

  const circlesBox = el('div', { class: 'segmented' });
  function renderCircles() {
    circlesBox.replaceChildren(...[1, 2, 3].map((n) => el('button', {
      class: settings.circles === n ? 'on' : '', type: 'button',
      onclick: () => { settings.circles = n; saveSettings(); renderCircles(); updateCounts(); },
    }, `${n} ${plural(n, 'круг', 'круга', 'кругов')}`)));
  }

  const customCount = el('span', { class: 'chip-count' });
  const updateCustomCount = () => { const n = customSongs().length; customCount.textContent = n || ''; };
  const textarea = el('textarea', {
    rows: 5, value: settings.customSongs,
    placeholder: 'По одной в строке: Исполнитель — Песня\nНапример: Бабушка Зина — Частушки про дачу',
    oninput: (e) => { settings.customSongs = e.target.value; saveSettings(); updateCustomCount(); },
  });
  updateCustomCount();

  function start() {
    const n = namedCount();
    if (n < MIN_PLAYERS) { error.textContent = `Впиши имена хотя бы ${MIN_PLAYERS} игроков.`; return; }
    if (!songPool().length) { error.textContent = 'Выбери хотя бы одну категорию песен или впиши свои.'; return; }
    audio.getContext(); // unlock audio inside the click
    startGame();
  }

  renderPlayers();
  renderCats();
  renderCircles();

  show(() => [el('div', { class: 'home' },
    el('section', { class: 'home-hero' },
      logo('lg'),
      el('div', { class: 'tagline' }, 'песни ', el('span', { class: 'mirror' }, 'задом наперёд')),
      el('ol', { class: 'rules' },
        el('li', {}, el('span', { class: 'rule-icon' }, '🤫'), el('div', {}, el('b', {}, 'Певец'), ' тайком получает песню и поёт её, пока все остальные за дверью.')),
        el('li', {}, el('span', { class: 'rule-icon' }, '🔄'), el('div', {}, 'Запись ', el('b', {}, 'переворачивается'), ' задом наперёд.')),
        el('li', {}, el('span', { class: 'rule-icon' }, '🦜'), el('div', {}, el('b', {}, 'Повторяющий'), ' слушает эту абракадабру и старательно её повторяет.')),
        el('li', {}, el('span', { class: 'rule-icon' }, '🤔'), el('div', {}, 'Его попытку снова переворачивают, и ', el('b', {}, 'все угадывают'), ' песню.'))),
      el('div', { class: 'scoring' }, '🏆 Угадавший первым получает ', el('b', {}, '+1'), '. Певец и повторяющий тоже получают по ', el('b', {}, '+1'), ', если песню угадали.'),
      host ? phonePanel() : null,
      button('Проверить микрофон', { key: 'KeyM', variant: 'ghost', icon: '🎙️', onClick: () => screenSandbox() })),
    el('section', { class: 'card setup' },
      el('h2', {}, 'Игроки ', playersCount),
      playersBox,
      el('h2', {}, 'Песни'),
      catsBox,
      el('details', { class: 'custom-songs', open: customSongs().length > 0 },
        el('summary', {}, 'Свои песни ', customCount),
        textarea),
      el('h2', {}, 'Длина игры'),
      el('div', { class: 'circles-row' }, circlesBox, roundsInfo),
      error,
      button('Играть!', { key: 'Enter', variant: 'primary', cls: 'btn-xl btn-start', onClick: start })))]);

  onPhones((type) => {
    if (type === 'players') renderPlayers();
    else if (type === 'phones') updateBadges();
  });
}

function phonePanel() {
  const box = el('div', { class: 'phone-panel' });
  const render = () => {
    const url = host.joinUrl();
    if (host.state.status !== 'online' || !url) {
      box.replaceChildren(el('div', { class: 'muted' }, '📱 Подключаемся к серверу для телефонов…'));
      return;
    }
    const names = host.namedPhones();
    box.replaceChildren(
      qrBox(url),
      el('div', { class: 'phone-text' },
        el('b', {}, '📱 Пой с телефона'),
        el('div', { class: 'muted' }, 'Наведи камеру и выбери себя. Когда придёт твоя очередь, песня появится на телефоне, и можно спеть в другой комнате.'),
        el('div', { class: 'phone-code' }, 'Код игры ', el('b', {}, host.state.room)),
        names.length ? el('div', { class: 'phone-list' }, names.map((n) => el('span', { class: 'phone-chip' }, '📱 ', n))) : null));
  };
  render();
  onPhones((type) => { if (type === 'status' || type === 'phones') render(); });
  return box;
}

// ---------- Screen: microphone check ----------

function screenSandbox(buffer = null) {
  screenName = 'sandbox';
  const reversed = buffer && audio.reverse(buffer);
  show(() => [el('div', { class: 'sandbox' },
    el('header', { class: 'topbar' },
      logo('sm'),
      el('div', { class: 'topbar-round' }, 'Проверка микрофона'),
      el('div', { class: 'spacer' }),
      button('Назад', { key: 'Escape', variant: 'ghost', onClick: screenHome })),
    el('div', { class: 'stage' },
      el('h1', { class: 'title' }, 'Скажи что-нибудь 🎙️'),
      el('p', { class: 'subtitle' }, 'Например, «Я ем суп»: задом наперёд получится загадочное «пус мэ я».'),
      recorder({ maxSeconds: SINGER_MAX_SECONDS, onDone: (b) => screenSandbox(b) }),
      buffer
        ? el('div', { class: 'card compare' },
          el('div', { class: 'compare-item' }, waveform(buffer, { tag: 'sb-fwd', height: 90 }),
            playButton('Как есть', buffer, { tag: 'sb-fwd', key: 'KeyP' })),
          el('div', { class: 'compare-item' }, waveform(reversed, { tag: 'sb-rev', height: 90, cls: 'wave-alt' }),
            playButton('Задом наперёд', reversed, { tag: 'sb-rev', key: 'KeyB', variant: 'primary' })))
        : null))]);
}

// ---------- Screen: round intro ----------

function screenIntro() {
  screenName = 'intro';
  const round = currentRound();
  const singer = game.players[round.singer];
  const mimic = game.players[round.mimic];
  const peerId = singerPhone(round);
  const remote = Boolean(peerId) && !round.useComputer;
  if (remote) sendSing(round);
  const status = el('div', { class: 'remote-status' });
  const updateStatus = () => {
    const STATES = {
      sent: ['📨', 'Отправили песню на телефон…'],
      seen: ['👀', `${singer.name} смотрит на песню`],
      recording: ['🎤', `${singer.name} поёт!`],
      recorded: ['🎧', `${singer.name} слушает, что получилось`],
      sending: ['🚀', 'Запись летит на телевизор…'],
    };
    const [icon, text] = STATES[round.remote?.state] ?? STATES.sent;
    status.className = `remote-status state-${round.remote?.state ?? 'sent'}`;
    status.replaceChildren(el('span', { class: 'remote-icon' }, icon), text);
  };
  updateStatus();

  const useComputer = () => { round.useComputer = true; cancelRemote(round); screenIntro(); };
  const usePhone = () => { round.useComputer = false; screenIntro(); };

  show(() => [
    topbar(0),
    el('div', { class: 'stage intro' },
      el('div', { class: 'round-big' }, 'Раунд ', game.index + 1),
      el('div', { class: 'duo' },
        roleCard(singer, '🎤', 'Поёт'),
        el('div', { class: 'duo-arrow' }, '🔄'),
        roleCard(mimic, '🦜', 'Повторяет')),
      el('div', { class: 'guessers' }, el('span', { class: 'muted' }, 'Угадывают: '), guessers(round).map((i) => playerTag(game.players[i]))),
      remote
        ? [el('div', { class: 'banner banner-phone' },
          el('span', { class: 'banner-icon' }, '📱'),
          el('div', {}, 'Песня уже на телефоне у ', el('b', { style: { color: singer.color } }, singer.name),
            '. Уходи туда, где тебя не слышно, и пой! Остальные ждут здесь.')),
        status,
        button('Спеть на компьютере', { key: 'KeyK', variant: 'ghost', icon: '💻', onClick: useComputer })]
        : [el('div', { class: 'intro-local' },
          el('div', { class: 'banner' },
            el('span', { class: 'banner-icon' }, '🚪'),
            el('div', {}, 'Все, кроме ', el('b', { style: { color: singer.color } }, singer.name), ', выходят из комнаты. ', singer.name, ', садись к компьютеру!')),
          host?.joinUrl() && !peerId
            ? el('div', { class: 'intro-qr' }, qrBox(host.joinUrl()), el('div', {}, el('b', {}, 'Или спой с телефона'), el('div', { class: 'muted' }, `${singer.name}, отсканируй и выбери себя`)))
            : null),
        el('div', { class: 'row center' },
          button('Все вышли, показать песню', { key: 'Enter', variant: 'primary', cls: 'btn-xl', onClick: () => screenSinger(round) }),
          peerId ? button('Вернуть на телефон', { key: 'KeyK', variant: 'ghost', icon: '📱', onClick: usePhone }) : null)]),
    el('footer', { class: 'bottom' }, scoreboard())]);
  // Registered after show(): listeners belong to this screen and are dropped when it is left.
  onPhones((type, data) => {
    if (type === 'round-status') updateStatus();
    else if (type === 'phones' && singerPhone(round) !== peerId) screenIntro();
    else if (type === 'hello' && data.name === singer.name) screenIntro();
  });
}

function roleCard(player, icon, role) {
  return el('div', { class: 'role-card', style: { '--c': player.color } },
    el('div', { class: 'role-label' }, icon, ' ', role),
    avatar(player, 'xl'),
    el('div', { class: 'role-name' }, player.name));
}

// ---------- Screen: singer ----------

function screenSinger(round) {
  screenName = 'singer';
  cancelRemote(round);
  if (!round.song) round.song = drawSong();
  const singer = game.players[round.singer];
  const mimic = game.players[round.mimic];

  const changeSong = () => {
    round.song = drawSong();
    round.original = round.reversed = null;
    screenSinger(round);
  };

  show(() => [
    topbar(0),
    el('div', { class: 'stage singer' },
      el('div', { class: 'secret-label', style: { '--c': singer.color } }, '🤫 Секретно, только для ', avatar(singer, 'sm'), ' ', singer.name),
      el('div', { class: 'singer-layout' },
        el('div', { class: 'singer-song' },
          songCard(round.song, { cls: 'pop-in' }),
          button('Не знаю эту, другую', { key: 'KeyS', variant: 'ghost', icon: '🎲', onClick: changeSong })),
        el('div', { class: 'singer-rec' },
          recorder({
            maxSeconds: SINGER_MAX_SECONDS,
            idleText: round.original ? 'Перепеть' : 'Нажми и пой',
            hint: '10–15 секунд самого узнаваемого места, лучше припев. Со словами, громко и с душой!',
            onDone: (buffer) => {
              round.original = buffer;
              round.reversed = audio.reverse(buffer);
              round.attempt = round.result = null;
              screenSinger(round);
            },
          }),
          round.original
            ? el('div', { class: 'card recorded pop-in' },
              waveform(round.original, { tag: 'orig', height: 80 }),
              el('div', { class: 'row' },
                playButton('Послушать себя', round.original, { tag: 'orig', key: 'KeyP' }),
                button(`Готово, зовите всех!`, { key: 'Enter', variant: 'primary', icon: '📣', onClick: () => screenMimic(round) })))
            : null))),
    el('footer', { class: 'bottom' }, el('div', { class: 'hint-bottom' }, '👉 Повторять будет ', playerTag(mimic), '. Песню не показываем никому!'))]);
}

// ---------- Screen: mimic ----------

function screenMimic(round) {
  screenName = 'mimic';
  const singer = game.players[round.singer];
  const mimic = game.players[round.mimic];
  const listens = el('span', { class: 'listens' }, listensText(round.listens));

  show(() => [
    topbar(1),
    el('div', { class: 'stage mimic' },
      el('h1', { class: 'title' }, avatar(mimic, 'lg'), el('span', {}, el('span', { style: { color: mimic.color } }, mimic.name), ', твой выход!')),
      el('p', { class: 'subtitle' }, 'Зовите всех обратно. ', singer.name, ', ни слова о песне! 🤐'),
      el('div', { class: 'mimic-layout' },
        el('div', { class: 'card step-card' },
          el('div', { class: 'step-num' }, '1'),
          el('h3', {}, 'Слушай абракадабру'),
          waveform(round.reversed, { tag: 'rev', height: 100, cls: 'wave-alt' }),
          el('div', { class: 'row' },
            playButton('Слушать', round.reversed, {
              tag: 'rev', key: 'KeyP', variant: round.attempt ? 'secondary' : 'primary',
              onPlay: () => { round.listens++; listens.textContent = listensText(round.listens); },
            }),
            listens)),
        el('div', { class: 'card step-card' },
          el('div', { class: 'step-num' }, '2'),
          el('h3', {}, 'Повтори как можно точнее'),
          recorder({
            maxSeconds: MIMIC_MAX_SECONDS,
            idleText: round.attempt ? 'Записать заново' : 'Записать повтор',
            hint: 'Звуки, мелодию, интонацию. Слушать можно сколько угодно раз.',
            onDone: (buffer) => {
              round.attempt = buffer;
              round.result = audio.reverse(buffer);
              screenMimic(round);
            },
          }),
          round.attempt
            ? el('div', { class: 'row pop-in' },
              playButton('Твоя попытка', round.attempt, { tag: 'attempt', key: 'KeyA' }),
              button('Переворачиваем!', { key: 'Enter', variant: 'primary', icon: '🔄', onClick: () => screenGuess(round, true) }))
            : null)))]);
}

function listensText(n) {
  return n ? `Прослушано ${n} ${plural(n, 'раз', 'раза', 'раз')}` : '';
}

// ---------- Screen: guessing ----------

function screenGuess(round, autoplay) {
  screenName = 'guess';
  const singer = game.players[round.singer];
  const list = guessers(round);
  const choose = (i) => { round.guessedBy = i; screenReveal(round, true); };

  show(() => [
    topbar(2),
    el('div', { class: 'stage guess' },
      el('h1', { class: 'title title-xl wobble' }, 'Что это за песня? 🤔'),
      el('div', { class: 'card result-card' },
        waveform(round.result, { tag: 'result', height: 140, bars: 160 }),
        el('div', { class: 'row center' }, playButton('Ещё раз', round.result, { tag: 'result', key: 'KeyP', onPlay: () => stopCountdown?.() }))),
      el('div', { class: 'guess-who' },
        el('h3', {}, 'Кто угадал первым? ', el('span', { class: 'muted' }, 'Решает ', singer.name)),
        el('div', { class: 'guess-buttons' },
          list.map((i, k) => button(game.players[i].name, {
            key: k < 9 ? `Digit${k + 1}` : undefined,
            icon: avatar(game.players[i], 'sm'),
            cls: 'btn-player',
            onClick: () => choose(i),
          })),
          button('Никто не угадал', { key: 'Digit0', variant: 'ghost', icon: '🙈', onClick: () => choose(null) }))))]);

  let stopCountdown = null;
  if (autoplay) stopCountdown = countdown(3, () => audio.play(round.result, { tag: 'result' }));
}

// ---------- Screen: reveal ----------

function screenReveal(round, fresh) {
  screenName = 'reveal';
  const singer = game.players[round.singer];
  const mimic = game.players[round.mimic];
  const guessed = isGuessed(round);
  const winners = guessed ? [round.guessedBy, round.singer, round.mimic] : [];
  const last = game.index >= game.plan.length - 1;

  show(() => [
    topbar(3),
    el('div', { class: 'stage reveal' },
      el('div', { class: 'reveal-top' },
        el('div', { class: 'flip' + (fresh ? ' animate' : ' shown') },
          el('div', { class: 'flip-inner' },
            el('div', { class: 'flip-front' }, '?'),
            el('div', { class: 'flip-back' }, songCard(round.song)))),
        el('div', { class: 'outcome ' + (guessed ? 'win' : 'fail') },
          guessed
            ? [el('div', { class: 'outcome-big' }, '🎉 ', el('span', { style: { color: game.players[round.guessedBy].color } }, game.players[round.guessedBy].name), ' угадал(а)!'),
              el('div', { class: 'outcome-small' }, '+1: ', winners.map((i) => playerTag(game.players[i])))]
            : [el('div', { class: 'outcome-big' }, '😅 Никто не угадал'),
              el('div', { class: 'outcome-small' }, 'Очков в этом раунде нет')])),
      el('div', { class: 'compare' },
        compareItem('Оригинал', `${singer.emoji} ${singer.name}`, round.original, 'orig', 'KeyO', 'primary'),
        compareItem('Что получилось', `${mimic.emoji} ${mimic.name} задом наперёд`, round.result, 'result', 'KeyP', 'primary'),
        compareItem('Абракадабра', 'оригинал задом наперёд', round.reversed, 'rev', 'KeyB', 'secondary', 'wave-alt'),
        compareItem('Попытка', `${mimic.name} как есть`, round.attempt, 'attempt', 'KeyA', 'secondary', 'wave-alt')),
      el('div', { class: 'reveal-actions' },
        button('Изменить ответ', { key: 'Backspace', variant: 'ghost', onClick: () => screenGuess(round, false) }),
        button(last ? 'Итоги' : 'Следующий раунд', { key: 'Enter', variant: 'primary', cls: 'btn-xl', icon: last ? '🏆' : '➡️', onClick: nextRound }))),
    el('footer', { class: 'bottom' }, scoreboard({ highlight: fresh ? winners : [] }))]);

  if (fresh) {
    const timer = setTimeout(() => {
      audio.jingle(guessed ? 'win' : 'fail');
      if (guessed) confetti();
    }, 900);
    onLeave(() => clearTimeout(timer));
  }
}

function compareItem(label, sub, buffer, tag, key, variant, cls = '') {
  return el('div', { class: `compare-item card ${variant === 'primary' ? 'compare-main' : ''}` },
    el('div', { class: 'compare-head' }, el('b', {}, label), el('span', { class: 'muted' }, sub)),
    waveform(buffer, { tag, height: variant === 'primary' ? 70 : 50, bars: 90, cls }),
    playButton('Слушать', buffer, { tag, key, variant }));
}

// ---------- Screen: final ----------

function screenFinal() {
  screenName = 'final';
  cancelRemote(game.rounds[game.index]);
  const sc = scores();
  const order = [...game.players.keys()].sort((a, b) => sc[b] - sc[a]);
  const rounds = finishedRounds();
  const podium = order.slice(0, 3);
  const rest = order.slice(3);
  const places = ['🥇', '🥈', '🥉'];
  // Ties share the higher place; nobody gets a medal for zero points.
  const medal = (i) => (sc[i] > 0 ? places[order.findIndex((j) => sc[j] === sc[i])] ?? '' : '');

  show(() => [
    el('header', { class: 'topbar' },
      logo('sm'),
      el('div', { class: 'topbar-round' }, 'Итоги'),
      el('div', { class: 'spacer' }),
      button('В меню', { key: 'Escape', variant: 'ghost', onClick: screenHome })),
    el('div', { class: 'stage final' },
      el('h1', { class: 'title title-xl' }, rounds.length ? 'Наши звёзды! 🌟' : 'Игра окончена'),
      el('div', { class: 'podium' },
        [1, 0, 2].map((place) => {
          const i = podium[place];
          if (i == null) return el('div', { class: 'podium-slot empty' });
          const p = game.players[i];
          return el('div', { class: `podium-slot place-${place + 1}`, style: { '--c': p.color } },
            el('div', { class: 'podium-medal' }, medal(i)),
            avatar(p, place === 0 ? 'xl' : 'lg'),
            el('div', { class: 'podium-name' }, p.name),
            el('div', { class: 'podium-points' }, sc[i], ' ', plural(sc[i], 'очко', 'очка', 'очков')),
            el('div', { class: 'podium-block' }, place + 1));
        })),
      rest.length ? el('div', { class: 'rest' }, rest.map((i) => el('div', { class: 'rest-item' }, medal(i), playerTag(game.players[i]), el('b', {}, sc[i])))) : null,
      awards(rounds),
      rounds.length
        ? el('div', { class: 'highlights' },
          el('h2', {}, 'Лучшие моменты'),
          el('div', { class: 'highlight-grid' }, rounds.map((r, k) => highlightCard(r, k))))
        : null,
      el('div', { class: 'reveal-actions' },
        button('Ещё игра', { key: 'Enter', variant: 'primary', cls: 'btn-xl', icon: '🔁', onClick: startGame })))]);

  if (rounds.length) {
    audio.jingle('fanfare');
    confetti({ count: 260, duration: 6000 });
  }
}

function awards(rounds) {
  const n = game.players.length;
  const count = (fn) => {
    const c = Array(n).fill(0);
    for (const r of rounds) if (isGuessed(r)) c[fn(r)]++;
    return c;
  };
  const best = (c) => {
    const max = Math.max(...c);
    const who = max > 0 ? [...c.keys()].filter((i) => c[i] === max) : [];
    return who.length <= Math.max(1, Math.floor(n / 3)) ? who : [];
  };
  const list = [
    ['🎤', 'Голос вечера', 'чаще всех угадывали его песни', best(count((r) => r.singer))],
    ['🦜', 'Попугай года', 'лучше всех повторял', best(count((r) => r.mimic))],
    ['👂', 'Золотое ухо', 'угадал(а) больше всех', best(count((r) => r.guessedBy))],
  ].filter((a) => a[3].length);
  if (!list.length) return null;
  return el('div', { class: 'awards' }, list.map(([icon, title, sub, who]) =>
    el('div', { class: 'award card' },
      el('div', { class: 'award-icon' }, icon),
      el('div', { class: 'award-title' }, title),
      el('div', { class: 'award-who' }, who.map((i) => playerTag(game.players[i]))),
      el('div', { class: 'muted' }, sub))));
}

function highlightCard(round, k) {
  const singer = game.players[round.singer];
  const mimic = game.players[round.mimic];
  const { title, artist } = parseSong(round.song);
  return el('div', { class: 'highlight card' + (isGuessed(round) ? '' : ' missed') },
    el('div', { class: 'highlight-title' }, title),
    el('div', { class: 'muted' }, artist),
    el('div', { class: 'highlight-who' }, singer.emoji, ' ', singer.name, ' → ', mimic.emoji, ' ', mimic.name,
      ' · ', isGuessed(round) ? `угадал(а) ${game.players[round.guessedBy].name}` : 'не угадали'),
    el('div', { class: 'row' },
      round.original ? playButton('Оригинал', round.original, { tag: `h-orig-${k}` }) : null,
      round.result ? playButton('Что вышло', round.result, { tag: `h-res-${k}`, variant: 'primary' }) : null));
}

// ---------- Boot ----------

if (JOIN_CODE) {
  import('./phone.js').then((m) => m.startPhone(JOIN_CODE));
} else {
  host?.start();
  screenHome();
}
