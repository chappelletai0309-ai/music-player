/**
 * SceneFlow Music Player v2 — app.js
 *
 * ┌─ Architecture ─────────────────────────────────────────┐
 * │  IndexedDB persists: audio blobs + library + playlist  │
 * │  Web Audio API: AudioContext suspend/resume for pause   │
 * │  Per-song: fadeIn, fadeOut, volume, repeat (loop)      │
 * │  Next/Prev: triggers fadeOut on current → fadeIn next  │
 * └────────────────────────────────────────────────────────┘
 */

'use strict';

/* ══════════════════════════════════════════
   1. DATA MODEL
══════════════════════════════════════════ */
// library[]  : { id, name, duration }
// playlist[] : { id, libId, fadeIn, fadeOut, volume, repeat }

let library  = [];
let playlist = [];

// Playback state
let audioCtx = null;
let currentSource = null;   // AudioBufferSourceNode
let currentGain   = null;   // GainNode
let currentIdx    = -1;     // index in playlist
let isPlaying     = false;
let isPaused      = false;
let isFading      = false;

// Time tracking (for progress bar)
let trackStartAudioTime = 0;  // audioCtx.currentTime when track started / resumed
let trackStartOffset    = 0;  // seconds into the track when play/resume happened
let trackDuration       = 0;

// UI selection
let activeItemId = null;   // selected in playlist for editing

let progressTimer = null;

/* ══════════════════════════════════════════
   2. INDEXEDDB
══════════════════════════════════════════ */
let db;
const DB_NAME = 'SceneFlowDB2';
const DB_VER  = 1;

function initDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta'))  d.createObjectStore('meta',  { keyPath: 'key' });
    };
    req.onsuccess = e => { db = e.target.result; res(); };
    req.onerror   = () => rej(req.error);
  });
}

const idbTx = (store, mode = 'readonly') => db.transaction(store, mode).objectStore(store);

function idbPut(store, data)   { return new Promise((r,j) => { const q = idbTx(store,'readwrite').put(data); q.onsuccess=()=>r(); q.onerror=()=>j(q.error); }); }
function idbGet(store, key)    { return new Promise((r,j) => { const q = idbTx(store).get(key);  q.onsuccess=()=>r(q.result); q.onerror=()=>j(q.error); }); }
function idbDelete(store, key) { return new Promise((r,j) => { const q = idbTx(store,'readwrite').delete(key); q.onsuccess=()=>r(); q.onerror=()=>j(q.error); }); }

async function saveState() {
  await Promise.all([
    idbPut('meta', { key: 'library',  value: library  }),
    idbPut('meta', { key: 'playlist', value: playlist }),
  ]);
}

async function loadState() {
  const [lib, pl] = await Promise.all([
    idbGet('meta', 'library'),
    idbGet('meta', 'playlist'),
  ]);
  if (lib) library  = lib.value  || [];
  if (pl)  playlist = pl.value   || [];
}

async function getBlob(libId) {
  const rec = await idbGet('blobs', libId);
  if (!rec) throw new Error('Audio blob not found: ' + libId);
  return rec.blob;
}

/* ══════════════════════════════════════════
   3. AUDIO ENGINE
══════════════════════════════════════════ */
function ensureCtx() {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

async function decodeBlob(libId) {
  const blob   = await getBlob(libId);
  const arrBuf = await blob.arrayBuffer();
  return ensureCtx().decodeAudioData(arrBuf);
}

/** Start playing an AudioBuffer from `offset` seconds, with optional fade-in. */
function startSource(buffer, volume, loop, offset, fadeInDur, onended) {
  const ctx    = ensureCtx();
  const gain   = ctx.createGain();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop   = !!loop;
  source.connect(gain);
  gain.connect(ctx.destination);

  const now = ctx.currentTime;
  if (fadeInDur > 0) {
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + fadeInDur);
  } else {
    gain.gain.setValueAtTime(volume, now);
  }

  source.start(0, offset);
  if (!loop && onended) source.onended = onended;

  return { source, gain };
}

