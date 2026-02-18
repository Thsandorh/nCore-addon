'use strict';

const { fetch } = require('./fetch');
let logError = (...args) => console.error(...args);
try {
  ({ logError } = require('./logger')); // optional in older deployments
} catch {
  // Fallback to console.error when logger module is missing on server.
}

const API_BASE = 'https://api.torbox.app';
const VIDEO_EXTS = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.mpg', '.mpeg', '.ts', '.m2ts'];
const DEBUG_TORBOX = String(process.env.TORBOX_DEBUG || 'false').toLowerCase() === 'true';

function debugLog(message, meta) {
  if (!DEBUG_TORBOX) return;
  logError(message, meta || {});
}

function makeForm(fields) {
  let form;
  if (typeof FormData !== 'undefined') {
    form = new FormData();
  } else {
    form = new (require('undici').FormData)(); // eslint-disable-line global-require
  }

  for (const [key, value] of Object.entries(fields || {})) {
    if (value == null) continue;
    form.append(key, value);
  }
  return form;
}

function toUploadFile(input, filename = 'upload.torrent') {
  if (!input) return null;

  const bytes = Buffer.isBuffer(input) ? input : (input instanceof Uint8Array ? Buffer.from(input) : null);
  if (!bytes) return input;

  if (typeof File !== 'undefined') {
    return new File([bytes], filename, { type: 'application/x-bittorrent' });
  }

  try {
    const { File: UndiciFile } = require('undici'); // eslint-disable-line global-require
    if (typeof UndiciFile === 'function') {
      return new UndiciFile([bytes], filename, { type: 'application/x-bittorrent' });
    }
  } catch {
    // ignore and fallback below
  }

  if (typeof Blob !== 'undefined') {
    return new Blob([bytes], { type: 'application/x-bittorrent' });
  }

  return bytes;
}

function toErrorDetail(payload, fallback = '') {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload;
  if (typeof payload.detail === 'string') return payload.detail;
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.message === 'string') return payload.message;
  return fallback;
}

function isApiFailurePayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.success === false) return true;
  if (typeof payload.error === 'string' && payload.error.length > 0) return true;
  return false;
}

async function apiCall({ path, method = 'GET', apiKey, query = {}, body, headers = {} }) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item != null && item !== '') url.searchParams.append(k, String(item));
      }
      continue;
    }

    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  const reqHeaders = {
    authorization: `Bearer ${apiKey}`,
    'user-agent': 'torrentio',
    ...headers,
  };

  let requestBody = body;
  if (
    body &&
    typeof body === 'object' &&
    !(body instanceof Uint8Array) &&
    !(body instanceof ArrayBuffer) &&
    typeof body.getBoundary !== 'function' &&
    typeof body.append !== 'function'
  ) {
    requestBody = JSON.stringify(body);
    if (!reqHeaders['content-type']) {
      reqHeaders['content-type'] = 'application/json';
    }
  }

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: requestBody,
    redirect: 'manual',
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok || isApiFailurePayload(data)) {
    const detail = toErrorDetail(data, text.slice(0, 220));
    const err = new Error(`TorBox ${res.status}: ${detail || 'Request failed'}`);
    err.status = res.status;
    err.data = data;
    const retryAfter = Number(res.headers.get('retry-after') || 0);
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterSec = retryAfter;
    logError('torbox-api-error', { path, method, status: res.status, detail });
    throw err;
  }

  return data;
}

function infoHashFromMagnet(magnet) {
  const m = String(magnet || '').match(/xt=urn:btih:([a-f0-9]{40})/i);
  return m ? m[1].toLowerCase() : '';
}

function getFiles(torrent) {
  const candidates = [
    torrent?.files,
    torrent?.download_files,
    torrent?.data?.files,
    torrent?.data?.download_files,
  ];

  for (const list of candidates) {
    if (Array.isArray(list)) return list;
  }
  return [];
}

function getTorrentId(torrent) {
  const value = torrent?.torrent_id
    ?? torrent?.torrentId
    ?? torrent?.id
    ?? torrent?.data?.torrent_id
    ?? torrent?.data?.id;

  return value != null ? String(value) : '';
}

function getTorrentState(torrent) {
  return String(
    torrent?.download_state
      ?? torrent?.state
      ?? torrent?.status
      ?? torrent?.download_status
      ?? '',
  ).toLowerCase();
}

function getTorrentProgress(torrent) {
  const value = Number(
    torrent?.progress
      ?? torrent?.download_progress
      ?? torrent?.percent
      ?? 0,
  );
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(100, value)));
}

