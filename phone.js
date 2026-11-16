// Phone mode: a player's phone joins the TV's game, gets their song when it is their turn,
// records it away from the room and sends the take to the TV.

import * as audio from './audio.js';
import { el, show, button, playButton, waveform, recorder, avatar, logo, songCard } from './ui.js';
import { Link, newPeerId } from './net.js';

const SEND_TIMEOUT_MS = 25_000;

export function startPhone(code) {
  document.documentElement.classList.add('phone');
  const peerId = newPeerId();
  const nameKey = `apozh.phoneName.${code}`;
  let name = localStorage.getItem(nameKey);
  let roster = null; // { players: [{ name, emoji, color }], inGame }
  let job = null; // { round, song, maxSeconds, mimic } from the TV
  let take = null; // AudioBuffer recorded for the job
  let phase = 'connecting'; // connecting | missing | pick | wait | sing | sending | sent
  let joined = false;
  let hostOnline = true;
  let skipping = false;
  let sendError = '';
  let sendTimer = 0;
  let micReady = false;
  let draftName = ''; // survives re-renders while the TV updates the roster

  const statusBar = el('div', { class: 'phone-status' });

  const link = new Link({
    onOpen: () => link.send({ t: 'join', room: code, peerId }),
    onStatus: () => { if (!link.isOpen()) joined = false; updateStatusBar(); },
    onMessage,
  });

  function toHost(msg) {
    return link.send({ t: 'to-host', msg });
  }

  function hello() {
    if (name) toHost({ t: 'hello', name });
  }

  function report(state) {
    if (job) toHost({ t: 'status', round: job.round, state });
  }

  function updateStatusBar() {
    const ok = link.isOpen() && joined && hostOnline;
    statusBar.className = `phone-status ${ok ? 'ok' : 'bad'}`;
    statusBar.textContent = !link.isOpen() || !joined
      ? 'Нет связи с сервером, переподключаемся…'
      : !hostOnline ? 'Телевизор не на связи…' : `Игра ${code} · на связи`;
  }

  function onMessage(m) {
    if (m.t === 'joined') {
      joined = true;
      hostOnline = m.hostOnline;
      hello();
      if (phase === 'connecting' || phase === 'missing') {
        phase = name ? 'wait' : 'pick';
        render();
      }
    } else if (m.t === 'error' && m.reason === 'no-room') {
      phase = 'missing';
      render();
    } else if (m.t === 'host-status') {
      hostOnline = m.online;
      if (m.online) hello();
    } else if (m.t === 'from-host') {
      onHostMessage(m.msg);
    }
    updateStatusBar();
  }

  function onHostMessage(msg) {
    if (msg.t === 'roster') {
      roster = msg;
      if (phase === 'pick' || phase === 'wait') render();
    } else if (msg.t === 'sing') {
      const isNew = !job || job.round !== msg.round || job.song !== msg.song;
      job = msg;
      skipping = false;
      if (isNew) {
        take = null;
        sendError = '';
        if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([200, 100, 200]);
      }
      // A resend of the same job (after a reconnect) must not reset a recording in progress.
      if (isNew || (phase !== 'sing' && phase !== 'sending')) {
        phase = 'sing';
        render();
      }
      report(take ? 'recorded' : 'seen');
    } else if (msg.t === 'cancel') {
      job = null;
      take = null;
      clearTimeout(sendTimer);
      phase = name ? 'wait' : 'pick';
      render();
    } else if (msg.t === 'got' && job && msg.round === job.round) {
      clearTimeout(sendTimer);
      job = null;
      take = null;
      phase = 'sent';
      render();
    }
  }

  function me() {
    return roster?.players.find((p) => p.name === name) ?? null;
  }

  function choose(newName) {
    name = newName;
    localStorage.setItem(nameKey, name);
    hello();
    phase = job ? 'sing' : 'wait';
    navigator.wakeLock?.request('screen').catch(() => {});
    render();
  }

  async function prepareMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      micReady = true;
    } catch (e) {
      alert(audio.micErrorText(e));
    }
    render();
  }

  async function sendTake() {
    if (!job || !take) return;
    phase = 'sending';
    sendError = '';
    render();
    report('sending');
    const encoded = await audio.encodeBuffer(take);
    if (!job) return; // cancelled while encoding
    if (!toHost({ t: 'audio', round: job.round, ...encoded })) {
      phase = 'sing';
      sendError = 'Нет связи с сервером. Подожди пару секунд и отправь ещё раз.';
      render();
      return;
    }
    sendTimer = setTimeout(() => {
      if (phase !== 'sending') return;
      phase = 'sing';
      sendError = 'Телевизор не ответил. Попробуй отправить ещё раз.';
      render();
    }, SEND_TIMEOUT_MS);
  }

  // ---------- Screens ----------

  function frame(...children) {
    show(() => [el('div', { class: 'phone-screen' },
      el('header', { class: 'phone-top' }, logo('sm'), statusBar),
      el('div', { class: 'phone-body' }, children))]);
    updateStatusBar();
  }

  function render() {
    if (phase === 'connecting') {
      frame(el('div', { class: 'phone-center' },
        el('div', { class: 'spinner' }),
        el('h2', {}, `Подключаемся к игре ${code}…`)));
    } else if (phase === 'missing') {
      const input = el('input', { class: 'code-input', value: code, maxLength: 4, autocapitalize: 'characters' });
      frame(el('div', { class: 'phone-center' },
        el('div', { class: 'big-emoji' }, '😕'),
        el('h2', {}, `Игра ${code} не найдена`),
        el('p', { class: 'muted' }, 'Проверь код на экране телевизора.'),
        input,
        button('Подключиться', {
          variant: 'primary',
          onClick: () => {
            const next = input.value.trim().toUpperCase();
            if (/^[A-Z]{4}$/.test(next)) { location.hash = `#join=${next}`; location.reload(); }
          },
        })));
    } else if (phase === 'pick') {
      renderPick();
    } else if (phase === 'wait' || phase === 'sent') {
      renderWait();
    } else if (phase === 'sing') {
      renderSing();
    } else if (phase === 'sending') {
      frame(el('div', { class: 'phone-center' },
        el('div', { class: 'spinner' }),
        el('h2', {}, 'Отправляем запись на телевизор… 🚀')));
    }
  }

  function renderPick() {
    const players = roster?.players ?? [];
    const hadFocus = document.activeElement?.classList.contains('phone-name-input');
    const input = el('input', {
      class: 'player-input phone-name-input', placeholder: 'Твоё имя', maxLength: 16, value: draftName,
      oninput: (e) => { draftName = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') add(); },
    });
    const add = () => {
      const n = input.value.trim();
      if (!n) return;
      toHost({ t: 'add', name: n });
      choose(n);
    };
    frame(
      el('h1', { class: 'phone-title' }, 'Кто ты? 🙋'),
      roster
        ? el('div', { class: 'pick-list' }, players.map((p) =>
          el('button', { class: 'pick-btn', type: 'button', style: { '--c': p.color }, onclick: () => choose(p.name) }, avatar(p, 'md'), el('span', {}, p.name))))
        : el('p', { class: 'muted' }, 'Ждём список игроков с телевизора…'),
      roster && !roster.inGame
        ? el('div', { class: 'card add-me' },
          el('b', {}, 'Меня нет в списке'),
          el('div', { class: 'row' }, input, button('Добавить', { variant: 'primary', onClick: add })))
        : null,
      roster?.inGame && !players.length ? el('p', { class: 'muted' }, 'Игра уже идёт.') : null);
    if (hadFocus) input.focus();
  }

  function renderWait() {
    const player = me();
    const sent = phase === 'sent';
    frame(
      sent
        ? el('div', { class: 'card sent-card pop-in' },
          el('div', { class: 'big-emoji' }, '🎉'),
          el('h2', {}, 'Запись на телевизоре!'),
          el('p', {}, 'Возвращайся в комнату: сейчас все услышат, что получилось.'))
        : null,
      el('div', { class: 'phone-center' },
        player ? avatar(player, 'xl') : el('div', { class: 'big-emoji' }, '🙂'),
        el('h1', { class: 'phone-title' }, name),
        player
          ? el('p', { class: 'muted center' }, 'Ты в игре! Когда будет твоя очередь петь, здесь появится песня, а телефон завибрирует.')
          : el('p', { class: 'warn center' }, roster?.inGame ? 'Тебя нет в этой игре. Ведущий может добавить тебя в следующую.' : 'Тебя пока нет в списке игроков на телевизоре.'),
        micReady
          ? el('div', { class: 'mic-ok' }, '🎙️ Микрофон готов')
          : button('Разрешить микрофон заранее', { variant: 'secondary', icon: '🎙️', onClick: prepareMic }),
        button(`Я не ${name}`, { variant: 'ghost', onClick: () => { name = null; localStorage.removeItem(nameKey); phase = 'pick'; render(); } })));
  }

  function renderSing() {
    frame(
      el('div', { class: 'secret-label' }, '🤫 Только для тебя'),
      songCard(job.song, { cls: 'pop-in' }),
      button(skipping ? 'Ищем другую…' : 'Не знаю эту, другую', {
        variant: 'ghost', icon: '🎲', disabled: skipping || Boolean(take),
        onClick: () => { skipping = true; toHost({ t: 'skip', round: job.round }); render(); },
      }),
      el('p', { class: 'muted center' }, 'Уйди туда, где тебя не слышно, и спой 10–15 секунд самого узнаваемого места, со словами.'),
      recorder({
        maxSeconds: job.maxSeconds || 20,
        idleText: take ? 'Перепеть' : 'Нажми и пой',
        onStart: () => report('recording'),
        onDone: (buffer) => { take = buffer; sendError = ''; report('recorded'); render(); },
      }),
      take
        ? el('div', { class: 'card recorded pop-in' },
          waveform(take, { tag: 'phone-take', height: 70 }),
          el('div', { class: 'phone-actions' },
            playButton('Послушать', take, { tag: 'phone-take' }),
            button('Отправить на ТВ', { variant: 'primary', icon: '📺', onClick: sendTake })),
          sendError ? el('div', { class: 'error' }, sendError) : null)
        : null);
  }

  render();
  link.start();
}