/** Fade out current gain over `dur` seconds. Returns promise that resolves after fade. */
function fadeOut(dur) {
  return new Promise(resolve => {
    if (!currentGain || dur <= 0) { resolve(); return; }
    const ctx = ensureCtx();
    const now = ctx.currentTime;
    currentGain.gain.cancelScheduledValues(now);
    currentGain.gain.setValueAtTime(currentGain.gain.value, now);
    currentGain.gain.linearRampToValueAtTime(0, now + dur);
    setTimeout(resolve, dur * 1000);
  });
}

/** Stop the currently playing source immediately (no fade). */
function stopCurrentSource() {
  if (currentSource) {
    currentSource.onended = null; // prevent auto-next trigger
    try { currentSource.stop(); } catch (_) {}
    currentSource = null;
  }
  currentGain = null;
  clearProgressTimer();
}

/** Full stop: stop source, reset state. */
function fullStop() {
  stopCurrentSource();
  isPlaying = false;
  isPaused  = false;
  isFading  = false;
  currentIdx = -1;
  trackStartOffset = 0;
  trackDuration   = 0;
  updatePlayBtn(false);
  updateNowPlaying(null, null);
  setProgress(0);
  setTimeDisp(null);
}

/* ══════════════════════════════════════════
   4. PLAYBACK LOGIC
══════════════════════════════════════════ */

/**
 * Play playlist item at `idx` from `offset` seconds.
 * `fadeInDur`: seconds for fade-in (0 = immediate).
 */
async function playAt(idx, offset = 0, fadeInDur = 0) {
  if (idx < 0 || idx >= playlist.length) return;

  const item = playlist[idx];
  const lib  = library.find(l => l.id === item.libId);
  if (!lib) { toast('找不到音樂檔案，可能已被刪除'); return; }

  stopCurrentSource();

  let buffer;
  try {
    buffer = await decodeBlob(item.libId);
  } catch (e) {
    toast('無法載入音樂：' + lib.name);
    return;
  }

  currentIdx = idx;
  isPlaying  = true;
  isPaused   = false;

  const vol = item.volume ?? 1;
  const { source, gain } = startSource(buffer, vol, item.repeat, offset, fadeInDur, () => {
    // Natural end of non-looping track → auto advance
    onTrackNaturalEnd();
  });

  currentSource         = source;
  currentGain           = gain;
  trackDuration         = buffer.duration;
  trackStartOffset      = offset;
  trackStartAudioTime   = ensureCtx().currentTime;

  updatePlayBtn(true);
  updateNowPlaying(idx, lib.name);
  renderPlaylist();   // update playing highlight
  startProgressTimer();
}

/** Called when a track finishes playing naturally (no user action). */
async function onTrackNaturalEnd() {
  if (isFading) return;
  const nextIdx = currentIdx + 1;
  if (nextIdx >= playlist.length) {
    fullStop();
    renderPlaylist();
    return;
  }
  // Auto-advance: use next track's fadeIn only, no explicit fadeOut (track already ended)
  stopCurrentSource();
  currentSource = null;
  currentGain   = null;
  const nextItem = playlist[nextIdx];
  await playAt(nextIdx, 0, nextItem.fadeIn || 0);
}

/**
 * Transition from current to `toIdx`:
 *   1. Fade out current track (using current track's fadeOut setting)
 *   2. Stop current
 *   3. Fade in next track (using next track's fadeIn setting)
 */
async function transitionTo(toIdx) {
  if (isFading) return;
  if (toIdx < 0 || toIdx >= playlist.length) return;

  isFading = true;

  // Fade out current (if playing)
  if (isPlaying && currentSource && currentGain) {
    const curItem   = playlist[currentIdx];
    const fadeOutDur = curItem?.fadeOut ?? 0;
    await fadeOut(fadeOutDur);
  }

  stopCurrentSource();
  currentSource = null;
  currentGain   = null;

  // Fade in next
  const nextItem   = playlist[toIdx];
  const fadeInDur  = nextItem?.fadeIn ?? 0;
  isFading = false;
  await playAt(toIdx, 0, fadeInDur);
}

/* ══════════════════════════════════════════
   5. PROGRESS TIMER
══════════════════════════════════════════ */
function startProgressTimer() {
  clearProgressTimer();
  progressTimer = setInterval(() => {
    if (!isPlaying || isPaused || !currentSource) return;
    const ctx     = ensureCtx();
    const elapsed = trackStartOffset + (ctx.currentTime - trackStartAudioTime);
    const dur     = trackDuration;
    if (dur > 0) setProgress(Math.min(elapsed / dur, 1));
    setTimeDisp(elapsed, dur);
  }, 250);
}

