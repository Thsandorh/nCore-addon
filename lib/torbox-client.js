'use strict';

const { fetch } = require('./fetch');

const API_BASE   = 'https://api.torbox.app';
const VIDEO_EXTS = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.mpg', '.mpeg', '.ts', '.m2ts'];

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function makeForm(fields) {
  let fd;
  if (typeof FormData !== 'undefined') {
    fd = new FormData();
  } else {
    fd = new (require('undici').FormData)(); // eslint-disable-line global-require
  }
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  return fd;
}

async function apiCall({ path, method = 'GET', apiKey, query = {}, body }) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  console.log(`[TorBox] ${method} ${url}`);

  const res  = await fetch(url, { method, headers: { authorization: `Bearer ${apiKey}` }, body, redirect: 'manual' });
  const text = await res.text();

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const detail = data?.detail || data?.error || data?.message || text.slice(0, 200);
    const err    = new Error(`TorBox ${res.status}: ${detail}`);
    err.status   = res.status;
    err.data     = data;
    console.log(`[TorBox] HTTP ${res.status} – ${path}:`, JSON.stringify(data).slice(0, 400));
    throw err;
  }

  return data;
}

// ---------------------------------------------------------------------------
// API műveletek
// ---------------------------------------------------------------------------

async function addTorrent({ apiKey, magnet }) {
  // FIGYELEM: csak a TorBox által elfogadott mezőket küldjük.
  // A `seed` NEM érvényes paraméter → az API visszautasítaná a kérést!
  return apiCall({
    path: '/v1/api/torrents/createtorrent', method: 'POST', apiKey,
    body: makeForm({ magnet, allow_zip: 'false', as_queued: 'false' }),
  });
}

async function getMyTorrents({ apiKey }) {
  const data = await apiCall({
    path: '/v1/api/torrents/mylist', method: 'GET', apiKey,
    query: { bypass_cache: 'true', limit: '1000', offset: '0' },
  });
  return Array.isArray(data?.data) ? data.data : [];
}

async function getDownloadLink({ apiKey, torrentId, fileId }) {
  const data = await apiCall({
    path: '/v1/api/torrents/requestdl', method: 'GET', apiKey,
    query: { token: apiKey, torrent_id: torrentId, file_id: fileId, redirect: 'false', zip_link: 'false' },
  });
  return pickUrl(data);
}

async function checkCached({ apiKey, infoHashes }) {
  const hashes = (infoHashes || []).map(h => String(h || '').toLowerCase()).filter(h => /^[a-f0-9]{40}$/.test(h));
  if (!hashes.length) return new Map();
  try {
    const data = await apiCall({
      path: '/v1/api/torrents/checkcached', method: 'GET', apiKey,
      query: { hash: hashes.join(','), format: 'list', list_files: 'false' },
    });
    const set = new Set((Array.isArray(data?.data) ? data.data : []).map(h => String(h).toLowerCase()));
    return new Map(hashes.map(h => [h, set.has(h)]));
  } catch {
    // Hiba esetén null (ismeretlen) – ne blokkoljuk az uncached flow-t false-szal
    return new Map(hashes.map(h => [h, null]));
  }
}

// ---------------------------------------------------------------------------
// Segédfüggvények
// ---------------------------------------------------------------------------

function pickUrl(data) {
  for (const v of [data?.data?.url, data?.data?.link, data?.url, data?.link, data?.data]) {
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
  }
  return '';
}

function infoHashFromMagnet(magnet) {
  const m = String(magnet || '').match(/xt=urn:btih:([a-f0-9]{40})/i);
  return m ? m[1].toLowerCase() : '';
}

function findTorrent(list, hash) {
  const t = String(hash || '').toLowerCase();
  return list.find(item => {
    if (String(item?.hash || item?.info_hash || '').toLowerCase() === t) return true;
    return infoHashFromMagnet(item?.magnet || item?.magnet_url || '') === t;
  }) || null;
}

function getTorrentId(t) {
  const v = t?.torrent_id ?? t?.torrentId ?? t?.id ?? t?.data?.torrent_id ?? t?.data?.id;
  return v != null ? String(v) : '';
}

function getTorrentState(t) {
  return String(t?.download_state || t?.state || t?.status || '').toLowerCase();
}

function getTorrentProgress(t) {
  const v = Number(t?.progress ?? t?.download_progress ?? t?.percent ?? 0);
  return Number.isFinite(v) ? Math.round(Math.min(100, Math.max(0, v))) : 0;
}

function isTorrentReady(t) {
  if (t?.download_finished || t?.download_present) return true;
  const s = getTorrentState(t);
  return s.includes('complet') || s.includes('finish') || s.includes('seeding') || s.includes('ready');
}

function getFiles(t) {
  if (Array.isArray(t?.files))       return t.files;
  if (Array.isArray(t?.data?.files)) return t.data.files;
  return [];
}

