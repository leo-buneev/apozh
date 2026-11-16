// Audio engine: microphone capture, buffer processing (trim, normalize, reverse),
// playback with progress tracking, and a few synthesized jingles.

let ctx = null;

export function getContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  return ctx;
}

// ---------- Playback ----------

let current = null; // { source, buffer, tag, startedAt }
const listeners = new Set();

export function onPlaybackChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(current);
}

let recordingSessions = 0;

export function isRecording() {
  return recordingSessions > 0;
}

// Playback is refused while the mic is open: speakers would bleed into the take.
export function play(buffer, { tag = null, onEnd } = {}) {
  if (isRecording()) return false;
  stop();
  const ac = getContext();
  const source = ac.createBufferSource();
  source.buffer = buffer;
  source.connect(ac.destination);
  const entry = { source, buffer, tag, startedAt: ac.currentTime };
  source.onended = () => {
    if (current !== entry) return;
    current = null;
    emit();
    onEnd?.();
  };
  current = entry;
  source.start();
  emit();
  return true;
}

export function stop() {
  if (!current) return;
  const entry = current;
  current = null;
  try { entry.source.stop(); } catch {}
  emit();
}

export function playingTag() {
  return current?.tag ?? null;
}

// 0..1 progress of the buffer that is playing with the given tag, or null.
export function progressOf(tag) {
  if (!current || current.tag !== tag) return null;
  return Math.min(1, (ctx.currentTime - current.startedAt) / current.buffer.duration);
}

// ---------- Recording ----------

export class MicError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind;
    this.cause = cause;
  }
}

export function micErrorText(err) {
  const kind = err?.kind ?? err?.name;
  if (kind === 'unsupported') return 'Браузер не даёт доступ к микрофону. Открой сайт по https в Chrome, Edge или Safari.';
  if (kind === 'NotAllowedError' || kind === 'SecurityError') return 'Нет доступа к микрофону. Разреши его для этого сайта (значок слева от адреса) и попробуй снова.';
  if (kind === 'NotFoundError' || kind === 'OverconstrainedError') return 'Микрофон не найден. Подключи его и попробуй снова.';
  if (kind === 'NotReadableError') return 'Микрофон занят другой программой (Zoom, Teams…). Закрой её и попробуй снова.';
  return 'Не получилось включить микрофон: ' + (err?.message || kind || 'неизвестная ошибка');
}

/**
 * Starts capturing the default microphone.
 * onLevel(peak, seconds) fires for every captured block (~10 times a second).
 * Returns a session with finish() -> AudioBuffer|null and cancel().
 */
export async function startRecording({ onLevel } = {}) {
  const ac = getContext();
  stop();
  if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unsupported');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
  } catch (e) {
    throw new MicError(e?.name || 'unknown', e);
  }
  try {
    return await captureStream(ac, stream, onLevel);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
}

async function captureStream(ac, stream, onLevel) {
  if (ac.state !== 'running') await ac.resume();

  const source = ac.createMediaStreamSource(stream);
  const sink = ac.createGain();
  sink.gain.value = 0; // the capture node must reach the destination to run, but stays silent
  const chunks = [];
  let length = 0;
  let closed = false;

  function onChunk(data) {
    if (closed) return;
    chunks.push(data);
    length += data.length;
    let peak = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    onLevel?.(peak, length / ac.sampleRate);
  }

  // AudioWorklet captures off the main thread, so heavy UI never drops samples.
  // ScriptProcessor is the fallback for old browsers.
  let node;
  if (await loadCaptureWorklet(ac)) {
    node = new AudioWorkletNode(ac, 'apozh-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit',
    });
    node.port.onmessage = (e) => onChunk(e.data);
  } else {
    node = ac.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
  }
  source.connect(node);
  node.connect(sink);
  sink.connect(ac.destination);
  recordingSessions++;

  function close() {
    closed = true;
    recordingSessions--;
    if (node.port) { node.port.onmessage = null; node.port.postMessage('stop'); }
    else node.onaudioprocess = null;
    try { source.disconnect(); node.disconnect(); sink.disconnect(); } catch {}
    stream.getTracks().forEach((t) => t.stop());
  }

  return {
    finish() {
      if (closed) return null;
      close();
      const data = new Float32Array(length);
      let offset = 0;
      for (const c of chunks) { data.set(c, offset); offset += c.length; }
      return processRecording(data, ac.sampleRate);
    },
    cancel() {
      if (!closed) close();
    },
  };
}