function clearProgressTimer() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

/* ══════════════════════════════════════════
   6. UI HELPERS
══════════════════════════════════════════ */
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function uid() { return Math.random().toString(36).slice(2, 11); }

function fmtTime(sec) {
  if (!sec || isNaN(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function updatePlayBtn(playing) {
  $('#btn-play .icon-play') .classList.toggle('hidden',  playing);
  $('#btn-play .icon-pause').classList.toggle('hidden', !playing);
}

function updateNowPlaying(idx, name) {
  $('#np-index').textContent = (idx !== null && idx >= 0) ? `#${idx + 1}` : '';
  $('#np-name').textContent  = name || '—';
}

function setProgress(pct) {
  const fill  = $('#progress-fill');
  const thumb = $('#progress-thumb');
  const p = Math.max(0, Math.min(1, pct)) * 100;
  fill.style.width  = p + '%';
  thumb.style.right = `calc(${100 - p}% - 6px)`;
}

function setTimeDisp(elapsed, dur) {
  const el = $('#time-disp');
  if (elapsed == null) { el.textContent = '—'; return; }
  el.textContent = dur > 0 ? `${fmtTime(elapsed)} / ${fmtTime(dur)}` : fmtTime(elapsed);
}

function fmtDur(sec) {
  if (!sec || isNaN(sec)) return '—';
  return fmtTime(sec);
}

async function getAudioDuration(blob) {
  return new Promise(res => {
    const url = URL.createObjectURL(blob);
    const a   = new Audio();
    a.src = url;
    a.onloadedmetadata = () => { URL.revokeObjectURL(url); res(a.duration); };
    a.onerror = () => { URL.revokeObjectURL(url); res(0); };
  });
}

/* ══════════════════════════════════════════
   7. RENDER: LIBRARY
══════════════════════════════════════════ */
function renderLibrary() {
  const list = $('#lib-list');
  $('#lib-count').textContent = library.length + ' 首';

  if (!library.length) {
    list.innerHTML = '<li class="list-empty">匯入音樂後顯示於此<br/>可拖曳至右方加入播放列表</li>';
    return;
  }

  list.innerHTML = library.map(item => `
    <li class="lib-item" draggable="true" data-lib-id="${item.id}">
      <div class="lib-icon">
        <svg viewBox="0 0 24 24"><path d="M9 18a3 3 0 1 1 0 .001A3 3 0 0 1 9 18zm0 0V8l9-3v10"/></svg>
      </div>
      <div class="lib-info">
        <div class="lib-info-name" title="${item.name}">${item.name}</div>
        <div class="lib-info-dur">${fmtDur(item.duration)}</div>
      </div>
      <button class="lib-add" data-lib-id="${item.id}" title="加入播放列表">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
      <button class="lib-del" data-lib-id="${item.id}" title="從庫中刪除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </li>
  `).join('');

  // Add to playlist
  $$('.lib-add').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await addToPlaylist(btn.dataset.libId);
    });
  });

  // Delete from library
  $$('.lib-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.libId;
      library = library.filter(l => l.id !== id);
      playlist = playlist.filter(p => p.libId !== id);
      await idbDelete('blobs', id);
      await saveState();
      renderLibrary();
      renderPlaylist();
      if (activeItemId && !playlist.find(p => p.id === activeItemId)) {
        activeItemId = null;
        renderEditor(null);
      }
    });
  });

  // Drag from library
  $$('.lib-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('libId', item.dataset.libId);
      e.dataTransfer.setData('src', 'library');
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
  });
}

async function addToPlaylist(libId) {
  const plItem = { id: uid(), libId, fadeIn: 0, fadeOut: 0, volume: 1, repeat: false };
  playlist.push(plItem);
  await saveState();
  renderPlaylist();
  // Auto-select for editing
  activeItemId = plItem.id;
  renderEditor(plItem);
  toast('已加入播放列表');
}