function pickFileId(torrent, preferredName, season, episode) {
  const files  = getFiles(torrent);
  const videos = files
    .map(f => ({
      id:   String(f?.id ?? f?.file_id ?? f?.fileId ?? ''),
      name: String(f?.short_name || f?.name || f?.filename || f?.path || ''),
      size: Number(f?.size ?? f?.bytes ?? 0) || 0,
    }))
    .filter(f => f.id && VIDEO_EXTS.some(e => f.name.toLowerCase().endsWith(e)));

  if (!videos.length) return null;

  if (season && episode) {
    const ss = String(season).padStart(2, '0');
    const ee = String(episode).padStart(2, '0');
    const hit = videos.filter(f => {
      const n     = f.name.toLowerCase();
      const match = new RegExp(`\\bs${ss}\\s*[._-]?e${ee}\\b`, 'i').test(n)
        || new RegExp(`\\b${season}\\s*x\\s*0*${episode}\\b`, 'i').test(n);
      const range = new RegExp(`\\bs${ss}\\s*[._-]?e${ee}\\s*[-e]\\d+\\b`, 'i').test(n);
      return match && !range;
    });
    return hit.length ? hit.sort((a, b) => b.size - a.size)[0].id : null;
  }

  if (preferredName) {
    const pref  = preferredName.toLowerCase();
    const exact = videos.find(f => {
      const n = f.name.toLowerCase();
      return n === pref || n.endsWith(pref) || pref.endsWith(n);
    });
    if (exact) return exact.id;
  }

  return videos.sort((a, b) => b.size - a.size)[0].id;
}

// ---------------------------------------------------------------------------
// resolveLink – minden esetet kezel: cached, uncached, töltés alatt
// ---------------------------------------------------------------------------

async function resolveLink({ apiKey, magnet, infoHash, preferredFile, season, episode, maxWaitMs = 15000 }) {
  const hash     = String(infoHash || infoHashFromMagnet(magnet) || '').toLowerCase();
  const deadline = Date.now() + Math.max(5000, maxWaitMs);

  // 1. Mylist ellenőrzés – ha már bent van (akár tölt, akár kész), megpróbáljuk
  let tId = '';
  try {
    const list  = await getMyTorrents({ apiKey });
    const found = findTorrent(list, hash);
    if (found) {
      tId = getTorrentId(found);
      const files  = getFiles(found);
      const state  = getTorrentState(found);
      const pct    = getTorrentProgress(found);
      console.log(`[TorBox] Mylist-ben van: ${state} ${pct}% (id=${tId}, fájlok=${files.length})`);

      if (files.length > 0) {
        const fileId = pickFileId(found, preferredFile, season, episode);
        if (tId && fileId != null) {
          try {
            const url = await getDownloadLink({ apiKey, torrentId: tId, fileId });
            if (url) return url;
          } catch { /* még nem kész, polling folytatása */ }
        }
      }
    }
  } catch (e) {
    console.log(`[TorBox] Mylist lekérdezés hiba: ${e.message}`);
  }

  // 2. Ha még nem volt a listában: hozzáadjuk
  if (!tId) {
    try {
      const res  = await addTorrent({ apiKey, magnet });
      const newId = getTorrentId(res);
      if (newId) tId = newId;
      console.log(`[TorBox] Torrent hozzáadva (id=${tId || '?'})`);
    } catch (e) {
      const msg = String(e?.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('exist')) {
        console.log('[TorBox] Torrent már szerepel a listában');
      } else {
        // Valódi hiba (pl. érvénytelen API kulcs, hálózati hiba) – korai kilépés
        console.log(`[TorBox] addTorrent sikertelen: ${e.message}`);
        const err  = new Error('TorBox nem kész');
        err.code   = 'TORBOX_NOT_READY';
        throw err;
      }
    }
  }

  // 3. Poll: várunk amíg a torrent elérhető és letöltési link kapható
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    await sleep(2000);

    let list;
    try { list = await getMyTorrents({ apiKey }); }
    catch (e) { console.log(`[TorBox] Poll ${attempt} hiba: ${e.message}`); continue; }

    const torrent = findTorrent(list, hash);
    if (!torrent) {
      console.log(`[TorBox] Poll ${attempt}: még nem jelent meg a listában`);
      continue;
    }

    if (!tId) tId = getTorrentId(torrent);
    const state = getTorrentState(torrent);
    const pct   = getTorrentProgress(torrent);
    console.log(`[TorBox] Poll ${attempt}: ${state} ${pct}% (id=${tId})`);

    const files = getFiles(torrent);
    if (!files.length) {
      console.log(`[TorBox] Poll ${attempt}: még nincsenek fájlok`);
      continue;
    }

    const fileId = pickFileId(torrent, preferredFile, season, episode);
    if (fileId == null || !tId) {
      console.log(`[TorBox] Poll ${attempt}: nem sikerült fájlt kiválasztani`);
      continue;
    }

    try {
      const url = await getDownloadLink({ apiKey, torrentId: tId, fileId });
      if (url) return url;
    } catch (e) {
      console.log(`[TorBox] requestdl hiba: ${e.message}`);
    }
  }

  const err  = new Error('TorBox nem kész');
  err.code   = 'TORBOX_NOT_READY';
  throw err;
}

// ---------------------------------------------------------------------------
// Exportok
// ---------------------------------------------------------------------------

module.exports = {
  addTorrent,
  getMyTorrents,
  getDownloadLink,
  checkCached,
  resolveLink,
  infoHashFromMagnet,
  findTorrent,
  getTorrentId,
  getTorrentState,
  getTorrentProgress,
  isTorrentReady,
};
