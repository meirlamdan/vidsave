const $ = (id) => document.getElementById(id);
// Escape anything that goes into innerHTML — a video title like
// "<img src=x onerror=…>" must never become markup in a page that holds
// an RPC channel to the backend.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- formatting ----------

function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
function fmtDur(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : m;
  return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
}
const fmtEta = (s) => (s == null || !isFinite(s) ? '' : t('st.left', { t: fmtDur(Math.max(1, s)) }));
const fmtNum = (n) => Number(n).toLocaleString(LANG);
const pad = (n, w) => String(n).padStart(w, '0');
const sanitize = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120) || t('playlist');

// Join mixed-direction pieces (an English channel name in a Hebrew UI…) so
// each keeps its own order: wrap every piece in a Unicode direction isolate.
const isolate = (s) => '⁨' + s + '⁩';
const joinIsolated = (parts) => parts.filter(Boolean).map(isolate).join(' · ');

// One style for every quality/format option: "value (note) · size".
// The note is optional and only given where it actually helps.
const optionLabel = (value, note, size) =>
  [isolate(value) + (note ? ' (' + note + ')' : ''), size ? isolate('~' + size) : '']
    .filter(Boolean).join(' · ');

const VIDEO_NOTES = { 2160: '4K', 1440: '2K', 1080: 'Full HD', 720: 'HD' };

// Subtitle languages to request: the UI language plus English.
function subLangs() {
  const own = LANG === 'he' ? ['he.*', 'iw.*'] : LANG === 'en' ? [] : [LANG + '.*'];
  return [...own, 'en.*'].join(',');
}

// Complete video / Shorts / live / playlist links only, so a half-typed
// link never starts a load.
const YT_RE = new RegExp('^(https?://)?((www|m|music)\\.)?(' +
  'youtube\\.com/(watch\\?\\S*v=[\\w-]{11}|shorts/[\\w-]{11}|live/[\\w-]{11}|embed/[\\w-]{11}|playlist\\?\\S*list=[\\w-]{10,})' +
  '|youtu\\.be/[\\w-]{11})', 'i');
const isYouTube = (s) => YT_RE.test(String(s).trim());

// ---------- state ----------

const DEFAULTS = {
  mode: 'video', quality: 'best', container: 'mp4',
  audioFormat: 'mp3', audioBitrate: '320',
  embedThumb: true, embedMeta: true, subs: false, sponsorblock: false,
  concurrency: 2, notifyDone: true, autoPaste: true, plFolder: true,
  outDir: '', language: 'auto',
};
let settings = { ...DEFAULTS };
let tools = null;
let current = null;        // probe result on screen
let queue = [];            // download items
let history = [];
let tab = 'queue';
let lastClip = '';

const ACTIVE = new Set(['starting', 'downloading', 'processing']);

async function saveSettings() { try { await tiny.store.set('settings', settings); } catch {} }
async function saveHistory() { try { await tiny.store.set('history', history.slice(0, 300)); } catch {} }

// ---------- toast ----------

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- setup / components ----------

function banner(text, action, onClick) {
  $('setupBanner').classList.toggle('hidden', !text);
  $('setupText').textContent = text || '';
  const b = $('setupAction');
  b.classList.toggle('hidden', !action);
  b.textContent = action || '';
  b.onclick = onClick || null;
}

function renderTools() {
  if (!tools) return;
  $('ytdlpInfo').textContent = tools.ytdlp
    ? t('tools.version', { v: tools.ytdlpVersion }) + (tools.ytdlpManaged ? '' : ' ' + t('tools.system'))
    : t('tools.notInstalled');
  $('updateYtdlp').textContent = tools.ytdlp ? t('set.update') : t('set.install');
  $('ffmpegInfo').textContent = tools.ffmpeg ? t('tools.installed') : t('tools.ffmpegMissing');
  $('installFfmpeg').classList.toggle('hidden', tools.ffmpeg || ffmpegSetup === 'running' || !tools.canInstallFfmpeg);

  if (!tools.ytdlp) return;
  if (tools.ffmpeg) banner('');
  else if (ffmpegSetup === 'failed') {
    banner(t('banner.ffmpegFailed', { e: ffmpegError }), tools.canInstallFfmpeg ? t('tryAgain') : '', installFfmpeg);
  }
  // While running, the 'setup' progress events own the banner.
}

async function installYtdlp() {
  banner(t('banner.downloadingYtdlp'));
  try {
    tools = { ...tools, ...(await tiny.api.call('installYtdlp')) };
    toast(t('toast.ytdlpInstalled'));
  } catch (e) {
    banner(t('banner.ytdlpFailed', { e: tErr(e) }), t('tryAgain'), installYtdlp);
    return;
  }
  renderTools();
}

async function updateYtdlp() {
  const btn = $('updateYtdlp');
  btn.disabled = true;
  btn.textContent = t('updating');
  try {
    const r = await tiny.api.call(tools.ytdlp ? 'updateYtdlp' : 'installYtdlp');
    tools = { ...tools, ...r };
    toast(r.before && r.before === r.ytdlpVersion ? t('toast.upToDate') : t('toast.updatedTo', { v: r.ytdlpVersion }));
  } catch (e) {
    toast(t('toast.updateFailed', { e: tErr(e) }));
  }
  btn.disabled = false;
  renderTools();
}