/* ══════════════════════════════════════════
   8. RENDER: PLAYLIST
══════════════════════════════════════════ */
function renderPlaylist() {
  const list = $('#pl-list');
  $('#pl-count').textContent = playlist.length + ' 首';

  if (!playlist.length) {
    list.innerHTML = '<li class="list-empty">從音樂庫拖曳歌曲至此，或點擊歌曲旁的「+」</li>';
    return;
  }

  list.innerHTML = playlist.map((item, i) => {
    const lib     = library.find(l => l.id === item.libId);
    const name    = lib?.name ?? '（已刪除）';
    const isActive  = item.id === activeItemId;
    const isPlay    = i === currentIdx && isPlaying;

    const foLabel = item.fadeOut > 0 ? `淡出 ${item.fadeOut.toFixed(1)}s` : null;
    const fiLabel = item.fadeIn  > 0 ? `淡入 ${item.fadeIn.toFixed(1)}s`  : null;
    const badges  = [
      foLabel ? `<span class="pl-badge has-val">${foLabel}</span>` : '',
      fiLabel ? `<span class="pl-badge has-val">${fiLabel}</span>` : '',
      item.repeat ? `<span class="pl-badge repeat">🔁</span>` : '',
    ].join('');

    return `
      <li class="pl-item ${isActive ? 'active' : ''} ${isPlay ? 'playing' : ''}"
          draggable="true" data-pl-id="${item.id}" data-pl-idx="${i}">
        <div class="pl-drag">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="9"  cy="5"  r="1" fill="currentColor"/>
            <circle cx="15" cy="5"  r="1" fill="currentColor"/>
            <circle cx="9"  cy="12" r="1" fill="currentColor"/>
            <circle cx="15" cy="12" r="1" fill="currentColor"/>
            <circle cx="9"  cy="19" r="1" fill="currentColor"/>
            <circle cx="15" cy="19" r="1" fill="currentColor"/>
          </svg>
        </div>
        <div class="pl-num">${i + 1}</div>
        <div class="pl-name" title="${name}">${name}</div>
        <div class="pl-badges">${badges}</div>
        <div class="pl-wave"><span></span><span></span><span></span></div>
        <button class="pl-remove" data-pl-id="${item.id}" title="從列表移除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </li>
    `;
  }).join('');

  // Click to select / edit
  $$('.pl-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.pl-remove') || e.target.closest('.pl-drag')) return;
      const id   = el.dataset.plId;
      const item = playlist.find(p => p.id === id);
      if (!item) return;
      activeItemId = id;
      renderPlaylist();
      renderEditor(item);
    });
    // Double-click: play from this track
    el.addEventListener('dblclick', async e => {
      if (e.target.closest('.pl-remove')) return;
      const idx = parseInt(el.dataset.plIdx, 10);
      isFading = false;
      const item = playlist[idx];
      await playAt(idx, 0, item.fadeIn || 0);
    });
  });

  // Remove from playlist
  $$('.pl-remove').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id  = btn.dataset.plId;
      const idx = playlist.findIndex(p => p.id === id);
      if (idx === currentIdx) fullStop();
      else if (idx < currentIdx) currentIdx--;
      playlist.splice(idx, 1);
      if (activeItemId === id) { activeItemId = null; renderEditor(null); }
      await saveState();
      renderPlaylist();
    });
  });

  // Drag-to-reorder
  setupPlaylistDnD();
}

function setupPlaylistDnD() {
  let dragFromIdx = null;

  $$('.pl-item').forEach((el, i) => {
    el.addEventListener('dragstart', e => {
      // If library drag is happening, ignore
      if (e.dataTransfer.getData('src') === 'library') return;
      dragFromIdx = i;
      e.dataTransfer.setData('src', 'playlist');
      e.dataTransfer.effectAllowed = 'move';
      el.style.opacity = '.4';
    });
    el.addEventListener('dragend', () => { el.style.opacity = ''; dragFromIdx = null; });

    el.addEventListener('dragover', e => {
      e.preventDefault();
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async e => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const src = e.dataTransfer.getData('src');

      if (src === 'library') {
        // Drop lib item into playlist at this position
        const libId = e.dataTransfer.getData('libId');
        if (!libId) return;
        const plItem = { id: uid(), libId, fadeIn: 0, fadeOut: 0, volume: 1, repeat: false };
        playlist.splice(i, 0, plItem);
        await saveState();
        activeItemId = plItem.id;
        renderPlaylist();
        renderEditor(plItem);
        return;
      }

      // Reorder
      if (dragFromIdx === null || dragFromIdx === i) return;
      const moved = playlist.splice(dragFromIdx, 1)[0];
      playlist.splice(i, 0, moved);
      // Keep currentIdx in sync
      if (isPlaying) {
        currentIdx = playlist.findIndex(p => p.id === moved.id);
        if (currentIdx < 0) currentIdx = i;
      }
      dragFromIdx = null;
      await saveState();
      renderPlaylist();
    });
  });

  // Allow drop on empty playlist
  const list = $('#pl-list');
  list.addEventListener('dragover', e => e.preventDefault());
  list.addEventListener('drop', async e => {
    e.preventDefault();
    if (e.target !== list) return; // handled by item already
    const src   = e.dataTransfer.getData('src');
    const libId = e.dataTransfer.getData('libId');
    if (src === 'library' && libId) {
      await addToPlaylist(libId);
    }
  });
}

