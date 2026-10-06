// VidSave – YouTube video/audio downloader backend. Drives yt-dlp (+ ffmpeg) as child processes
// and pushes progress to the page.
//
// Events pushed to the page:
//   'dl'    { id, state, ... }   per-download progress / result
//   'setup' { message }          install / update progress text

const dec = new TextDecoder();
const PLATFORM = tjs.system?.platform ?? tjs.platform ?? '';
const IS_WIN = PLATFORM === 'windows' || PLATFORM === 'win32' || tjs.env.OS === 'Windows_NT';
const IS_MAC = !IS_WIN && (PLATFORM === 'darwin' || (PLATFORM !== 'linux' && /^\/Users\//.test(tjs.env.HOME || '')));
const EXE = IS_WIN ? '.exe' : '';

// Apps opened from Finder get a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// so Homebrew / MacPorts tools are invisible unless we look there ourselves.
const MAC_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];

let APP = null;
const procs = new Map(); // download id -> { proc, cancelled }

// ---------- helpers ----------

function env() {
  const e = { ...tjs.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  if (IS_MAC) {
    const have = (e.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':');
    e.PATH = [...have, ...MAC_BIN_DIRS.filter((d) => !have.includes(d))].join(':');
    // Finder-launched apps may have no locale; yt-dlp then mangles non-ASCII titles.
    e.LANG ||= 'en_US.UTF-8';
  }
  return e;
}

// yt-dlp, ffmpeg, curl… are console programs: spawned from a GUI app, Windows
// flashes a terminal window for each one. app.spawnHidden runs them through
// the launcher with CREATE_NO_WINDOW (plain tjs.spawn elsewhere).
const spawn = (args, opts) => (APP?.spawnHidden ? APP.spawnHidden(args, opts) : tjs.spawn(args, opts));

async function exists(path) {
  try { await tjs.stat(path); return true; } catch { return false; }
}

// Stream -> callback per line (handles \r progress redraws too).
async function readLines(stream, onLine) {
  const r = stream.getReader();
  const d = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await r.read();
    if (done) break;
    buf += d.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/[\r\n]/)) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf.trim());
}

async function readAll(stream) {
  const r = stream.getReader();
  const parts = [];
  for (;;) {
    const { value, done } = await r.read();
    if (done) break;
    parts.push(dec.decode(value, { stream: true }));
  }
  parts.push(dec.decode());
  return parts.join('');
}

// Run a command to completion -> { code, out, err }. Rejects if it can't start.
async function run(args) {
  const p = spawn(args, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: env() });
  const [out, err, st] = await Promise.all([readAll(p.stdout), readAll(p.stderr), p.wait()]);
  return { code: st.exit_status, out, err };
}

async function tryRun(args) {
  try { return await run(args); } catch { return null; }
}

const isCertError = (text) => /CERTIFICATE_VERIFY_FAILED|CertificateVerifyError|SSL: /i.test(String(text));

// Turn a yt-dlp stderr dump into one readable message.
function friendlyError(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.startsWith('ERROR:'));
  const msg = (lines.pop() || String(text).trim().split(/\r?\n/).pop() || '@unknown')
    .replace(/^ERROR:\s*/, '');
  if (/HTTP Error 418|Blocked by/i.test(msg)) return '@blocked';
  if (/Sign in to confirm you.re not a bot/i.test(msg)) return '@bot';
  if (/Private video/i.test(msg)) return '@private';
  if (/Video unavailable|not available/i.test(msg)) return '@unavailable';
  if (/Sign in to confirm your age|age-restricted/i.test(msg)) return '@age';
  if (/members-only|Join this channel/i.test(msg)) return '@members';
  if (/Unsupported URL|is not a valid URL/i.test(msg)) return '@unsupported';
  // A wrong video id, or YouTube changed something and yt-dlp needs updating.
  if (/Failed to extract|Unable to extract|player response/i.test(msg)) return '@extract';
  if (/ffmpeg|ffprobe/i.test(msg) && /not (found|installed)/i.test(msg)) return '@ffmpeg';
  if (isCertError(msg)) return '@ssl';
  if (/getaddrinfo|Failed to resolve|timed out|Connection/i.test(msg)) return '@network';
  return msg;
}