function isTorrentReady(torrent) {
  return Boolean(torrent?.download_present);
}

function isTorrentError(torrent) {
  if (!torrent) return false;
  const state = getTorrentState(torrent);
  return state === 'error' || (!torrent.active && !torrent.download_finished);
}

function findTorrent(list, hash) {
  const target = String(hash || '').toLowerCase();
  if (!target) return null;

  const all = Array.isArray(list) ? list : [];
  const found = all.filter((item) => {
    const directHash = String(item?.hash || item?.info_hash || '').toLowerCase();
    if (directHash === target) return true;

    const magnetHash = infoHashFromMagnet(item?.magnet || item?.magnet_url || '');
    return magnetHash === target;
  });

  if (!found.length) return null;
  const nonFailed = found.find((t) => !isTorrentError(t));
  return nonFailed || found[0];
}

function pickFileId(torrent, preferredName, season, episode) {
  const files = getFiles(torrent)
    .map((file) => ({
      id: String(file?.id ?? file?.file_id ?? file?.fileId ?? ''),
      name: String(file?.name || file?.short_name || file?.filename || file?.path || ''),
      short: String(file?.short_name || file?.name || file?.filename || file?.path || ''),
      size: Number(file?.size ?? file?.bytes ?? file?.length ?? 0) || 0,
    }))
    .filter((f) => f.id && VIDEO_EXTS.some((ext) => f.short.toLowerCase().endsWith(ext)));

  if (!files.length) return null;

  if (season && episode) {
    const ss = String(season).padStart(2, '0');
    const ee = String(episode).padStart(2, '0');

    const episodic = files.filter((file) => {
      const n = file.name.toLowerCase();
      const sxe = new RegExp(`\\bs${ss}\\s*[._-]?e${ee}\\b`, 'i').test(n);
      const x = new RegExp(`\\b${season}\\s*x\\s*0*${episode}\\b`, 'i').test(n);
      const ranged = new RegExp(`\\bs${ss}\\s*[._-]?e${ee}\\s*[-e]\\d+\\b`, 'i').test(n);
      return (sxe || x) && !ranged;
    });

    if (episodic.length) {
      episodic.sort((a, b) => b.size - a.size);
      return episodic[0].id;
    }
  }

  if (preferredName) {
    const wanted = String(preferredName).toLowerCase();
    const exact = files.find((f) => {
      const n = f.name.toLowerCase();
      return n === wanted || n.endsWith(wanted) || wanted.endsWith(n);
    });
    if (exact) return exact.id;
  }

  files.sort((a, b) => b.size - a.size);
  return files[0].id;
}

function isAlreadyExistsError(error) {
  const status = Number(error?.status || 0);
  const msg = String(error?.message || '').toLowerCase();
  const detail = String(error?.data?.detail || '').toLowerCase();
  return status === 409 || msg.includes('already') || msg.includes('exist') || detail.includes('already') || detail.includes('exist');
}

async function addTorrent({
  apiKey,
  magnet,
  file = null,
  name = null,
  asQueued = false,
  addOnlyIfCached = false,
  allowZip = false,
  seed = null,
}) {
  let body;
  const uploadFile = toUploadFile(file, name || 'ncore.torrent');
  debugLog('torbox-create-input', {
    hasMagnet: Boolean(magnet),
    hasFile: Boolean(file),
    infoHash: infoHashFromMagnet(magnet || ''),
    name: name || null,
  });
  if (magnet && !file) {
    // Torrentio pattern: x-www-form-urlencoded create call with minimal params.
    const form = new URLSearchParams();
    form.set('magnet', String(magnet));
    form.set('allow_zip', allowZip ? 'true' : 'false');
    if (asQueued) form.set('as_queued', 'true');
    if (addOnlyIfCached) form.set('add_only_if_cached', 'true');
    if (name) form.set('name', String(name));
    if (seed != null) form.set('seed', String(seed));
    body = form.toString();
  } else {
    body = makeForm({
      magnet: magnet || null,
      file: uploadFile,
      name,
      as_queued: asQueued ? 'true' : 'false',
      add_only_if_cached: addOnlyIfCached ? 'true' : 'false',
      allow_zip: allowZip ? 'true' : 'false',
      seed: seed == null ? null : String(seed),
    });
  }

  try {
    return await apiCall({
      path: '/v1/api/torrents/createtorrent',
      method: 'POST',
      apiKey,
      headers: typeof body === 'string' ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
      body,
    });
  } catch (err) {
    logError('torbox-create-failed', err);
    throw err;
  }
}

