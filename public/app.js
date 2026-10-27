"use strict";

const $ = (id) => document.getElementById(id);
const SAMPLE_RATE = 44100;
const decoderCtx = new OfflineAudioContext(2, 1, SAMPLE_RATE);

let voices = [];
let musicBuffer = null;
let musicName = "";
let voiceCache = { key: "", buffer: null };
let rendered = null; // { buffer, plan }
let playerUrl = null;
let previewAudio = null;

// ---------- helpers ----------

function setStatus(el, msg, kind = "") {
  el.textContent = msg;
  el.className = "status " + kind;
}

function bindOutput(id, fmt) {
  const input = $(id);
  const out = $(id + "Out");
  const update = () => (out.textContent = fmt(Number(input.value)));
  input.addEventListener("input", update);
  update();
}

function numberVal(id, min, max) {
  const n = Number($(id).value);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

function placement() {
  return document.querySelector('input[name="placement"]:checked').value;
}

// ---------- voices ----------

async function loadVoices() {
  const langSel = $("language");
  langSel.innerHTML = "<option>Loading voices…</option>";
  try {
    const res = await fetch("/api/voices");
    if (!res.ok) throw new Error((await res.json()).error);
    voices = await res.json();
  } catch (err) {
    langSel.innerHTML = "<option>Failed to load</option>";
    setStatus($("voiceStatus"), err.message || "Could not load voices.", "error");
    return;
  }

  const langs = [...new Map(voices.map((v) => [v.language, v.locale])).entries()];
  langSel.innerHTML = langs.map(([name, loc]) => `<option value="${loc}">${name}</option>`).join("");

  const preferred = [navigator.language, "en-US"].find((l) => voices.some((v) => v.locale === l));
  if (preferred) langSel.value = preferred;
  fillVoiceList("en-US-AriaNeural");
}

function fillVoiceList(preferredId) {
  const locale = $("language").value;
  const gender = $("gender").value;
  const list = voices.filter((v) => v.locale === locale && (!gender || v.gender === gender));
  const sel = $("voice");
  sel.innerHTML = list.length
    ? list
        .map((v) => {
          const tags = v.personalities.length ? ` — ${v.personalities.join(", ")}` : "";
          return `<option value="${v.id}">${v.name} (${v.gender})${tags}</option>`;
        })
        .join("")
    : "<option value=''>No voices match</option>";
  if (preferredId && list.some((v) => v.id === preferredId)) sel.value = preferredId;
}

function voiceParams() {
  return {
    text: $("text").value.trim(),
    voice: $("voice").value,
    rate: Number($("rate").value),
    pitch: Number($("pitch").value),
  };
}

async function fetchVoiceAudio(params) {
  if (!params.text) throw new Error("Please type a message first.");
  if (!params.voice) throw new Error("Please choose a voice.");
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    let msg = "Voice generation failed.";
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.arrayBuffer();
}

async function getVoiceBuffer() {
  const params = voiceParams();
  const key = JSON.stringify(params);
  if (voiceCache.key === key) return voiceCache.buffer;
  const data = await fetchVoiceAudio(params);
  const buffer = await decoderCtx.decodeAudioData(data);
  voiceCache = { key, buffer };
  return buffer;
}

async function previewVoice() {
  const btn = $("previewVoice");
  const status = $("voiceStatus");
  btn.disabled = true;
  setStatus(status, "Generating…");
  try {
    const params = voiceParams();
    if (!params.text) params.text = "Hello! This is how I sound as your ringtone.";
    const data = await fetchVoiceAudio(params);
    if (previewAudio) { previewAudio.pause(); URL.revokeObjectURL(previewAudio.src); }
    previewAudio = new Audio(URL.createObjectURL(new Blob([data], { type: "audio/mpeg" })));
    await previewAudio.play();
    setStatus(status, "");
  } catch (err) {
    setStatus(status, err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// ---------- music ----------

async function loadMusic(file) {
  const label = $("musicLabel");
  label.textContent = `Loading ${file.name}…`;
  try {
    musicBuffer = await decoderCtx.decodeAudioData(await file.arrayBuffer());
    musicName = file.name;
  } catch {
    musicBuffer = null;
    updateMusicUI();
    label.innerHTML = `Could not read <b>${escapeHtml(file.name)}</b>. Try an MP3 or WAV file.`;
    return;
  }
  const start = $("musicStart");
  start.max = Math.max(0, musicBuffer.duration - 1).toFixed(1);
  start.value = 0;
  start.dispatchEvent(new Event("input"));
  updateMusicUI();
}

function clearMusic() {
  musicBuffer = null;
  musicName = "";
  $("musicFile").value = "";
  updateMusicUI();
}

function updateMusicUI() {
  const has = !!musicBuffer;
  $("drop").classList.toggle("loaded", has);
  $("clearMusic").hidden = !has;
  $("musicOptions").classList.toggle("disabled", !has);
  if (has) {
    $("musicLabel").innerHTML = `🎵 <b>${escapeHtml(musicName)}</b><br /><small>${musicBuffer.duration.toFixed(1)} s</small>`;
  } else {
    $("musicLabel").innerHTML = `Drop an audio file here or <a href="#">browse</a><br /><small>MP3, WAV, OGG, M4A…</small>`;
  }
  const p = placement();
  $("bgOnly").hidden = p !== "background";
  $("clipLenWrap").hidden = p === "background";
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------- mixing ----------

/**
 * Lays out the ringtone timeline.
 * Returns voice start times, music segments and the total length (seconds).
 */
function buildPlan(voiceDur) {
  const repeat = Math.round(numberVal("repeat", 1, 10));
  const gap = numberVal("gap", 0, 10);
  const maxLen = numberVal("maxLen", 5, 120);
  const blockLen = repeat * voiceDur + (repeat - 1) * gap;
  const musicStart = Number($("musicStart").value);
  const clip = Number($("clipLen").value);
  const SPACER = 0.25;

  let voiceAt = 0.3;
  let total;
  const music = []; // { start, end, offset }

  if (!musicBuffer) {
    total = voiceAt + blockLen + 0.5;
  } else {
    switch (placement()) {
      case "background": {
        voiceAt = Number($("leadIn").value);
        total = voiceAt + blockLen + Number($("tail").value);
        music.push({ start: 0, end: total, offset: musicStart });
        break;
      }
      case "front": {
        music.push({ start: 0, end: clip, offset: musicStart });
        voiceAt = clip + SPACER;
        total = voiceAt + blockLen + 0.5;
        break;
      }
      case "back": {
        const musicAt = voiceAt + blockLen + SPACER;
        total = musicAt + clip;
        music.push({ start: musicAt, end: total, offset: musicStart });
        break;
      }
      case "both": {
        music.push({ start: 0, end: clip, offset: musicStart });
        voiceAt = clip + SPACER;
        const musicAt = voiceAt + blockLen + SPACER;
        total = musicAt + clip;
        // continue the song where the intro left off
        music.push({ start: musicAt, end: total, offset: musicStart + clip });
        break;
      }
    }
  }

  const voiceStarts = [];
  for (let i = 0; i < repeat; i++) {
    const t = voiceAt + i * (voiceDur + gap);
    if (t < maxLen) voiceStarts.push(t);
  }

  const truncated = total > maxLen;
  total = Math.min(total, maxLen);
  for (const seg of music) seg.end = Math.min(seg.end, total);

  return {
    total,
    truncated,
    voiceDur,
    voiceStarts,
    music: music.filter((s) => s.end > s.start),
  };
}

/** Music volume envelope (fades + ducking) evaluated at time t. */
function musicEnvelope(plan, t) {
  const base = Number($("musicVol").value) / 100;
  const fades = $("fades").checked;
  const duck = $("duck").checked;

  const seg = plan.music.find((s) => t >= s.start && t <= s.end);
  if (!seg) return 0;

  let g = base;
  if (fades) {
    const len = seg.end - seg.start;
    const fadeIn = seg.start === 0 && plan.voiceStarts[0] > 0.5 ? Math.min(1.5, len / 3) : Math.min(0.4, len / 4);
    const fadeOut = Math.min(2, len / 3);
    if (t - seg.start < fadeIn) g *= (t - seg.start) / fadeIn;
    if (seg.end - t < fadeOut) g *= (seg.end - t) / fadeOut;
  }
  if (duck) {
    const DUCK_LEVEL = 0.3;
    const RAMP = 0.3;
    let d = 1;
    for (const vs of plan.voiceStarts) {
      const ve = vs + plan.voiceDur;
      let f = 1;
      if (t >= vs && t <= ve) f = DUCK_LEVEL;
      else if (t < vs && vs - t < RAMP) f = 1 - (1 - DUCK_LEVEL) * (1 - (vs - t) / RAMP);
      else if (t > ve && t - ve < RAMP) f = 1 - (1 - DUCK_LEVEL) * (1 - (t - ve) / RAMP);
      d = Math.min(d, f);
    }
    g *= d;
  }
  return g;
}

/** Wrap a song position so it loops from the chosen start point. */
function wrapOffset(offset, loopStart, duration) {
  if (offset < duration) return offset;
  const loopLen = duration - loopStart;
  return loopStart + ((offset - loopStart) % loopLen);
}

async function renderMix(voiceBuffer) {
  const plan = buildPlan(voiceBuffer.duration);
  const length = Math.ceil(plan.total * SAMPLE_RATE);
  const ctx = new OfflineAudioContext(2, length, SAMPLE_RATE);

  // voice
  const voiceGain = ctx.createGain();
  voiceGain.gain.value = Number($("voiceVol").value) / 100;
  voiceGain.connect(ctx.destination);
  for (const t of plan.voiceStarts) {
    const src = ctx.createBufferSource();
    src.buffer = voiceBuffer;
    src.connect(voiceGain);
    src.start(t);
  }

  // music
  if (musicBuffer && plan.music.length) {
    const musicGain = ctx.createGain();
    musicGain.connect(ctx.destination);
    const steps = Math.max(2, Math.ceil(plan.total * 200));
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) curve[i] = musicEnvelope(plan, (i / (steps - 1)) * plan.total);
    musicGain.gain.setValueCurveAtTime(curve, 0, plan.total);

    const loopStart = Math.min(Number($("musicStart").value), musicBuffer.duration - 0.1);
    for (const seg of plan.music) {
      const src = ctx.createBufferSource();
      src.buffer = musicBuffer;
      src.loop = true;
      src.loopStart = loopStart;
      src.loopEnd = musicBuffer.duration;
      src.connect(musicGain);
      src.start(seg.start, wrapOffset(seg.offset, loopStart, musicBuffer.duration));
      src.stop(seg.end);
    }
  }

  const buffer = await ctx.startRendering();
  finalize(buffer, plan);
  return { buffer, plan };
}

/** Normalize peaks to avoid clipping and fade out if the ringtone was cut short. */
function finalize(buffer, plan) {
  const chans = [...Array(buffer.numberOfChannels)].map((_, i) => buffer.getChannelData(i));
  let peak = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  const scale = peak > 0.98 ? 0.98 / peak : 1;
  const fadeLen = plan.truncated ? Math.floor(0.5 * SAMPLE_RATE) : 0;
  for (const ch of chans) {
    const n = ch.length;
    for (let i = 0; i < n; i++) {
      let s = ch[i] * scale;
      if (n - i < fadeLen) s *= (n - i) / fadeLen;
      ch[i] = s;
    }
  }
}

// ---------- encoding ----------

function toInt16(ch) {
  const out = new Int16Array(ch.length);
  for (let i = 0; i < ch.length; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function encodeWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const chans = [...Array(numCh)].map((_, i) => toInt16(buffer.getChannelData(i)));
  const n = buffer.length;
  const dataLen = n * numCh * 2;
  const view = new DataView(new ArrayBuffer(44 + dataLen));
  const str = (off, s) => [...s].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));
  str(0, "RIFF"); view.setUint32(4, 36 + dataLen, true); str(8, "WAVE");
  str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * numCh * 2, true); view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true); str(36, "data"); view.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < numCh; c++, off += 2) view.setInt16(off, chans[c][i], true);
  return new Blob([view], { type: "audio/wav" });
}