// ---------- tool discovery ----------

const binDir = () => APP.paths.data + '/bin';
const managedYtdlp = () => binDir() + '/yt-dlp' + EXE;

let tools = null; // { ytdlp, ytdlpVersion, ytdlpManaged, ffmpeg, ffmpegDir }

async function findYtdlp() {
  const candidates = [managedYtdlp(), 'yt-dlp' + EXE];
  if (IS_MAC) candidates.push(...MAC_BIN_DIRS.map((d) => d + '/yt-dlp'));
  for (const c of candidates) {
    const r = await tryRun([c, '--version']);
    if (r && r.code === 0) return { path: c, version: r.out.trim(), managed: c === managedYtdlp() };
  }
  return null;
}

// yt-dlp needs both ffmpeg and ffprobe; a folder with only one doesn't count.
const works = async (exe) => (await tryRun([exe, '-version']))?.code === 0;

// Look for an ffmpeg the user already has before ever downloading one:
// our own copy, PATH, then the usual install spots on Windows
// (winget, Chocolatey, Scoop, manual C:\ffmpeg / Program Files).
// VIDSAVE_TEST_NO_SYSTEM_FFMPEG=1 skips everything but our own copy, to
// rehearse a clean machine.
async function findFfmpeg() {
  const pair = (d) => [d + '/ffmpeg' + EXE, d + '/ffprobe' + EXE];
  const own = pair(binDir());
  if (await exists(own[0]) && await exists(own[1]) && await works(own[0])) return { found: true, dir: binDir() };
  if (tjs.env.VIDSAVE_TEST_NO_SYSTEM_FFMPEG) return { found: false, dir: null };

  if (await works('ffmpeg' + EXE) && await works('ffprobe' + EXE)) return { found: true, dir: null };

  const dirs = [];
  if (IS_WIN) {
    const home = tjs.homeDir;
    const pf = tjs.env.ProgramFiles || 'C:/Program Files';
    const pd = tjs.env.ProgramData || 'C:/ProgramData';
    dirs.push(
      home + '/AppData/Local/Microsoft/WinGet/Links',
      pd + '/chocolatey/bin',
      home + '/scoop/shims',
      home + '/scoop/apps/ffmpeg/current/bin',
      'C:/ffmpeg/bin',
      pf + '/ffmpeg/bin',
    );
  } else {
    dirs.push(...MAC_BIN_DIRS, '/usr/bin');
  }
  for (const d of dirs) {
    const [ff, fp] = pair(d);
    if (await exists(ff) && await exists(fp) && await works(ff)) return { found: true, dir: d };
  }
  return { found: false, dir: null };
}

async function detect() {
  const [y, f] = await Promise.all([findYtdlp(), findFfmpeg()]);
  tools = {
    ytdlp: y?.path || null,
    ytdlpVersion: y?.version || null,
    ytdlpManaged: !!y?.managed,
    ffmpeg: f.found,
    ffmpegDir: f.dir,
  };
  return tools;
}

function ytdlpDownloadUrl() {
  const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
  if (IS_WIN) return base + 'yt-dlp.exe';
  return base + (IS_MAC ? 'yt-dlp_macos' : 'yt-dlp_linux');
}

// Make a downloaded program runnable: executable bit, and on macOS drop the
// quarantine flag so Gatekeeper doesn't block it (curl normally sets none).
async function makeRunnable(path) {
  if (IS_WIN) return;
  await tjs.chmod(path, 0o755);
  if (IS_MAC) await tryRun(['/usr/bin/xattr', '-d', 'com.apple.quarantine', path]);
}

// curl uses the OS certificate store (works behind filtering proxies).
async function fetchYtdlp() {
  await tjs.makeDir(binDir(), { recursive: true });
  const target = managedYtdlp();
  const tmp = target + '.new';
  APP.push('setup', { key: 'downloadingYtdlp' });
  const r = await tryRun(['curl' + EXE, '-L', '--fail', '--silent', '--show-error', '-o', tmp, ytdlpDownloadUrl()]);
  if (!r) throw new Error('@curlMissing');
  if (r.code !== 0) throw new Error('@downloadFailed|' + r.err.trim());
  if (await exists(target)) await tjs.remove(target);
  await tjs.rename(tmp, target);
  await makeRunnable(target);
  APP.push('setup', { key: '' });
}