/* ══════════════════════════════════════════
   9. RENDER: EDITOR (settings panel)
══════════════════════════════════════════ */
function renderEditor(item) {
  const placeholder = $('#settings-placeholder');
  const content     = $('#settings-content');

  if (!item) {
    placeholder.classList.remove('hidden');
    content.classList.add('hidden');
    return;
  }

  placeholder.classList.add('hidden');
  content.classList.remove('hidden');

  const lib = library.find(l => l.id === item.libId);
  $('#settings-song-name').textContent = lib?.name ?? '（未知）';

  // Bind sliders
  function bindRange(rangeId, valId, key, fmt) {
    const r = $('#' + rangeId);
    const v = $('#' + valId);
    r.value = item[key];
    v.textContent = fmt(item[key]);
    const clone = r.cloneNode(false);
    r.parentNode.replaceChild(clone, r);
    document.getElementById(rangeId).value = item[key];
    document.getElementById(rangeId).addEventListener('input', async e => {
      item[key] = parseFloat(e.target.value);
      document.getElementById(valId).textContent = fmt(item[key]);
      await saveState();
      renderPlaylist(); // refresh badges
      // Live volume update
      if (key === 'volume' && isPlaying && playlist[currentIdx]?.id === item.id && currentGain) {
        currentGain.gain.setValueAtTime(item.volume, ensureCtx().currentTime);
      }
    });
  }

  bindRange('fadeout-range', 'fadeout-val', 'fadeOut', v => v.toFixed(1) + 's');
  bindRange('fadein-range',  'fadein-val',  'fadeIn',  v => v.toFixed(1) + 's');
  bindRange('volume-range',  'volume-val',  'volume',  v => Math.round(v * 100) + '%');

  // Repeat toggle
  const repeatChk = $('#repeat-toggle');
  repeatChk.checked = !!item.repeat;
  const clone = repeatChk.cloneNode(true);
  repeatChk.parentNode.replaceChild(clone, repeatChk);
  document.getElementById('repeat-toggle').checked = !!item.repeat;
  document.getElementById('repeat-toggle').addEventListener('change', async e => {
    item.repeat = e.target.checked;
    await saveState();
    renderPlaylist();
    // Update looping if currently playing this track
    if (isPlaying && playlist[currentIdx]?.id === item.id && currentSource) {
      currentSource.loop = item.repeat;
    }
  });
}

/* ══════════════════════════════════════════
   10. FILE IMPORT
══════════════════════════════════════════ */
async function importFiles(files) {
  let count = 0;
  for (const file of files) {
    if (!file.type.startsWith('audio/')) continue;
    const id  = uid();
    const dur = await getAudioDuration(file);
    library.push({ id, name: file.name.replace(/\.[^.]+$/, ''), duration: dur });
    await idbPut('blobs', { id, blob: file });
    count++;
  }
  if (count) {
    await saveState();
    renderLibrary();
    toast(`已匯入 ${count} 首音樂 💾`);
  }
}