// Posts mono input in ~2048-sample blocks to the main thread.
const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.alive = true;
    this.port.onmessage = () => { this.alive = false; };
  }
  process(inputs) {
    if (!this.alive) return false;
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(2048); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('apozh-capture', Capture);
`;

let workletReady = null;

function loadCaptureWorklet(ac) {
  if (!ac.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.resolve(false);
  if (!workletReady) {
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
    workletReady = ac.audioWorklet.addModule(url).then(() => true, () => false);
  }
  return workletReady;
}

// Trims silence at both ends, normalizes loudness and adds short fades.
// Returns null when the recording is empty or too quiet to be useful.
function processRecording(data, rate) {
  // Skip the first 60 ms: some microphones click when they switch on.
  const skip = Math.min(data.length, Math.floor(rate * 0.06));
  let peak = 0;
  for (let i = skip; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  if (peak < 0.01 || data.length - skip < rate * 0.5) return null;

  const threshold = Math.max(0.012, peak * 0.08);
  let start = skip;
  let end = data.length;
  while (start < end && Math.abs(data[start]) < threshold) start++;
  while (end > start && Math.abs(data[end - 1]) < threshold) end--;
  const pad = Math.floor(rate * 0.2);
  start = Math.max(skip, start - pad);
  end = Math.min(data.length, end + pad);
  if (end - start < rate * 0.4) return null;

  const out = data.slice(start, end);
  const gain = Math.min(0.9 / peak, 10);
  const fade = Math.min(Math.floor(rate * 0.015), Math.floor(out.length / 2));
  for (let i = 0; i < out.length; i++) {
    let g = gain;
    if (i < fade) g *= i / fade;
    else if (i >= out.length - fade) g *= (out.length - 1 - i) / fade;
    out[i] *= g;
  }
  return toBuffer(out, rate);
}

function toBuffer(samples, rate) {
  const buf = getContext().createBuffer(1, Math.max(1, samples.length), rate);
  buf.getChannelData(0).set(samples);
  return buf;
}

// A piece of a buffer with short fades, so cuts in the middle of a sound don't click.
export function slice(buffer, fromSeconds, toSeconds) {
  const rate = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const out = data.slice(Math.floor(fromSeconds * rate), Math.min(data.length, Math.floor(toSeconds * rate)));
  const fade = Math.min(Math.floor(rate * 0.01), Math.floor(out.length / 2));
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[out.length - 1 - i] *= i / fade;
  }
  return toBuffer(out, rate);
}

export function concat(buffers) {
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const b of buffers) { out.set(b.getChannelData(0), offset); offset += b.length; }
  return toBuffer(out, buffers[0].sampleRate);
}

export function reverse(buffer) {
  const data = new Float32Array(buffer.getChannelData(0));
  data.reverse();
  return toBuffer(data, buffer.sampleRate);
}

// ---------- Transfer encoding (phone -> TV) ----------

// Mono 16-bit PCM, downsampled to at most ~24 kHz (plenty for voice), base64 for JSON.
export async function encodeBuffer(buffer, maxRate = 24000) {
  const src = buffer.getChannelData(0);
  const factor = Math.max(1, Math.floor(buffer.sampleRate / maxRate));
  const n = Math.floor(src.length / factor);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < factor; k++) sum += src[i * factor + k];
    const v = Math.max(-1, Math.min(1, sum / factor));
    pcm[i] = Math.round(v * 32767);
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([pcm.buffer]));
  });
  return { rate: buffer.sampleRate / factor, data: String(dataUrl).slice(String(dataUrl).indexOf(',') + 1) };
}

export async function decodeBuffer({ rate, data }) {
  const bytes = await (await fetch(`data:application/octet-stream;base64,${data}`)).arrayBuffer();
  const pcm = new Int16Array(bytes);
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32767;
  return toBuffer(samples, rate);
}

// Max absolute amplitude per bucket, normalized to 0..1; used for waveforms.
export function peaks(buffer, count) {
  const data = buffer.getChannelData(0);
  const size = data.length / count;
  const out = new Array(count).fill(0);
  let max = 0;
  for (let b = 0; b < count; b++) {
    const from = Math.floor(b * size);
    const to = Math.min(data.length, Math.floor((b + 1) * size));
    let p = 0;
    for (let i = from; i < to; i += 2) {
      const a = Math.abs(data[i]);
      if (a > p) p = a;
    }
    out[b] = p;
    if (p > max) max = p;
  }
  return max > 0 ? out.map((p) => p / max) : out;
}

// ---------- Jingles ----------

function tone(ac, { freq, start, dur, type = 'triangle', vol = 0.18, slideTo }) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(vol, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

export function jingle(kind) {
  const ac = getContext();
  const t = ac.currentTime + 0.03;
  if (kind === 'win') {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(ac, { freq: f, start: t + i * 0.11, dur: 0.35 }));
    tone(ac, { freq: 1318.5, start: t + 0.46, dur: 0.7, vol: 0.14 });
  } else if (kind === 'fail') {
    [392, 370, 349.2].forEach((f, i) => tone(ac, { freq: f, start: t + i * 0.32, dur: 0.34, type: 'sawtooth', vol: 0.07 }));
    tone(ac, { freq: 330, start: t + 0.96, dur: 0.9, type: 'sawtooth', vol: 0.07, slideTo: 290 });
  } else if (kind === 'tick') {
    tone(ac, { freq: 880, start: t, dur: 0.12, type: 'square', vol: 0.05 });
  } else if (kind === 'go') {
    tone(ac, { freq: 1320, start: t, dur: 0.25, type: 'square', vol: 0.06 });
  } else if (kind === 'fanfare') {
    [392, 523.25, 659.25, 783.99, 659.25, 783.99].forEach((f, i) =>
      tone(ac, { freq: f, start: t + i * 0.14, dur: i === 5 ? 0.9 : 0.2, vol: 0.15 }));
  }
}