// ffmpeg is set up by itself on first run (the backend first makes sure the
// user doesn't already have one). Downloads queued meanwhile wait for it.
let ffmpegSetup = 'idle';   // 'idle' | 'running' | 'failed'
let ffmpegError = '';

async function installFfmpeg() {
  if (ffmpegSetup === 'running') return;
  ffmpegSetup = 'running';
  banner(t('banner.preparing'));
  renderTools();
  renderQueue();
  try {
    const had = tools.ffmpeg;
    tools = { ...tools, ...(await tiny.api.call('installFfmpeg')) };
    ffmpegSetup = 'idle';
    if (!had) toast(t('toast.ready'));
  } catch (e) {
    ffmpegSetup = 'failed';
    ffmpegError = tErr(e);
  }
  showSetupBar(null);
  renderTools();
  pump();
}

function showSetupBar(pct) {
  $('setupBar').classList.toggle('hidden', pct == null);
  if (pct != null) $('setupBar').firstElementChild.style.width = pct + '%';
}

// Backend progress text arrives as a translation key (+ optional percent).
tiny.api.on('setup', ({ key, pct }) => {
  if (!key) return;
  banner(t('banner.' + key) + (pct != null ? ' ' + pct + '%' : ''));
  showSetupBar(pct ?? null);
});

// The backend switched to the OS certificate store after an SSL failure.
tiny.api.on('certs', ({ useSystemCerts }) => {
  tools.useSystemCerts = useSystemCerts;
  $('systemCerts').checked = useSystemCerts;
  toast(t('toast.certs'));
});

// ---------- app updates ----------

// Packaged builds check GitHub Releases ~5 s after launch (tinyjs.json
// "update"); the Settings button runs the same check on demand.
let appVersion = '';
let appUpdate = null;      // { latest, notes } while a newer version is offered

function renderAppInfo() {
  $('appInfo').textContent = appVersion ? t('tools.version', { v: appVersion }) : '—';
  if (appUpdate) $('updateText').textContent = t('upd.available', { v: appUpdate.latest });
}

function showAppUpdate({ latest, notes }) {
  appUpdate = { latest, notes };
  $('updateNotes').textContent = notes ? String(notes).split(/\r?\n/)[0] : '';
  $('updateNotes').title = notes || '';
  $('updateBanner').classList.remove('hidden');
  renderAppInfo();
}

async function checkAppUpdate() {
  const btn = $('checkAppUpdate');
  btn.disabled = true;
  btn.textContent = t('upd.checking');
  try {
    const r = await tiny.api.call('update.check');
    if (r.current) appVersion = r.current;
    if (r.available) showAppUpdate(r);
    else toast(t('upd.upToDate', { v: appVersion }));
  } catch (e) {
    toast(t('upd.failed', { e: tErr(e) }));
  }
  btn.disabled = false;
  btn.textContent = t('upd.check');
  renderAppInfo();
}

async function installAppUpdate() {
  if (queue.some((q) => ACTIVE.has(q.state))) {
    const ok = await confirmDialog(t('upd.confirmBusy'), '', t('upd.install'));
    if (!ok) return;
  }
  const btn = $('updateInstall');
  btn.disabled = true;
  btn.textContent = t('upd.installing');
  try {
    await tiny.api.call('update.install');   // relaunches into the new version
  } catch (e) {
    toast(t('upd.failed', { e: tErr(e) }));
    btn.disabled = false;
    btn.textContent = t('upd.install');
  }
}

tiny.api.on('update-available', showAppUpdate);

// ---------- probe ----------

// There are no buttons in the link bar: a valid YouTube link loads by itself,
// a spinner shows inside the field while it loads, and × clears everything.
let busy = false;
let probeSeq = 0;      // only the newest load may update the screen
let inputTimer;

const normUrl = (s) => {
  s = String(s ?? '').trim();
  return s && !/^https?:\/\//i.test(s) ? 'https://' + s : s;
};

function setBusy(on) {
  busy = on;
  updateUrlUi();
  render({ keepSelection: true });
}

function showError(msg) {
  $('probeError').textContent = msg || '';
  $('probeError').classList.toggle('hidden', !msg);
}

function showHint(on) {
  $('urlHint').classList.toggle('hidden', !on);
}

function updateUrlUi() {
  const v = $('url').value.trim();
  $('urlSpin').classList.toggle('hidden', !busy);
  $('clearUrl').classList.toggle('hidden', !v || busy);
}

// Back to the start screen: no preview, no options, no error.
function clearCurrent() {
  current = null;
  showError('');
  showHint(false);
  render();
  updateUrlUi();
}

function clearUrl() {
  clearTimeout(inputTimer);
  probeSeq++;            // drop any load still in flight
  setBusy(false);
  $('url').value = '';
  clearCurrent();
  $('url').focus();
}

