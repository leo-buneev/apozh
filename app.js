// АПОЖ: party game where a song is sung, reversed, imitated, reversed again and guessed.
// One computer drives the game; its screen is meant to be shown on a TV.

import * as audio from './audio.js';
import {
  el, show, button, playButton, waveform, recorder, avatar, playerTag, openModal, closeModal,
  modalButton, countdown, confetti, logo, plural, kbd, onLeave, PLAYER_COLORS, PLAYER_EMOJIS,
} from './ui.js';
import { SONG_CATEGORIES } from './songs.js';

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

function saveSettings() {
  for (const [key, value] of Object.entries(settings)) save(key, value);
}

// ---------- Songs ----------

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;
const SINGER_MAX_SECONDS = 20;
const MIMIC_MAX_SECONDS = 30;

// "Artist — Title (first words)" -> { artist, title, lyric }
function parseSong(line) {
  const parts = line.split(/\s+[—–-]\s+/);
  let artist = '';
  let title = line.trim();
  if (parts.length >= 2) {
    artist = parts[0].trim();
    title = parts.slice(1).join(' — ').trim();
  }
  const m = title.match(/^(.+?)\s*\(([^()]+)\)$/);
  return m ? { artist, title: m[1], lyric: m[2] } : { artist, title, lyric: '' };
}

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
  game = { players, plan, index: 0, rounds: [], deck: buildDeck() };
  requestWakeLock();
  screenIntro();
}

function currentRound() {
  if (!game.rounds[game.index]) {
    game.rounds[game.index] = {
      ...game.plan[game.index],
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

function songCard(song, { cls = '' } = {}) {
  const { title, artist, lyric } = parseSong(song);
  return el('div', { class: `song-card ${cls}` },
    el('div', { class: 'song-note' }, '🎵'),
    el('div', { class: 'song-title' }, title),
    lyric ? el('div', { class: 'song-lyric' }, '«', lyric, '»') : null,
    artist ? el('div', { class: 'song-artist' }, artist) : null);
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
  game = null;
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

  function renderPlayers(focusIndex) {
    playersBox.replaceChildren(...settings.players.map((p, i) => {
      const input = el('input', {
        class: 'player-input', value: p.name, placeholder: `Игрок ${i + 1}`, maxLength: 16,
        oninput: (e) => { p.name = e.target.value; saveSettings(); updateCounts(); },
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
        settings.players.length > MIN_PLAYERS
          ? el('button', { class: 'icon-btn', type: 'button', title: 'Убрать', onclick: () => { settings.players.splice(i, 1); saveSettings(); renderPlayers(); } }, '✕')
          : null);
    }));
    if (settings.players.length < MAX_PLAYERS) {
      playersBox.append(el('button', { class: 'add-player', type: 'button', onclick: () => addPlayer() }, '+ Добавить игрока'));
    }
    updateCounts();
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
}

// ---------- Screen: microphone check ----------

function screenSandbox(buffer = null) {
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
  const round = currentRound();
  const singer = game.players[round.singer];
  const mimic = game.players[round.mimic];
  show(() => [
    topbar(0),
    el('div', { class: 'stage intro' },
      el('div', { class: 'round-big' }, 'Раунд ', game.index + 1),
      el('div', { class: 'duo' },
        roleCard(singer, '🎤', 'Поёт'),
        el('div', { class: 'duo-arrow' }, '🔄'),
        roleCard(mimic, '🦜', 'Повторяет')),
      el('div', { class: 'guessers' }, el('span', { class: 'muted' }, 'Угадывают: '), guessers(round).map((i) => playerTag(game.players[i]))),
      el('div', { class: 'banner' },
        el('span', { class: 'banner-icon' }, '🚪'),
        el('div', {}, 'Все, кроме ', el('b', { style: { color: singer.color } }, singer.name), ', выходят из комнаты. ', singer.name, ', садись к компьютеру!')),
      button('Все вышли, показать песню', { key: 'Enter', variant: 'primary', cls: 'btn-xl', onClick: () => screenSinger(round) })),
    el('footer', { class: 'bottom' }, scoreboard())]);
}

function roleCard(player, icon, role) {
  return el('div', { class: 'role-card', style: { '--c': player.color } },
    el('div', { class: 'role-label' }, icon, ' ', role),
    avatar(player, 'xl'),
    el('div', { class: 'role-name' }, player.name));
}

// ---------- Screen: singer ----------

function screenSinger(round) {
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
  const singer = game.players[round.singer];
  const list = guessers(round);
  const choose = (i) => { round.guessedBy = i; screenReveal(round, true); };

  show(() => [
    topbar(2),
    el('div', { class: 'stage guess' },
      el('h1', { class: 'title title-xl wobble' }, 'Что это за песня? 🤔'),
      el('div', { class: 'card result-card' },
        waveform(round.result, { tag: 'result', height: 140, bars: 160 }),
        el('div', { class: 'row center' }, playButton('Ещё раз', round.result, { tag: 'result', key: 'KeyP' }))),
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

  if (autoplay) countdown(3, () => audio.play(round.result, { tag: 'result' }));
}

// ---------- Screen: reveal ----------

function screenReveal(round, fresh) {
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
    setTimeout(() => {
      audio.jingle(guessed ? 'win' : 'fail');
      if (guessed) confetti();
    }, 900);
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
  const sc = scores();
  const order = [...game.players.keys()].sort((a, b) => sc[b] - sc[a]);
  const rounds = finishedRounds();
  const podium = order.slice(0, 3);
  const rest = order.slice(3);
  const places = ['🥇', '🥈', '🥉'];

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
          // Ties share the higher place.
          const rank = order.findIndex((j) => sc[j] === sc[i]);
          return el('div', { class: `podium-slot place-${place + 1}`, style: { '--c': p.color } },
            el('div', { class: 'podium-medal' }, places[rank] ?? ''),
            avatar(p, place === 0 ? 'xl' : 'lg'),
            el('div', { class: 'podium-name' }, p.name),
            el('div', { class: 'podium-points' }, sc[i], ' ', plural(sc[i], 'очко', 'очка', 'очков')),
            el('div', { class: 'podium-block' }, place + 1));
        })),
      rest.length ? el('div', { class: 'rest' }, rest.map((i) => el('div', { class: 'rest-item' }, playerTag(game.players[i]), el('b', {}, sc[i])))) : null,
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

screenHome();