function encodeMp3(buffer) {
  const enc = new lamejs.Mp3Encoder(2, buffer.sampleRate, 192);
  const left = toInt16(buffer.getChannelData(0));
  const right = toInt16(buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0));
  const parts = [];
  const BLOCK = 1152;
  for (let i = 0; i < left.length; i += BLOCK) {
    const chunk = enc.encodeBuffer(left.subarray(i, i + BLOCK), right.subarray(i, i + BLOCK));
    if (chunk.length) parts.push(new Uint8Array(chunk));
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  return new Blob(parts, { type: "audio/mpeg" });
}

function download(blob, ext) {
  const name = ($("fileName").value.trim() || "ringtone").replace(/[\\/:*?"<>|]/g, "_");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- waveform ----------

function drawWave(progress = -1) {
  if (!rendered) return;
  const { buffer, plan } = rendered;
  const canvas = $("wave");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr;
  const h = canvas.clientHeight * dpr;
  if (canvas.width !== w) canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.documentElement);
  const voiceColor = css.getPropertyValue("--voice").trim();
  const musicColor = css.getPropertyValue("--music").trim();
  const data = buffer.getChannelData(0);
  const perPx = data.length / w;
  const mid = h / 2;

  for (let x = 0; x < w; x++) {
    const t = (x / w) * plan.total;
    const isVoice = plan.voiceStarts.some((s) => t >= s && t <= s + plan.voiceDur);
    let min = 0, max = 0;
    const from = Math.floor(x * perPx), to = Math.floor((x + 1) * perPx);
    for (let i = from; i < to; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    g.fillStyle = isVoice ? voiceColor : musicColor;
    g.globalAlpha = progress >= 0 && x / w > progress ? 0.45 : 1;
    g.fillRect(x, mid + min * mid * 0.95, 1, Math.max(1, (max - min) * mid * 0.95));
  }
  g.globalAlpha = 1;
  if (progress >= 0) {
    g.fillStyle = "#fff";
    g.fillRect(progress * w, 0, 2 * dpr, h);
  }
}

function animatePlayhead() {
  const p = $("player");
  if (rendered && p.duration) drawWave(p.currentTime / p.duration);
  if (!p.paused) requestAnimationFrame(animatePlayhead);
}

// ---------- create ----------

async function createRingtone() {
  const btn = $("create");
  const status = $("status");
  btn.disabled = true;
  try {
    setStatus(status, "Generating voice…");
    const voiceBuffer = await getVoiceBuffer();
    setStatus(status, "Mixing…");
    rendered = await renderMix(voiceBuffer);

    if (playerUrl) URL.revokeObjectURL(playerUrl);
    playerUrl = URL.createObjectURL(encodeWav(rendered.buffer));
    $("player").src = playerUrl;
    $("result").hidden = false;
    drawWave();
    const note = rendered.plan.truncated ? " (trimmed to max length)" : "";
    setStatus(status, `Done! ${rendered.plan.total.toFixed(1)} s${note}`, "ok");
    $("player").play().catch(() => {});
  } catch (err) {
    console.error(err);
    setStatus(status, err.message || "Something went wrong.", "error");
  } finally {
    btn.disabled = false;
  }
}

// ---------- wiring ----------

function init() {
  bindOutput("rate", (v) => `${v > 0 ? "+" : ""}${v}%`);
  bindOutput("pitch", (v) => `${v > 0 ? "+" : ""}${v} Hz`);
  bindOutput("musicStart", (v) => `${v.toFixed(1)} s`);
  bindOutput("clipLen", (v) => `${v} s`);
  bindOutput("leadIn", (v) => `${v.toFixed(1)} s`);
  bindOutput("tail", (v) => `${v.toFixed(1)} s`);
  bindOutput("musicVol", (v) => `${v}%`);
  bindOutput("voiceVol", (v) => `${v}%`);

  $("language").addEventListener("change", () => fillVoiceList());
  $("gender").addEventListener("change", () => fillVoiceList($("voice").value));
  $("previewVoice").addEventListener("click", previewVoice);
  $("create").addEventListener("click", createRingtone);

  $("chips").addEventListener("click", (e) => {
    if (e.target.dataset.text) $("text").value = e.target.dataset.text;
  });

  // music file input + drag & drop
  const drop = $("drop");
  $("musicFile").addEventListener("change", (e) => e.target.files[0] && loadMusic(e.target.files[0]));
  $("clearMusic").addEventListener("click", (e) => { e.stopPropagation(); clearMusic(); });
  drop.addEventListener("click", (e) => { e.preventDefault(); $("musicFile").click(); });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer.files[0];
    if (f) loadMusic(f);
  });
  $("placement").addEventListener("change", updateMusicUI);

  $("dlWav").addEventListener("click", () => rendered && download(encodeWav(rendered.buffer), "wav"));
  $("dlMp3").addEventListener("click", () => rendered && download(encodeMp3(rendered.buffer), "mp3"));

  const player = $("player");
  player.addEventListener("play", animatePlayhead);
  player.addEventListener("seeked", () => player.duration && drawWave(player.currentTime / player.duration));
  player.addEventListener("ended", () => drawWave());
  window.addEventListener("resize", () => drawWave());

  updateMusicUI();
  loadVoices();
}

init();