// React to what is in the field (typing, pasting, Enter).
function onUrlChanged({ force = false, delay = 450 } = {}) {
  clearTimeout(inputTimer);
  showError('');
  showHint(false);
  updateUrlUi();
  const v = $('url').value.trim();
  if (!v) { if (current) clearCurrent(); return; }
  inputTimer = setTimeout(() => {
    if (isYouTube(v)) {
      if (force || !current || normUrl(v) !== current.sourceUrl) probe(v);
    } else {
      if (current) clearCurrent();
      // Only nag when it already looks like a link, not while still typing words.
      if (/^https?:\/\/|^www\.|\.\w{2,}\//i.test(v)) showHint(true);
    }
  }, delay);
}

async function probe(url, { noPlaylist } = {}) {
  url = normUrl(url ?? $('url').value);
  if (!url) return;
  if (!tools?.ytdlp) { toast(t('toast.settingUp')); return; }
  // Links that come from elsewhere (clipboard, drag & drop, history) fill the field.
  if (normUrl($('url').value) !== url) $('url').value = url;

  // A watch link inside a playlist: load just the video, offer the rest.
  let inPlaylist = false;
  try {
    const u = new URL(url);
    inPlaylist = u.searchParams.has('list') && u.searchParams.has('v');
  } catch {}
  if (noPlaylist === undefined) noPlaylist = inPlaylist;

  const my = ++probeSeq;
  showError('');
  showHint(false);
  setBusy(true);
  try {
    const info = await tiny.api.call('probe', { url, noPlaylist });
    if (my !== probeSeq) return;
    current = info;
    current.sourceUrl = url;
    current.inPlaylist = inPlaylist && noPlaylist;
    setBusy(false);
    render();
  } catch (e) {
    if (my !== probeSeq) return;
    current = null;
    setBusy(false);
    showError(tErr(e));
  } finally {
    if (my === probeSeq && busy) setBusy(false);
  }
}

function render({ keepSelection = false } = {}) {
  const c = current;
  // While a link loads, the loading card replaces whatever was on screen.
  $('loadingState').classList.toggle('hidden', !busy);
  $('emptyState').classList.toggle('hidden', !!c || busy);
  $('preview').classList.toggle('hidden', !c || busy);
  $('options').classList.toggle('hidden', !c || busy);
  $('playlist').classList.toggle('hidden', !c || busy || c.type !== 'playlist');
  if (!c || busy) return;

  $('pvThumb').src = c.thumbnail || '';
  $('pvTitle').textContent = c.title;
  $('loadPlaylistBtn').classList.toggle('hidden', !c.inPlaylist);

  if (c.type === 'video') {
    $('pvDur').textContent = c.isLive ? t('live') : fmtDur(c.duration);
    $('pvDur').classList.toggle('hidden', !c.duration && !c.isLive);
    const bits = [c.channel];
    if (c.views) bits.push(t('views', { n: fmtNum(c.views) }));
    const d = /^(\d{4})(\d{2})(\d{2})$/.exec(c.uploadDate || '');
    if (d) bits.push(new Date(+d[1], d[2] - 1, +d[3]).toLocaleDateString(LANG));
    $('pvMeta').textContent = joinIsolated(bits);
  } else {
    if (!c.title) c.title = t('playlist');
    $('pvTitle').textContent = c.title;
    $('pvDur').textContent = t('videosCount', { n: c.entries.length });
    $('pvDur').classList.remove('hidden');
    $('pvMeta').textContent = joinIsolated([c.channel, t('playlist')]);
    if (!keepSelection) renderPlaylist();
  }
  // A new link starts uncut: times picked for one video mean nothing for the next.
  if (!keepSelection) $('trimStart').value = $('trimEnd').value = '';
  renderTrim();
  renderQualities();
  renderMode();
}

function renderPlaylist() {
  $('plList').innerHTML = current.entries.map((e, i) => `
    <li data-i="${i}">
      <input type="checkbox" checked>
      <span class="n">${e.index}</span>
      <img loading="lazy" src="${esc(e.thumbnail)}" alt="">
      <span class="t" dir="auto" title="${esc(e.title)}">${esc(e.title)}</span>
      <span class="d">${esc(fmtDur(e.duration))}</span>
    </li>`).join('');
  $('plAll').checked = true;
  updatePlCount();
}

function selectedEntries() {
  return [...$('plList').querySelectorAll('li')]
    .filter((li) => li.querySelector('input').checked)
    .map((li) => current.entries[+li.dataset.i]);
}

function updatePlCount() {
  const n = selectedEntries().length;
  $('plCount').textContent = t('plSelected', { n, total: current.entries.length });
  $('downloadLbl').textContent = n ? t('downloadN', { n }) : t('download');
  $('downloadBtn').disabled = !n;
}

function renderQualities() {
  const sel = $('quality');
  const heights = current.type === 'video'
    ? (current.qualities || []).filter((q) => q.height >= 144) : [];
  let opts;
  if (heights.length) {
    // A single video: just its real resolutions, highest first and selected
    // by default ("highest" would only repeat the top entry).
    opts = heights.map((q) => {
      const fps = q.fps > 30 ? Math.round(q.fps) : '';
      return [String(q.height), optionLabel(`${q.height}p${fps}`, VIDEO_NOTES[q.height], fmtBytes(q.size))];
    });
  } else {
    // A playlist: each video has its own resolutions, so offer caps.
    opts = [['best', t('q.best')]];
    for (const h of [2160, 1440, 1080, 720, 480, 360]) opts.push([String(h), t('q.upTo', { h })]);
  }
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  sel.value = opts.some(([v]) => v === settings.quality) ? settings.quality : opts[0][0];
  if (current.type === 'video') {
    $('downloadLbl').textContent = t('download');
    $('downloadBtn').disabled = false;
  } else {
    updatePlCount();
  }
}

function renderMode() {
  const audio = settings.mode === 'audio';
  for (const b of $('modeSeg').children) b.classList.toggle('on', b.dataset.mode === settings.mode);
  $('videoOpts').classList.toggle('hidden', audio);
  $('audioOpts').classList.toggle('hidden', !audio);
  $('subsRow').classList.toggle('hidden', audio);
  renderBitrates();
}

// Audio quality: a plain word first, then the numbers and an estimated size
// for this video. Each piece is direction-isolated so "320 kbps" never flips
// in Hebrew/Arabic.
const BITRATES = [['320', 'br.high'], ['256', ''], ['192', 'br.standard'], ['128', 'br.small']];

// Only MP3 is converted at a chosen bitrate; M4A/OPUS keep YouTube's original
// audio and FLAC/WAV are lossless, so they get no bitrate choice.
function renderBitrates() {
  const isMp3 = settings.audioFormat === 'mp3';
  $('bitrateField').classList.toggle('hidden', !isMp3);
  if (!isMp3) return;
  const dur = current?.type === 'video' ? current.duration : 0;
  const opts = BITRATES.map(([kbps, key]) =>
    [kbps, optionLabel(kbps + ' kbps', key && t(key), dur ? fmtBytes((dur * kbps * 1000) / 8) : '')]);
  const sel = $('audioBitrate');
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  sel.value = opts.some(([v]) => v === settings.audioBitrate) ? settings.audioBitrate : '320';
}

// ---------- trim ----------

// "90", "1:30", "1:02:03" (a fraction on the seconds is fine) → seconds;
// an empty field → null; anything else → NaN.
function parseTime(s) {
  s = String(s ?? '').trim();
  if (!s) return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return NaN;
  const parts = s.split(':').map(Number);
  if (parts.slice(1).some((p) => p >= 60)) return NaN;
  return parts.reduce((a, p) => a * 60 + p, 0);
}
const fmtTime = (s) => fmtDur(s) || '0:00';

// Only a single, finished video has a known length to draw a timeline for.
const trimDur = () => (current?.type === 'video' && !current.isLive ? current.duration || 0 : 0);

// The two fields are the source of truth; the slider and the summary follow
// them. An end at or past the video's length means "to the end".
function readTrim() {
  const dur = trimDur();
  const start = parseTime($('trimStart').value);
  const end = parseTime($('trimEnd').value);
  let err = '', bad = '';
  if (Number.isNaN(start)) { err = t('trim.bad'); bad = 'trimStart'; }
  else if (Number.isNaN(end)) { err = t('trim.bad'); bad = 'trimEnd'; }
  else if (dur && start >= dur) { err = t('trim.over', { t: isolate(fmtDur(dur)) }); bad = 'trimStart'; }
  else if (end != null && end <= (start || 0)) { err = t('trim.order'); bad = 'trimEnd'; }
  return { start: start || 0, end: end != null && !(dur && end >= dur) ? end : null, err, bad, dur };
}

function renderTrim() {
  const { start, end, err, bad, dur } = readTrim();
  for (const id of ['trimStart', 'trimEnd']) $(id).classList.toggle('bad', id === bad);
  $('trimErr').textContent = err;
  $('trimErr').classList.toggle('hidden', !err);
  $('trimReset').classList.toggle('hidden', !$('trimStart').value && !$('trimEnd').value);

  const cut = start > 0 || end != null;
  const len = end != null ? end - start : dur ? dur - start : 0;
  $('trimLen').textContent = err ? ''
    : cut ? (len ? t('trim.len', { t: isolate(fmtTime(len)) }) : '')
    : dur ? t('trim.full', { t: isolate(fmtDur(dur)) }) : '';
  $('trimLen').classList.toggle('on', !err && cut && !!len);

  $('trimRange').classList.toggle('hidden', !dur);
  if (!dur) return;
  const max = Math.max(1, Math.ceil(dur));
  const a = $('trimStartR'), b = $('trimEndR');
  a.max = b.max = max;
  if (!err) { a.value = Math.round(start); b.value = end != null ? Math.round(end) : max; }
  $('trimFill').style.insetInlineStart = (a.value / max) * 100 + '%';
  $('trimFill').style.insetInlineEnd = (1 - b.value / max) * 100 + '%';
  // Two handles pushed to the far end: keep the start one on top so it can
  // still be dragged back.
  a.style.zIndex = +a.value > max / 2 ? 2 : '';
}

function onTrimSlider(e) {
  const a = $('trimStartR'), b = $('trimEndR'), max = +a.max;
  let s = +a.value, en = +b.value;
  // The handles never cross and keep at least a second between them.
  if (s > en - 1) {
    if (e.target === a) a.value = s = Math.max(0, en - 1);
    else b.value = en = Math.min(max, s + 1);
  }
  $('trimStart').value = s > 0 ? fmtTime(s) : '';
  $('trimEnd').value = en < max ? fmtTime(en) : '';
  renderTrim();
}

// Leaving a field tidies what was typed: "90" → "1:30", the very start or
// end of the video → empty (that is what an empty field means).
function tidyTrimField(el) {
  const v = parseTime(el.value);
  if (v == null || Number.isNaN(v) || v % 1) return;   // keep fractions as typed
  const dur = trimDur();
  const edge = el.id === 'trimStart' ? v === 0 : dur && v >= dur;
  el.value = edge ? '' : fmtTime(v);
}

// ↑/↓ nudge a field by a second, Shift by ten.
function onTrimKey(e) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const el = e.target, v = parseTime(el.value);
  if (Number.isNaN(v)) return;
  e.preventDefault();
  const dur = trimDur();
  let n = (v ?? (el.id === 'trimEnd' ? dur : 0)) + (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
  n = Math.max(0, dur ? Math.min(dur, n) : n);
  el.value = fmtTime(n);
  renderTrim();
}

function resetTrim() {
  $('trimStart').value = $('trimEnd').value = '';
  renderTrim();
}

// ---------- queue ----------

let seq = 0;
const newId = () => Date.now().toString(36) + '-' + (seq++);

function currentOptions() {
  const trim = readTrim();
  return {
    mode: settings.mode,
    quality: $('quality').value,
    container: settings.container,
    audioFormat: settings.audioFormat,
    audioBitrate: $('audioBitrate').value || settings.audioBitrate,
    embedThumb: settings.embedThumb,
    embedMeta: settings.embedMeta,
    subs: settings.subs,
    sponsorblock: settings.sponsorblock,
    subLangs: subLangs(),
    // Plain seconds, which yt-dlp reads; nothing when the whole video is kept.
    start: trim.start > 0 ? String(trim.start) : '',
    end: trim.end != null ? String(trim.end) : '',
  };
}

function labelFor(o) {
  if (o.mode === 'audio') {
    const fmt = o.audioFormat.toUpperCase();
    return o.audioFormat === 'mp3' ? `${fmt} ${o.audioBitrate}k` : fmt;
  }
  return `${o.container.toUpperCase()} ${o.quality === 'best' ? t('label.best') : o.quality + 'p'}`;
}

function enqueue() {
  if (!current) return;
  if (!settings.outDir) { toast(t('toast.chooseFolder')); return; }
  const trim = readTrim();
  if (trim.err) {
    $('trimStart').closest('details').open = true;
    $(trim.bad).focus();
    toast(trim.err);
    return;
  }
  const o = currentOptions();
  const label = labelFor(o);

  if (current.type === 'video') {
    queue.unshift(makeItem({ url: current.url || current.sourceUrl, title: current.title, thumbnail: current.thumbnail, duration: current.duration }, o, label, settings.outDir));
  } else {
    const entries = selectedEntries();
    if (!entries.length) return;
    const sep = tools.os === 'windows' ? '\\' : '/';
    const dir = settings.plFolder ? settings.outDir + sep + sanitize(current.title) : settings.outDir;
    const w = String(current.entries.length).length < 2 ? 2 : String(current.entries.length).length;
    // Keep playlist order in the queue (first video on top of this batch).
    const items = entries.map((e) => makeItem(e, o, label, dir,
      settings.plFolder ? `${pad(e.index, w)} - %(title)s.%(ext)s` : undefined));
    queue.unshift(...items);
  }
  setTab('queue');
  renderQueue();
  pump();
  toast(t('toast.added'));
}

function makeItem(src, opts, label, outDir, template) {
  return {
    id: newId(), url: src.url, title: src.title, thumbnail: src.thumbnail, duration: src.duration,
    opts, label, outDir, template,
    state: 'queued', percent: 0,
  };
}

function pump() {
  // Nearly every download needs ffmpeg: hold the queue while it is set up.
  if (ffmpegSetup === 'running') return renderQueue();
  const running = queue.filter((q) => ACTIVE.has(q.state)).length;
  let free = settings.concurrency - running;
  // Oldest queued first.
  for (let i = queue.length - 1; i >= 0 && free > 0; i--) {
    const it = queue[i];
    if (it.state !== 'queued') continue;
    it.state = 'starting';
    free--;
    tiny.api.call('start', { id: it.id, url: it.url, outDir: it.outDir, template: it.template, ...it.opts })
      .catch((e) => onProgress({ id: it.id, state: 'error', error: errText(e) }));
  }
  renderQueue();
}

function onProgress(d) {
  const it = queue.find((q) => q.id === d.id);
  if (!it) return;
  Object.assign(it, d);
  if (d.state === 'done') {
    history.unshift({
      id: it.id, title: it.title, thumbnail: it.thumbnail, url: it.url,
      label: it.label, file: it.file, date: Date.now(),
    });
    saveHistory();
    if (settings.notifyDone) {
      // Windows aligns each toast line by its first strong character, so a
      // Latin-first title sat left under a Hebrew heading. A leading mark in
      // the UI's direction keeps the whole banner one way.
      const mark = document.documentElement.dir === 'rtl' ? '‏' : '‎';
      try { tiny.notify(t('notify.done'), mark + it.title); } catch {}
    }
  }
  if (!ACTIVE.has(d.state)) pump();
  updateItem(it);
}

tiny.api.on('dl', onProgress);

async function cancelItem(it) {
  if (it.state === 'queued') {
    it.state = 'cancelled';
    updateItem(it);
    return;
  }
  await tiny.api.call('cancel', { id: it.id });
}

function retryItem(it) {
  Object.assign(it, { state: 'queued', percent: 0, error: null, speed: null, eta: null });
  queue = [it, ...queue.filter((q) => q !== it)];
  pump();
}

// ---------- rendering the lists ----------

const ICONS = {
  cancel: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  remove: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

function statusOf(it) {
  switch (it.state) {
    case 'queued': return [ffmpegSetup === 'running' ? t('st.waitingSetup') : t('st.waiting'), ''];
    case 'starting': return [t('st.starting'), ''];
    case 'downloading': {
      const p = it.percent != null ? Math.floor(it.percent) + '%' : '';
      const sz = it.total ? fmtBytes(it.downloaded) + ' / ' + fmtBytes(it.total) : '';
      const sp = it.speed ? fmtBytes(it.speed) + '/s' : '';
      return [[p, sz, sp, fmtEta(it.eta)].filter(Boolean).join(' · '), ''];
    }
    case 'processing': return [t('st.processing'), ''];
    case 'done': return [t('st.done'), 'ok'];
    case 'cancelled': return [t('st.cancelled'), ''];
    case 'error': return [it.error ? tErr(it.error) : t('st.failed'), 'err'];
  }
  return ['', ''];
}

function itemHTML(it) {
  const [st, cls] = statusOf(it);
  const active = ACTIVE.has(it.state) || it.state === 'queued';
  const indet = it.state === 'starting' || it.state === 'processing' || (it.state === 'downloading' && it.percent == null);
  const barCls = indet ? 'indet' : it.state === 'done' ? 'ok' : '';
  const pct = it.state === 'done' ? 100 : (it.percent || 0);
  const acts = [];
  if (active) acts.push(['cancel', t('act.cancel')]);
  if (it.state === 'done' && it.file) acts.push(['open', t('act.open')], ['folder', t('act.folder')]);
  if (it.state === 'error' || it.state === 'cancelled') acts.push(['retry', t('act.retry')]);
  if (!active) acts.push(['remove', t('act.remove')]);
  return `
    <li class="item" data-id="${esc(it.id)}">
      <img src="${esc(it.thumbnail || '')}" alt="">
      <div class="body">
        <div class="title" dir="auto" title="${esc(it.title)}">${esc(it.title)}</div>
        ${it.state === 'done' || it.state === 'cancelled' || it.state === 'error' ? '' :
          `<div class="bar ${barCls}"><i style="width:${pct}%"></i></div>`}
        <div class="meta"><span class="tag">${esc(it.label)}</span><span class="st ${cls}">${esc(st)}</span></div>
      </div>
      <div class="acts">${acts.map(([a, t]) => `<button data-act="${a}" title="${esc(t)}">${ICONS[a]}</button>`).join('')}</div>
    </li>`;
}

function historyHTML(h) {
  const when = new Date(h.date).toLocaleString(LANG, { dateStyle: 'short', timeStyle: 'short' });
  return `
    <li class="item" data-id="${esc(h.id)}">
      <img src="${esc(h.thumbnail || '')}" alt="">
      <div class="body">
        <div class="title" dir="auto" title="${esc(h.title)}">${esc(h.title)}</div>
        <div class="meta"><span class="tag">${esc(h.label)}</span><span class="st">${esc(when)}</span></div>
      </div>
      <div class="acts">
        <button data-act="open" title="${esc(t('act.open'))}">${ICONS.open}</button>
        <button data-act="folder" title="${esc(t('act.folder'))}">${ICONS.folder}</button>
        <button data-act="link" title="${esc(t('act.link'))}">${ICONS.link}</button>
        <button data-act="remove" title="${esc(t('act.removeHistory'))}">${ICONS.remove}</button>
      </div>
    </li>`;
}

function renderQueue() {
  $('queueList').innerHTML = queue.map(itemHTML).join('');
  $('historyList').innerHTML = history.map(historyHTML).join('');
  const active = queue.filter((q) => ACTIVE.has(q.state) || q.state === 'queued').length;
  $('queueCount').textContent = active || '';
  const empty = tab === 'queue' ? !queue.length : !history.length;
  $('listEmpty').classList.toggle('hidden', !empty);
  $('listEmpty').textContent = tab === 'queue' ? t('empty.queue') : t('empty.history');
  updateTitle();
}

// Patch a single row instead of re-rendering the whole list on each tick.
function updateItem(it) {
  const li = $('queueList').querySelector(`[data-id="${CSS.escape(it.id)}"]`);
  if (!li) return renderQueue();
  const tmp = document.createElement('ul');
  tmp.innerHTML = itemHTML(it);
  li.replaceWith(tmp.firstElementChild);
  if (!ACTIVE.has(it.state)) renderQueue();
  else updateTitle();
}

function updateTitle() {
  const act = queue.filter((q) => ACTIVE.has(q.state));
  const APP_TITLE = 'VidSave – Video & Audio Downloader';
  let title = APP_TITLE;
  if (act.length) {
    const pct = Math.floor(act.reduce((s, q) => s + (q.percent || 0), 0) / act.length);
    title = t('title.downloading', { p: pct, n: act.length }) + ' — VidSave';
  }
  if (document.title !== title) {
    document.title = title;
    try { tiny.win.setTitle(title); } catch {}
  }
}

function setTab(t) {
  tab = t;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.tab === t);
  $('queueList').classList.toggle('hidden', t !== 'queue');
  $('historyList').classList.toggle('hidden', t !== 'history');
  renderQueue();
}

async function openPath(file, reveal) {
  if (!file) return;
  try {
    if (!(await tiny.api.call('exists', { path: file }))) { toast(t('toast.fileMissing')); return; }
    if (reveal) await tiny.app.shell.reveal(file);
    else await tiny.app.shell.open(file);
  } catch (e) {
    toast(tErr(e));
  }
}

// ---------- clipboard / drop ----------

async function pasteFromClipboard(auto) {
  let text = '';
  try {
    const c = await tiny.clipboard.read();
    text = c?.text || '';
  } catch {
    try { text = await navigator.clipboard.readText(); } catch {}
  }
  text = text.trim();
  if (!isYouTube(text)) {
    if (!auto) toast(t('toast.noLink'));
    return;
  }
  if (auto && (text === lastClip || text === $('url').value.trim())) return;
  lastClip = text;
  $('url').value = text;
  probe(text);
}

// ---------- confirm dialog ----------

// In-page replacement for tiny.dialog.confirm: the native one looks like a
// stock Windows box and ignores the custom OK label. Esc / backdrop = cancel.
function confirmDialog(message, detail, okLabel) {
  const dlg = $('confirmDlg');
  $('confirmMsg').textContent = message;
  $('confirmDetail').textContent = detail || '';
  $('confirmOk').textContent = okLabel || 'OK';
  dlg.returnValue = 'cancel';
  dlg.showModal();
  $('confirmCancel').focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

// ---------- settings drawer ----------

function openDrawer(open) {
  $('drawer').classList.toggle('open', open);
  $('drawer').setAttribute('aria-hidden', String(!open));
  $('scrim').classList.toggle('hidden', !open);
}

function bindSetting(id, key, { type = 'value', after } = {}) {
  const el = $(id);
  const v = settings[key];
  if (type === 'checked') el.checked = !!v; else el.value = String(v);
  el.addEventListener('change', () => {
    settings[key] = type === 'checked' ? el.checked : type === 'number' ? +el.value : el.value;
    saveSettings();
    after?.();
  });
}

// ---------- wiring ----------

function wire() {
  // Enter reloads even the same link (e.g. after a network error).
  $('urlForm').addEventListener('submit', (e) => { e.preventDefault(); onUrlChanged({ force: true, delay: 0 }); });
  $('clearUrl').addEventListener('click', clearUrl);
  $('url').addEventListener('input', () => onUrlChanged());
  // A pasted link loads at once; typing waits for a short pause.
  $('url').addEventListener('paste', () => setTimeout(() => {
    lastClip = $('url').value.trim();
    onUrlChanged({ delay: 0 });
  }, 0));
  $('url').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('url').value) { e.stopPropagation(); clearUrl(); }
  });
  $('loadPlaylistBtn').addEventListener('click', () => probe(current.sourceUrl, { noPlaylist: false }));

  $('modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.mode = b.dataset.mode;
    saveSettings();
    renderMode();
  });

  bindSetting('container', 'container');
  bindSetting('audioFormat', 'audioFormat', { after: renderMode });
  bindSetting('audioBitrate', 'audioBitrate');
  bindSetting('embedThumb', 'embedThumb', { type: 'checked' });
  bindSetting('embedMeta', 'embedMeta', { type: 'checked' });
  bindSetting('subs', 'subs', { type: 'checked' });
  bindSetting('sponsor', 'sponsorblock', { type: 'checked' });
  bindSetting('concurrency', 'concurrency', { type: 'number', after: pump });
  bindSetting('notifyDone', 'notifyDone', { type: 'checked' });
  bindSetting('autoPaste', 'autoPaste', { type: 'checked' });
  bindSetting('plFolder', 'plFolder', { type: 'checked' });
  // Picking the top entry means "always the highest", not that exact number.
  $('quality').addEventListener('change', () => {
    settings.quality = $('quality').selectedIndex === 0 ? 'best' : $('quality').value;
    saveSettings();
  });

  $('plList').addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    if (e.target.tagName !== 'INPUT') {
      const cb = li.querySelector('input');
      cb.checked = !cb.checked;
    }
    const all = [...$('plList').querySelectorAll('input')];
    $('plAll').checked = all.every((c) => c.checked);
    updatePlCount();
  });
  $('plAll').addEventListener('change', () => {
    for (const c of $('plList').querySelectorAll('input')) c.checked = $('plAll').checked;
    updatePlCount();
  });

  $('changeDir').addEventListener('click', async () => {
    const dir = await tiny.dialog.pickFolder();
    if (!dir) return;
    settings.outDir = dir;
    $('outDir').textContent = dir;
    $('outDir').title = dir;
    saveSettings();
  });
  $('outDir').addEventListener('click', () => settings.outDir && tiny.app.shell.open(settings.outDir).catch(() => {}));

  $('downloadBtn').addEventListener('click', enqueue);
  for (const id of ['trimStartR', 'trimEndR']) $(id).addEventListener('input', onTrimSlider);
  for (const id of ['trimStart', 'trimEnd']) {
    $(id).addEventListener('input', renderTrim);
    $(id).addEventListener('keydown', onTrimKey);
    $(id).addEventListener('change', (e) => { tidyTrimField(e.target); renderTrim(); });
  }
  $('trimReset').addEventListener('click', resetTrim);
  // A click on the dialog element itself (not its form) is the backdrop.
  $('confirmDlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('clearBtn').addEventListener('click', async () => {
    if (tab === 'queue') {
      queue = queue.filter((q) => ACTIVE.has(q.state) || q.state === 'queued');
    } else {
      if (!history.length) return;
      if (!(await confirmDialog(t('confirm.clearHistory'), t('confirm.clearHistoryDetail'), t('clear')))) return;
      history = [];
      saveHistory();
    }
    renderQueue();
  });

  $('queueList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const it = queue.find((q) => q.id === b.closest('li').dataset.id);
    if (!it) return;
    const act = b.dataset.act;
    if (act === 'cancel') cancelItem(it);
    if (act === 'retry') retryItem(it);
    if (act === 'open') openPath(it.file, false);
    if (act === 'folder') openPath(it.file, true);
    if (act === 'remove') { queue = queue.filter((q) => q !== it); renderQueue(); }
  });
  $('queueList').addEventListener('dblclick', (e) => {
    const li = e.target.closest('li');
    const it = li && queue.find((q) => q.id === li.dataset.id);
    if (it?.state === 'done') openPath(it.file, false);
  });

  $('historyList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const h = history.find((x) => x.id === b.closest('li').dataset.id);
    if (!h) return;
    const act = b.dataset.act;
    if (act === 'open') openPath(h.file, false);
    if (act === 'folder') openPath(h.file, true);
    if (act === 'link') { $('url').value = h.url; probe(h.url); }
    if (act === 'remove') { history = history.filter((x) => x !== h); saveHistory(); renderQueue(); }
  });

  const langSel = $('language');
  langSel.innerHTML = `<option value="auto">${esc(t('set.langAuto'))}</option>` +
    Object.entries(LANGS).map(([code, name]) => `<option value="${code}">${esc(name)}</option>`).join('');
  langSel.value = settings.language;
  langSel.addEventListener('change', () => {
    settings.language = langSel.value;
    saveSettings();
    setLang(settings.language === 'auto' ? null : settings.language);
    langSel.options[0].textContent = t('set.langAuto');
    renderTools();
    renderAppInfo();
    renderQueue();
    if (current) render({ keepSelection: true });
    else renderMode();
  });

  $('settingsBtn').addEventListener('click', () => openDrawer(true));
  $('closeDrawer').addEventListener('click', () => openDrawer(false));
  $('scrim').addEventListener('click', () => openDrawer(false));
  $('systemCerts').addEventListener('change', async () => {
    tools.useSystemCerts = await tiny.api.call('setSystemCerts', { on: $('systemCerts').checked });
  });
  $('updateYtdlp').addEventListener('click', updateYtdlp);
  $('installFfmpeg').addEventListener('click', installFfmpeg);
  $('checkAppUpdate').addEventListener('click', checkAppUpdate);
  $('updateInstall').addEventListener('click', installAppUpdate);
  $('updateDismiss').addEventListener('click', () => $('updateBanner').classList.add('hidden'));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') openDrawer(false);
    // Ctrl+V anywhere outside a text field: paste a link and load it.
    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !inField) {
      e.preventDefault();
      pasteFromClipboard(false);
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      $('url').focus();
      $('url').select();
    }
  });

  // Drag a link from the browser onto the window.
  const bar = $('urlForm');
  document.addEventListener('dragover', (e) => { e.preventDefault(); bar.classList.add('drag'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) bar.classList.remove('drag'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    bar.classList.remove('drag');
    const text = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split(/\r?\n/)[0].trim();
    if (text) { $('url').value = text; probe(text); }
  });

  // Picking up a copied link when the window comes back into focus.
  window.addEventListener('focus', () => { if (settings.autoPaste) pasteFromClipboard(true); });
}