/* ══════════════════════════════════════════
   11. CONTROLS SETUP
══════════════════════════════════════════ */
function setupControls() {
  // ── Play / Pause ──
  $('#btn-play').addEventListener('click', async () => {
    const ctx = ensureCtx();

    if (isPlaying && !isPaused) {
      // → Pause
      await ctx.suspend();
      isPaused  = true;
      isPlaying = false;
      updatePlayBtn(false);
      clearProgressTimer();
      return;
    }

    if (isPaused && ctx.state === 'suspended') {
      // → Resume (AudioContext continues from where it was frozen)
      await ctx.resume();
      isPaused  = false;
      isPlaying = true;
      // Recalculate tracking so progress continues correctly
      trackStartAudioTime = ctx.currentTime - trackStartOffset;
      // Actually simpler: just reset reference
      // When we suspended at time T_suspend, elapsed was (T_suspend - trackStartAudioTime) + trackStartOffset
      // On resume, audioCtx.currentTime continues from T_suspend
      // So: trackStartOffset stays the same, trackStartAudioTime = ctx.currentTime - (last_elapsed - trackStartOffset)
      // Simplest: store last elapsed on pause
      updatePlayBtn(true);
      startProgressTimer();
      return;
    }

    // → Start from beginning (or from activeItemId)
    if (!playlist.length) { toast('請先新增歌曲到播放列表'); return; }
    let startIdx = 0;
    if (activeItemId) {
      const idx = playlist.findIndex(p => p.id === activeItemId);
      if (idx >= 0) startIdx = idx;
    }
    isFading = false;
    const item = playlist[startIdx];
    await playAt(startIdx, 0, item.fadeIn || 0);
  });

  // ── Stop ──
  $('#btn-stop').addEventListener('click', () => {
    // Resume context first if suspended, so stop() works
    if (audioCtx?.state === 'suspended') audioCtx.resume();
    fullStop();
    renderPlaylist();
  });

  // ── Prev ──
  $('#btn-prev').addEventListener('click', async () => {
    if (isFading) return;
    const targetIdx = Math.max(0, currentIdx > 0 ? currentIdx - 1 : 0);
    if (!isPlaying && !isPaused) {
      // Not playing: just select
      activeItemId = playlist[targetIdx]?.id;
      renderPlaylist();
      renderEditor(playlist[targetIdx]);
      return;
    }
    if (audioCtx?.state === 'suspended') await audioCtx.resume();
    isPaused = false;
    await transitionTo(targetIdx);
  });

  // ── Next ──
  $('#btn-next').addEventListener('click', async () => {
    if (isFading) return;
    const targetIdx = currentIdx + 1;
    if (targetIdx >= playlist.length) { toast('已是最後一首'); return; }
    if (!isPlaying && !isPaused) {
      activeItemId = playlist[targetIdx]?.id;
      renderPlaylist();
      renderEditor(playlist[targetIdx]);
      return;
    }
    if (audioCtx?.state === 'suspended') await audioCtx.resume();
    isPaused = false;
    await transitionTo(targetIdx);
  });

  // ── Import ──
  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async e => {
    await importFiles(e.target.files);
    e.target.value = '';
  });

  // ── Drag-and-drop files onto window ──
  const overlay = $('#drop-overlay');
  let counter = 0;
  document.addEventListener('dragenter', e => {
    if ([...e.dataTransfer.items].some(i => i.kind === 'file')) {
      counter++;
      overlay.classList.add('show');
    }
  });
  document.addEventListener('dragleave', () => {
    if (--counter <= 0) { counter = 0; overlay.classList.remove('show'); }
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', async e => {
    counter = 0; overlay.classList.remove('show');
    if (e.dataTransfer.files.length && !e.target.closest('.pl-list') && !e.target.closest('.pl-item')) {
      e.preventDefault();
      await importFiles(e.dataTransfer.files);
    }
  });

  // ── Progress bar seek ──
  $('#progress-wrap').addEventListener('click', e => {
    if (!isPlaying || trackDuration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct  = (e.clientX - rect.left) / rect.width;
    const offset = pct * trackDuration;
    // Restart from offset
    isFading = false;
    const item = playlist[currentIdx];
    if (item) playAt(currentIdx, offset, 0);
  });
}

/* ══════════════════════════════════════════
   12. INIT
══════════════════════════════════════════ */
async function init() {
  await initDB();
  await loadState();
  renderLibrary();
  renderPlaylist();
  renderEditor(null);
  setupControls();
  toast('SceneFlow 已載入 — 資料自動儲存 💾');
}

init();