async function getMyTorrents({ apiKey }) {
  const data = await apiCall({
    path: '/v1/api/torrents/mylist',
    method: 'GET',
    apiKey,
    query: {
      bypass_cache: true,
      limit: 1000,
      offset: 0,
    },
  });

  return Array.isArray(data?.data) ? data.data : [];
}

async function getDownloadLink({ apiKey, torrentId, fileId }) {
  const url = new URL(`${API_BASE}/v1/api/torrents/requestdl`);
  url.searchParams.set('token', String(apiKey));
  url.searchParams.set('torrent_id', String(Number(torrentId)));
  url.searchParams.set('file_id', String(fileId == null ? 0 : Number(fileId)));
  url.searchParams.set('zip_link', 'false');
  url.searchParams.set('redirect', 'true');
  return url.toString();
}

async function controlTorrent({ apiKey, torrentId, operation }) {
  return apiCall({
    path: '/v1/api/torrents/controltorrent',
    method: 'POST',
    apiKey,
    body: {
      torrent_id: Number(torrentId),
      operation: String(operation || ''),
    },
  });
}

async function checkCached({ apiKey, infoHashes }) {
  const hashes = (infoHashes || [])
    .map((h) => String(h || '').toLowerCase())
    .filter((h) => /^[a-f0-9]{40}$/.test(h));

  if (!hashes.length) return new Map();

  try {
    const data = await apiCall({
      path: '/v1/api/torrents/checkcached',
      method: 'POST',
      apiKey,
      query: { format: 'list', list_files: true },
      body: { hashes },
    });

    const cached = new Set((Array.isArray(data?.data) ? data.data : []).map((h) => String(h || '').toLowerCase()));
    return new Map(hashes.map((h) => [h, cached.has(h)]));
  } catch {
    logError('torbox-checkcached-post-failed');
    try {
      const data = await apiCall({
        path: '/v1/api/torrents/checkcached',
        method: 'GET',
        apiKey,
        query: {
          hash: hashes,
          format: 'list',
          list_files: true,
        },
      });

      const cached = new Set((Array.isArray(data?.data) ? data.data : []).map((h) => String(h || '').toLowerCase()));
      return new Map(hashes.map((h) => [h, cached.has(h)]));
    } catch {
      logError('torbox-checkcached-get-failed');
      return new Map(hashes.map((h) => [h, null]));
    }
  }
}

async function resolveLink({
  apiKey,
  magnet,
  infoHash,
  torrentFile = null,
  torrentFileName = null,
  preferredFile,
  season,
  episode,
  maxWaitMs = 15000,
}) {
  void maxWaitMs;

  const hash = String(infoHash || infoHashFromMagnet(magnet) || '').toLowerCase();
  debugLog('torbox-resolve-start', { infoHash: hash, hasMagnet: Boolean(magnet), hasFile: Boolean(torrentFile) });
  if (!/^[a-f0-9]{40}$/.test(hash)) {
    const err = new Error('TorBox resolve: invalid infoHash');
    err.code = 'TORBOX_INVALID_HASH';
    throw err;
  }

  let torrent = findTorrent(await getMyTorrents({ apiKey }), hash);

  if (torrent && isTorrentError(torrent)) {
    const torrentId = getTorrentId(torrent);
    if (torrentId) {
      try {
        await controlTorrent({ apiKey, torrentId, operation: 'delete' });
      } catch (err) {
        logError('torbox-resolve-delete-failed', { torrentId, error: err?.message || String(err || '') });
      }
    }
    torrent = null;
  }

  if (!torrent) {
    let created;
    try {
      created = await addTorrent({
        apiKey,
        magnet: torrentFile ? null : magnet,
        file: torrentFile || null,
        name: torrentFileName || null,
        asQueued: false,
        addOnlyIfCached: false,
      });
    } catch (err) {
      if (!isAlreadyExistsError(err)) throw err;
    }

    const refresh = await getMyTorrents({ apiKey });
    const createdId = created ? getTorrentId(created) : '';
    torrent = (createdId && refresh.find((item) => getTorrentId(item) === createdId)) || findTorrent(refresh, hash);
  }

  if (!torrent || !isTorrentReady(torrent)) {
    const err = new Error('TorBox not ready');
    err.code = 'TORBOX_NOT_READY';
    throw err;
  }

  const torrentId = getTorrentId(torrent);
  const fileId = pickFileId(torrent, preferredFile, season, episode);
  if (!torrentId || fileId == null) {
    const err = new Error('TorBox not ready');
    err.code = 'TORBOX_NOT_READY';
    throw err;
  }

  return getDownloadLink({ apiKey, torrentId, fileId });
}

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
  isTorrentError,
};