async function init() {
  try { settings = { ...DEFAULTS, ...((await tiny.store.get('settings')) || {}) }; } catch {}
  try { history = (await tiny.store.get('history')) || []; } catch {}

  setLang(settings.language === 'auto' ? null : settings.language);
  wire();

  tools = await tiny.api.call('status');
  if (!settings.outDir) settings.outDir = tools.paths.downloads || tools.paths.home;
  if (tools.os === 'windows') settings.outDir = settings.outDir.replace(/\//g, '\\');
  saveSettings();
  $('outDir').textContent = settings.outDir;
  $('outDir').title = settings.outDir;
  $('systemCerts').checked = !!tools.useSystemCerts;

  renderTools();
  renderQueue();
  render();
  updateUrlUi();
  tiny.api.call('app.info').then((i) => { appVersion = i?.version || ''; renderAppInfo(); }, () => renderAppInfo());

  if (!tools.ytdlp) await installYtdlp();
  // First run without a usable ffmpeg: set one up in the background, no click.
  if (tools.ytdlp && !tools.ffmpeg && tools.canInstallFfmpeg) installFfmpeg();
  $('url').focus();
  if (settings.autoPaste) pasteFromClipboard(true);
}

init().catch((e) => banner(t('startupError', { e: tErr(e) })));