// Windows builds of ffmpeg, smallest first; the second is the fallback.
// Each zip holds both ffmpeg.exe and ffprobe.exe.
const FFMPEG_URLS = [
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
];

// macOS builds come as one zip per program. Each source is a set of zips that
// must all download; the next source is the fallback. evermeet.cx is Intel
// only (runs on Apple Silicon through Rosetta), so it comes last there.
async function ffmpegSources() {
  if (IS_WIN) return FFMPEG_URLS.map((u) => [u]);
  const arm = (await tryRun(['/usr/sbin/sysctl', '-n', 'hw.optional.arm64']))?.out.trim() === '1';
  const riedl = (p) => `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arm ? 'arm64' : 'amd64'}/release/${p}.zip`;
  return [
    [riedl('ffmpeg'), riedl('ffprobe')],
    ['https://evermeet.cx/ffmpeg/getrelease/zip', 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip'],
  ];
}

// First folder under root (a few levels deep) holding the named file.
async function findDirWith(root, name, depth = 3) {
  if (await exists(root + '/' + name)) return root;
  if (depth <= 0) return null;
  for await (const e of await tjs.readDir(root)) {
    if (!e.isDirectory) continue;
    const d = await findDirWith(root + '/' + e.name, name, depth - 1);
    if (d) return d;
  }
  return null;
}

// Download with curl, pushing percent progress as 'setup' events.
async function curlWithProgress(url, out, key) {
  const p = spawn(['curl' + EXE, '-L', '--fail', '--progress-bar', '-o', out, url],
    { stdout: 'ignore', stderr: 'pipe', stdin: 'ignore', env: env() });
  let last = -1, errText = '';
  const onLine = (line) => {
    const m = /(\d+(?:\.\d+)?)%/.exec(line);
    if (m) {
      const pct = Math.floor(+m[1]);
      if (pct !== last) { last = pct; APP.push('setup', { key, pct }); }
    } else if (!/^#+$/.test(line)) {
      errText += line + '\n';
    }
  };
  const [, st] = await Promise.all([readLines(p.stderr, onLine), p.wait()]);
  if (st.exit_status !== 0) throw new Error('@downloadFailed|' + (errText.trim().split('\n').pop() || 'curl ' + st.exit_status));
}

// Install a private copy of ffmpeg + ffprobe into our bin folder. Nothing is
// installed system-wide and no admin rights are needed.
let ffmpegInstall = null;
function installFfmpegOnce() {
  ffmpegInstall ??= (async () => {
    try {
      if (!IS_WIN && !IS_MAC) throw new Error('@noPkgMgr');
      const work = APP.paths.cache + '/ffmpeg-setup';

      let lastErr;
      for (const zips of await ffmpegSources()) {
        await tjs.remove(work).catch(() => {});
        await tjs.makeDir(work, { recursive: true });
        try {
          for (let i = 0; i < zips.length; i++) await curlWithProgress(zips[i], work + `/ffmpeg-${i}.zip`, 'preparing');
          lastErr = null;
          break;
        } catch (e) { lastErr = e; }
      }
      if (lastErr) throw lastErr;

      // bsdtar unpacks zip on both systems: Windows 10+ ships it in System32
      // (full path, so a GNU tar from Git for Windows can't get in the way),
      // macOS as /usr/bin/tar.
      APP.push('setup', { key: 'preparing', pct: 100 });
      const tar = IS_WIN ? (tjs.env.SystemRoot || 'C:/Windows') + '/System32/tar.exe' : '/usr/bin/tar';
      const zipNames = [];
      for await (const e of await tjs.readDir(work)) if (e.name.endsWith('.zip')) zipNames.push(e.name);
      for (const name of zipNames) {
        const x = await tryRun([tar, '-xf', work + '/' + name, '-C', work]);
        if (!x || x.code !== 0) throw new Error('@installIncomplete|' + (x ? x.err.trim() : tar));
      }

      // Windows: one top folder (ffmpeg-<version>-…/bin/…); macOS: the bare programs.
      await tjs.makeDir(binDir(), { recursive: true });
      for (const f of ['ffmpeg' + EXE, 'ffprobe' + EXE]) {
        const dir = await findDirWith(work, f);
        if (!dir) throw new Error('@installIncomplete|' + f + ' not found in archive');
        const target = binDir() + '/' + f;
        if (await exists(target)) await tjs.remove(target);
        await tjs.copyFile(dir + '/' + f, target);
        await makeRunnable(target);
      }
      await tjs.remove(work).catch(() => {});
      const t = await detect();
      if (!t.ffmpeg) throw new Error('@installIncomplete|ffmpeg did not start');
      return t;
    } finally {
      APP.push('setup', { key: '' });
      ffmpegInstall = null;
    }
  })();
  return ffmpegInstall;
}

// ---------- yt-dlp args ----------

// yt-dlp ships its own CA bundle (certifi). Networks that inspect HTTPS
// (content filters, corporate proxies, some antivirus) re-sign traffic with a
// root that only the OS trusts. Default to standard behaviour; switch to the
// OS store automatically on the first certificate failure and remember it.
let useSystemCerts = false;

async function setSystemCerts(on) {
  useSystemCerts = !!on;
  try { await APP.store.set('useSystemCerts', useSystemCerts); } catch {}
}

function baseArgs() {
  // --encoding: otherwise Windows prints non-Latin titles/paths as '?'.
  const a = [tools.ytdlp, '--encoding', 'utf-8', '--no-colors', '--ignore-config'];
  if (useSystemCerts) a.push('--compat-options', 'no-certifi');
  if (tools.ffmpegDir) a.push('--ffmpeg-location', tools.ffmpegDir);
  return a;
}

function summarizeVideo(info) {
  const formats = info.formats || [];
  const audio = formats
    .filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none')
    .sort((a, b) => (b.abr || 0) - (a.abr || 0));
  const bestAudioSize = audio.length ? (audio[0].filesize || audio[0].filesize_approx || 0) : 0;

  const byHeight = new Map();
  for (const f of formats) {
    if (!f.height || !f.vcodec || f.vcodec === 'none') continue;
    const size = f.filesize || f.filesize_approx || 0;
    const cur = byHeight.get(f.height) || { height: f.height, fps: 0, size: 0, avc: false };
    cur.fps = Math.max(cur.fps, f.fps || 0);
    // Size estimate: prefer the H.264 stream (what MP4 downloads pick).
    const isAvc = /^avc/.test(f.vcodec);
    if (size && ((isAvc && (!cur.avc || size > cur.size)) || (!isAvc && !cur.avc && size > cur.size))) {
      cur.size = size;
      cur.avc = cur.avc || isAvc;
    }
    byHeight.set(f.height, cur);
  }
  const qualities = [...byHeight.values()]
    .sort((a, b) => b.height - a.height)
    .map(({ height, fps, size }) => ({ height, fps, size: size ? size + bestAudioSize : 0 }));

  const thumb = info.thumbnail
    || (info.thumbnails || []).slice(-1)[0]?.url
    || `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`;

  return {
    type: 'video',
    id: info.id,
    url: info.webpage_url || info.original_url,
    title: info.title,
    channel: info.channel || info.uploader || '',
    duration: info.duration || 0,
    views: info.view_count || 0,
    uploadDate: info.upload_date || '',
    isLive: !!info.is_live,
    thumbnail: thumb,
    qualities,
    subtitles: Object.keys(info.subtitles || {}),
  };
}

function summarizePlaylist(info) {
  const entries = (info.entries || []).filter(Boolean).map((e, i) => ({
    index: i + 1,
    id: e.id,
    title: e.title || e.id,
    duration: e.duration || 0,
    url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
    thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
    channel: e.channel || e.uploader || '',
  }));
  return {
    type: 'playlist',
    id: info.id,
    title: info.title || '',
    channel: info.channel || info.uploader || '',
    thumbnail: entries[0]?.thumbnail || '',
    entries,
  };
}

function buildDownloadArgs(o) {
  const a = baseArgs();
  a.push(
    '--newline', '--progress', '--no-playlist', '--no-mtime', '--no-simulate',
    '--progress-template',
    'download:@@P %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s',
    '--progress-template', 'postprocess:@@PP %(progress.postprocessor)s',
    '--print', 'before_dl:@@S %(filesize,filesize_approx)s',
    '--print', 'after_move:@@F %(filepath)s',
    '-P', o.outDir,
    // Partial files live in a private temp dir, removed after every run.
    '-P', 'temp:' + o.tempDir,
    '-o', o.template || '%(title)s.%(ext)s',
  );
  if (IS_WIN) a.push('--windows-filenames');

  if (o.mode === 'audio') {
    const fmt = o.audioFormat || 'mp3';
    a.push('-f', fmt === 'm4a' ? 'ba[ext=m4a]/ba/b' : 'ba/b', '-x', '--audio-format', fmt);
    // Only MP3 is re-encoded at a chosen bitrate. M4A/OPUS keep YouTube's own
    // stream untouched (yt-dlp copies them whatever quality is asked), and
    // FLAC/WAV are lossless.
    if (fmt === 'mp3') a.push('--audio-quality', (o.audioBitrate || '320') + 'K');
    if (o.embedThumb && fmt !== 'wav') a.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
  } else {
    const q = o.quality && o.quality !== 'best' ? ':' + o.quality : '';
    const container = o.container || 'mp4';
    const sort = container === 'mp4' ? `res${q},+codec:avc:m4a`
      : container === 'webm' ? `res${q},ext:webm:webm`
      : `res${q}`;
    a.push('-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', container);
    if (o.embedThumb && container !== 'webm') a.push('--embed-thumbnail');
    if (o.subs) a.push('--write-subs', '--sub-langs', o.subLangs || 'en.*', '--embed-subs');
    a.push('--embed-chapters');
  }
  if (o.embedMeta) a.push('--embed-metadata');
  if (o.sponsorblock) a.push('--sponsorblock-remove', 'sponsor,selfpromo,interaction');
  if (o.start || o.end) {
    a.push('--download-sections', `*${o.start || '0'}-${o.end || 'inf'}`, '--force-keyframes-at-cuts');
  }
  a.push('--', o.url);
  return a;
}

const num = (s) => (s === 'NA' || s === 'None' || s == null ? null : Number(s));

// All child processes under pid, deepest first (macOS / Linux).
async function descendants(pid) {
  const r = await tryRun(['/usr/bin/pgrep', '-P', String(pid)]);
  const kids = r?.code === 0 ? r.out.split(/\s+/).filter(Boolean).map(Number) : [];
  const all = [];
  for (const k of kids) all.push(...(await descendants(k)), k);
  return all;
}

// ---------- API ----------

export const api = {
  async status(_, app) {
    APP = app;
    try { useSystemCerts = !!(await app.store.get('useSystemCerts')); } catch {}
    await detect();
    return {
      ...tools, useSystemCerts, paths: app.paths,
      os: IS_WIN ? 'windows' : IS_MAC ? 'mac' : 'linux',
      canInstallFfmpeg: IS_WIN || IS_MAC,
    };
  },

  async setSystemCerts({ on }) {
    await setSystemCerts(on);
    return useSystemCerts;
  },

  async installYtdlp() {
    await fetchYtdlp();
    return detect();
  },

  // Re-download the latest release (works for the managed copy).
  async updateYtdlp() {
    const before = tools?.ytdlpVersion;
    await fetchYtdlp();
    const t = await detect();
    return { ...t, before };
  },

  // Re-checks first, so an ffmpeg the user installed meanwhile is used as is.
  async installFfmpeg() {
    const t = await detect();
    if (t.ffmpeg) return t;
    return installFfmpegOnce();
  },

  async probe({ url, noPlaylist }) {
    if (!tools?.ytdlp) throw new Error('@notInstalled');
    const a = baseArgs();
    a.push('-J', '--flat-playlist', '--no-warnings');
    if (noPlaylist) a.push('--no-playlist');
    a.push('--', url);
    const r = await run(a);
    if (r.code !== 0 || !r.out.trim()) {
      if (!useSystemCerts && isCertError(r.err)) {
        await setSystemCerts(true);
        APP.push('certs', { useSystemCerts: true });
        return api.probe({ url, noPlaylist });
      }
      throw new Error(friendlyError(r.err || r.out));
    }
    const info = JSON.parse(r.out);
    if (info._type === 'playlist') return summarizePlaylist(info);
    return summarizeVideo(info);
  },

  async start(o, app) {
    if (!tools?.ytdlp) throw new Error('@notInstalled');
    await tjs.makeDir(o.outDir, { recursive: true });
    const id = o.id;
    const push = (data) => app.push('dl', { id, ...data });
    const tempDir = app.paths.cache + '/partial/' + String(id).replace(/[^\w-]/g, '_');
    const cleanup = () => tjs.remove(tempDir).catch(() => {});

    const proc = spawn(buildDownloadArgs({ ...o, tempDir }),{ stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: env() });
    const job = { proc, cancelled: false };
    procs.set(id, job);

    // Overall progress across separate video + audio streams.
    let est = 0, doneBytes = 0, lastDl = 0, lastTotal = 0, file = null, errText = '';
    let lastPush = 0;

    const onLine = (line) => {
      if (line.startsWith('@@P ')) {
        const [dl, total, totalEst, speed, eta] = line.slice(4).split(' ').map(num);
        const t = total || totalEst || 0;
        if (dl != null && dl < lastDl) { doneBytes += lastTotal || lastDl; } // next stream
        lastDl = dl || 0; lastTotal = t;
        const overallTotal = Math.max(est, doneBytes + t);
        const pct = overallTotal ? Math.min(99.5, ((doneBytes + lastDl) / overallTotal) * 100) : null;
        const now = Date.now();
        if (now - lastPush > 200) {
          lastPush = now;
          push({ state: 'downloading', percent: pct, speed, eta, downloaded: doneBytes + lastDl, total: overallTotal || null });
        }
      } else if (line.startsWith('@@S ')) {
        est = num(line.slice(4)) || 0;
      } else if (line.startsWith('@@PP ')) {
        push({ state: 'processing', step: line.slice(5) });
      } else if (line.startsWith('@@F ')) {
        file = line.slice(4);
      } else if (line.startsWith('ERROR:')) {
        errText += line + '\n';
      } else if (isCertError(line)) {
        sawCertError = true;
      }
    };
    let sawCertError = false;

    push({ state: 'starting' });
    try {
      const [, , st] = await Promise.all([readLines(proc.stdout, onLine), readLines(proc.stderr, onLine), proc.wait()]);
      procs.delete(id);
      await cleanup();
      if (job.cancelled) return push({ state: 'cancelled' });
      if (st.exit_status === 0) return push({ state: 'done', file, percent: 100 });
      if (!useSystemCerts && (sawCertError || isCertError(errText))) {
        await setSystemCerts(true);
        app.push('certs', { useSystemCerts: true });
        return api.start(o, app);
      }
      push({ state: 'error', error: friendlyError(errText || '@exitCode|' + st.exit_status) });
    } catch (e) {
      procs.delete(id);
      await cleanup();
      push({ state: 'error', error: String(e.message || e) });
    }
  },

  async cancel({ id }) {
    const job = procs.get(id);
    if (!job) return false;
    job.cancelled = true;
    if (IS_WIN) {
      // yt-dlp.exe is a launcher + child; kill the whole tree.
      await tryRun(['taskkill', '/PID', String(job.proc.pid), '/T', '/F']);
    } else {
      // Same idea: yt-dlp's own child (and the ffmpeg it runs) go too.
      for (const pid of await descendants(job.proc.pid)) await tryRun(['/bin/kill', '-TERM', String(pid)]);
      try { job.proc.kill('SIGTERM'); } catch {}
    }
    return true;
  },

  async exists({ path }) {
    return exists(path);
  },
};

export function init(app) {
  APP = app;
}

export async function onWindowClosed(_, app) {
  for (const id of procs.keys()) await api.cancel({ id });
}
