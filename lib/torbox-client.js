const { fetch } = require('./fetch');

const TORBOX_BASE_URLS = ['https://api.torbox.app/v1', 'https://api.torbox.app'];
const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.mpg', '.mpeg', '.ts', '.m2ts']);
const TORBOX_QUEUE_LIMIT_ERRORS = new Set(['ACTIVE_LIMIT', 'COOLDOWN_LIMIT', 'MONTHLY_LIMIT']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFormData() {
  if (typeof FormData !== 'undefined') return new FormData();
  try {
    // eslint-disable-next-line global-require
    const { FormData: UndiciFormData } = require('undici');
    if (typeof UndiciFormData === 'function') return new UndiciFormData();
  } catch {
    // ignore
  }
  throw new Error('FormData is not available (Node 18+ or undici is required)');
}

function normalizeObjectArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];

  for (const key of ['data', 'torrents', 'list', 'results']) {
    if (Array.isArray(value[key])) return value[key];
  }

  if (value.data && typeof value.data === 'object') {
    for (const key of ['torrents', 'list', 'results', 'items']) {
      if (Array.isArray(value.data[key])) return value.data[key];
    }
  }

  return [];
}

function readInfoHashFromMagnet(magnet) {
  const match = String(magnet || '').match(/xt=urn:btih:([a-fA-F0-9]{40})/i);
  return match ? match[1].toLowerCase() : '';
}

function readDisplayNameFromMagnet(magnet) {
  try {
    const url = new URL(String(magnet || ''));
    return String(url.searchParams.get('dn') || '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

function pickTorrentId(value) {
  if (!value || typeof value !== 'object') return '';
  for (const candidate of [value.torrent_id, value.torrentId, value.id, value.data?.torrent_id, value.data?.id]) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
      return String(candidate);
    }
  }
  return '';
}

function pickQueuedId(value) {
  if (!value || typeof value !== 'object') return '';
  for (const candidate of [value.queued_id, value.queuedId, value.data?.queued_id, value.data?.queuedId]) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
      return String(candidate);
    }
  }
  return '';
}

function readTorboxErrorCode(error) {
  return String(
    error?.response?.error
      || error?.response?.data?.error
      || error?.error
      || '',
  ).trim().toUpperCase();
}

function isTorboxQueueLimitError(error) {
  return TORBOX_QUEUE_LIMIT_ERRORS.has(readTorboxErrorCode(error));
}

function isAlreadyExistsError(error) {
  const joined = [
    error?.message,
    error?.response?.detail,
    error?.response?.error,
    error?.response?.message,
    error?.response?.data?.detail,
    error?.response?.data?.error,
    error?.response?.data?.message,
  ]
    .map((part) => String(part || '').toLowerCase())
    .filter(Boolean)
    .join(' | ');

  return joined.includes('already')
    || joined.includes('exist')
    || joined.includes('duplicate')
    || joined.includes('409');
}

async function requestTorbox({
  path,
  method = 'GET',
  apiKey,
  query = {},
  body,
  extraHeaders = {},
  withAuthHeader = true,
}) {
  if (!apiKey) throw new Error('missing TorBox API key');

  let lastError = null;
  for (const base of TORBOX_BASE_URLS) {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    const headers = {
      ...extraHeaders,
    };
    if (withAuthHeader) headers.authorization = `Bearer ${apiKey}`;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'manual',
      });

      const raw = await response.text();
      let parsed;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        parsed = { raw };
      }

      if (response.ok) return parsed;

      const error = new Error(`TorBox request failed (${response.status})`);
      error.response = parsed;
      error.status = response.status;
      lastError = error;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('TorBox request failed');
}

async function listMyTorrents({ apiKey, bypassCache = true, offset = 0, limit = 1000, id = undefined } = {}) {
  const payload = await requestTorbox({
    path: '/api/torrents/mylist',
    method: 'GET',
    apiKey,
    query: {
      bypass_cache: bypassCache ? 'true' : 'false',
      offset,
      limit,
      id,
    },
  });

  return normalizeObjectArray(payload);
}

function readTorboxInfoHash(item) {
  const direct = String(item?.hash || item?.info_hash || '').toLowerCase();
  if (/^[a-f0-9]{40}$/.test(direct)) return direct;

  const fromMagnet = readInfoHashFromMagnet(item?.magnet || item?.magnet_url || '');
  return /^[a-f0-9]{40}$/.test(fromMagnet) ? fromMagnet : '';
}

function readTorboxState(item) {
  return String(item?.download_state ?? item?.downloadState ?? item?.state ?? item?.status ?? '').toLowerCase();
}

function readTorboxProgress(item) {
  const progress = Number(item?.progress ?? item?.download_progress ?? item?.downloadProgress ?? item?.percent ?? 0);
  if (!Number.isFinite(progress)) return null;
  return Math.max(0, Math.min(100, progress));
}

function isTorboxReady(item) {
  if (item?.download_finished === true || item?.downloadFinished === true) return true;
  if (item?.download_present === true || item?.downloadPresent === true) return true;

  const state = readTorboxState(item);
  const progress = readTorboxProgress(item);

  if (state.includes('completed') || state.includes('complete') || state.includes('finished') || state.includes('ready')) {
    return true;
  }
  return progress !== null && progress >= 100;
}

function hasTorboxError(item) {
  const state = readTorboxState(item);
  if (state === 'error') return true;

  const active = item?.active;
  const finished = item?.download_finished ?? item?.downloadFinished;
  return active === false && finished === false;
}

function isTorboxDownloading(item) {
  const queuedId = item?.queued_id ?? item?.queuedId;
  if (queuedId !== undefined && queuedId !== null && String(queuedId).trim()) return true;
  return !isTorboxReady(item) && !hasTorboxError(item);
}

async function freeLastActiveTorrent() {
  // Intentionally no-op for now. Left as extension point for future slot management logic.
  return false;
}

async function createTorrentFromMagnet({ apiKey, magnet, name, retriesOnLimit = 1 }) {
  if (!magnet) throw new Error('missing magnet link');

  const form = createFormData();
  form.append('magnet', magnet);

  const resolvedName = String(name || readDisplayNameFromMagnet(magnet) || '').replace(/\s+/g, ' ').trim();
  if (resolvedName) form.append('name', resolvedName.slice(0, 180));

  form.append('allow_zip', 'false');
  form.append('as_queued', 'true');
  form.append('seed', '1');

  try {
    const payload = await requestTorbox({
      path: '/api/torrents/createtorrent',
      method: 'POST',
      apiKey,
      body: form,
    });

    if (payload?.error === 'ACTIVE_LIMIT' && retriesOnLimit > 0) {
      const freed = await freeLastActiveTorrent({ apiKey });
      if (freed) {
        return createTorrentFromMagnet({ apiKey, magnet, name, retriesOnLimit: retriesOnLimit - 1 });
      }
    }

    return payload?.data || payload;
  } catch (error) {
    if (isTorboxQueueLimitError(error) && retriesOnLimit > 0) {
      const freed = await freeLastActiveTorrent({ apiKey });
      if (freed) {
        return createTorrentFromMagnet({ apiKey, magnet, name, retriesOnLimit: retriesOnLimit - 1 });
      }
    }
    throw error;
  }
}

function findTorrent(list, infoHash, torrentId = '') {
  const targetId = String(torrentId || '').trim();
  if (targetId) {
    const byId = list.find((item) => pickTorrentId(item) === targetId);
    if (byId) return byId;
  }

  const normalizedHash = String(infoHash || '').toLowerCase();
  if (!normalizedHash) return list[0] || null;

  return list.find((item) => readTorboxInfoHash(item) === normalizedHash) || null;
}

function pickFileArray(item) {
  if (Array.isArray(item?.files)) return item.files;
  if (Array.isArray(item?.data?.files)) return item.data.files;
  return [];
}

function readFileName(file) {
  return String(file?.short_name || file?.name || file?.filename || file?.path || '');
}

function readFileId(file) {
  const id = file?.id ?? file?.file_id ?? file?.fileId;
  if (id === undefined || id === null) return '';
  return String(id);
}

function readFileSize(file) {
  const value = Number(file?.size ?? file?.bytes ?? file?.size_bytes ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function isVideoFile(name) {
  const lowered = String(name || '').toLowerCase();
  for (const ext of VIDEO_EXTENSIONS) {
    if (lowered.endsWith(ext)) return true;
  }
  return false;
}

function isEpisodeFileMatch(name, season, episode) {
  if (!season || !episode) return false;

  const text = String(name || '').toLowerCase();
  if (!text) return false;

  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');

  const directMatch = [
    new RegExp(`\\bs${s}\\s*[._\\- ]?e${e}\\b`, 'i'),
    new RegExp(`\\b${season}\\s*[x]\\s*0*${episode}\\b`, 'i'),
    new RegExp(`\\bseason\\s*0*${season}\\s*(?:episode|ep|e)\\s*0*${episode}\\b`, 'i'),
    new RegExp(`\\b0*${season}\\s*[._\\- ]*(?:evad|\\u00e9vad)\\s*[._\\- ]*0*${episode}\\s*[._\\- ]*(?:resz|r\\u00e9sz|epizod|epiz\\u00f3d)\\b`, 'i'),
  ].some((re) => re.test(text));

  if (!directMatch) return false;

  const isRange = [
    new RegExp(`\\bs${s}\\s*[._\\- ]?e${e}\\s*-\\s*e?\\d{1,2}\\b`, 'i'),
    new RegExp(`\\b${season}\\s*[x]\\s*0*${episode}\\s*-\\s*\\d{1,2}\\b`, 'i'),
    new RegExp(`\\bs${s}\\s*[._\\- ]?e${e}\\s*e\\d{1,2}\\b`, 'i'),
  ].some((re) => re.test(text));

  return !isRange;
}

function chooseFileId(item, preferredName, season, episode) {
  const files = pickFileArray(item);
  if (files.length === 0) return '';

  if (season && episode) {
    const episodeCandidates = files
      .map((file) => ({ id: readFileId(file), name: readFileName(file), size: readFileSize(file) }))
      .filter((file) => file.id && isVideoFile(file.name) && isEpisodeFileMatch(file.name, season, episode))
      .sort((a, b) => b.size - a.size);

    return episodeCandidates[0]?.id || '';
  }

  const normalizedPreferred = String(preferredName || '').toLowerCase();
  if (normalizedPreferred) {
    const exact = files.find((file) => {
      const name = readFileName(file).toLowerCase();
      return name && (name === normalizedPreferred || name.endsWith(normalizedPreferred) || normalizedPreferred.endsWith(name));
    });
    if (exact) return readFileId(exact);
  }

  const bestVideo = files
    .map((file) => ({ id: readFileId(file), name: readFileName(file), size: readFileSize(file) }))
    .filter((file) => file.id && isVideoFile(file.name))
    .sort((a, b) => b.size - a.size)[0];

  if (bestVideo?.id) return bestVideo.id;

  return readFileId(files[0]);
}

function pickDownloadUrl(payload) {
  if (typeof payload === 'string') return /^https?:\/\//i.test(payload) ? payload : '';
  for (const candidate of [
    payload?.data?.url,
    payload?.data?.link,
    payload?.data?.download,
    payload?.url,
    payload?.link,
    payload?.download,
    payload?.data,
  ]) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return candidate;
  }
  return '';
}

async function requestDownloadLink({ apiKey, torrentId, fileId }) {
  const payload = await requestTorbox({
    path: '/api/torrents/requestdl',
    method: 'GET',
    apiKey,
    withAuthHeader: false,
    extraHeaders: { accept: 'application/json,text/plain,*/*' },
    query: {
      token: apiKey,
      torrent_id: torrentId,
      file_id: fileId || 0,
      redirect: 'false',
      zip_link: 'false',
    },
  });

  const url = pickDownloadUrl(payload);
  if (!url) throw new Error('Failed to request TorBox download link');
  return url;
}

async function ensureTorrentQueued({ apiKey, magnet, name, waitMs = 20_000, pollIntervalMs = 1500 }) {
  if (!magnet) throw new Error('missing magnet');

  const infoHash = readInfoHashFromMagnet(magnet);
  const normalizedName = String(name || readDisplayNameFromMagnet(magnet) || '').replace(/\s+/g, ' ').trim().slice(0, 180);

  let created = null;
  let createError = null;
  let torrentId = '';
  let queuedId = '';

  for (const attemptName of [normalizedName || undefined, undefined, undefined]) {
    try {
      created = await createTorrentFromMagnet({ apiKey, magnet, name: attemptName });
      torrentId = pickTorrentId(created) || String(created?.data?.torrentId || created?.data?.torrent_id || '');
      queuedId = pickQueuedId(created);
      createError = null;
      break;
    } catch (error) {
      createError = error;
      if (isTorboxQueueLimitError(error)) {
        error.code = readTorboxErrorCode(error) || 'ACTIVE_LIMIT';
        throw error;
      }
      if (isAlreadyExistsError(error)) {
        createError = null;
        break;
      }
    }
  }

  const deadline = Date.now() + Math.max(3000, Number(waitMs) || 20_000);
  while (Date.now() < deadline) {
    try {
      const list = await listMyTorrents({ apiKey, bypassCache: true, id: torrentId || undefined, offset: 0, limit: 1000 });
      const existing = findTorrent(list, infoHash, torrentId);
      if (existing) {
        return {
          queued: true,
          torrentId: pickTorrentId(existing) || torrentId,
          queuedId: String((existing?.queued_id ?? existing?.queuedId ?? queuedId) || ''),
          infoHash: readTorboxInfoHash(existing) || infoHash,
          state: readTorboxState(existing),
        };
      }
    } catch {
      // ignore transient errors while validating queueing
    }

    await sleep(Math.max(300, Number(pollIntervalMs) || 1500));
  }

  if (created || queuedId || torrentId || !createError) {
    return { queued: true, torrentId, queuedId, infoHash, state: '' };
  }

  throw createError;
}

async function resolveTorboxLinkWithWait({
  apiKey,
  magnet,
  infoHash,
  fileName,
  season,
  episode,
  maxWaitMs = 600_000,
  skipCreate = false,
}) {
  const targetHash = String(infoHash || readInfoHashFromMagnet(magnet)).toLowerCase();
  if (!apiKey) throw new Error('missing TorBox API key');
  if (!magnet) throw new Error('missing magnet');
  if (!targetHash) throw new Error('missing infoHash');

  let torrentId = '';
  let queuedId = '';
  let attemptedCreate = false;

  const deadline = Date.now() + Math.max(5000, Number(maxWaitMs) || 600_000);

  while (Date.now() < deadline) {
    if (!skipCreate && !attemptedCreate) {
      attemptedCreate = true;
      try {
        const created = await createTorrentFromMagnet({ apiKey, magnet, name: fileName });
        torrentId = pickTorrentId(created) || String(created?.data?.torrentId || created?.data?.torrent_id || '');
        queuedId = pickQueuedId(created);
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          // continue by discovering torrent from mylist
        } else if (isTorboxQueueLimitError(error)) {
          error.code = readTorboxErrorCode(error) || 'ACTIVE_LIMIT';
          throw error;
        } else {
          try {
            const retryCreated = await createTorrentFromMagnet({ apiKey, magnet, name: undefined });
            torrentId = pickTorrentId(retryCreated) || String(retryCreated?.data?.torrentId || retryCreated?.data?.torrent_id || '');
            queuedId = pickQueuedId(retryCreated);
          } catch (retryError) {
            if (isTorboxQueueLimitError(retryError)) {
              retryError.code = readTorboxErrorCode(retryError) || 'ACTIVE_LIMIT';
              throw retryError;
            }
          }
        }
      }
    }

    const list = await listMyTorrents({
      apiKey,
      bypassCache: true,
      id: torrentId || undefined,
      offset: 0,
      limit: 1000,
    });

    const torrent = findTorrent(list, targetHash, torrentId);
    if (!torrent) {
      await sleep(2000);
      continue;
    }

    torrentId = torrentId || pickTorrentId(torrent);
    const fileId = chooseFileId(torrent, fileName, season, episode);

    if (torrentId && fileId !== '') {
      const url = await requestDownloadLink({ apiKey, torrentId, fileId });
      return { url, subtitles: [] };
    }

    if (hasTorboxError(torrent)) {
      const err = new Error('TorBox torrent errored during download');
      err.code = 'TORBOX_DOWNLOAD_ERROR';
      throw err;
    }

    if (isTorboxDownloading(torrent) || queuedId || pickFileArray(torrent).length === 0) {
      await sleep(2000);
      continue;
    }

    await sleep(2000);
  }

  const error = new Error('TorBox not ready or file not found');
  error.code = 'TORBOX_NOT_READY';
  throw error;
}

async function resolveTorboxLink(args) {
  return resolveTorboxLinkWithWait(args);
}

async function checkCachedAvailability({ apiKey, infoHashes }) {
  const hashes = (Array.isArray(infoHashes) ? infoHashes : [])
    .map((hash) => String(hash || '').trim().toLowerCase())
    .filter((hash) => /^[a-f0-9]{40}$/.test(hash));

  const out = new Map();
  if (hashes.length === 0) return out;

  try {
    const payload = await requestTorbox({
      path: '/api/torrents/checkcached',
      method: 'GET',
      apiKey,
      query: {
        hash: hashes.join(','),
        format: 'list',
        list_files: 'false',
      },
    });

    if (Array.isArray(payload?.data)) {
      for (const hash of payload.data) out.set(String(hash || '').toLowerCase(), true);
    } else if (payload?.data && typeof payload.data === 'object') {
      for (const [hash, cached] of Object.entries(payload.data)) out.set(String(hash || '').toLowerCase(), Boolean(cached));
    }
  } catch {
    // Network/API issues should not break stream listing; default to uncached.
  }

  for (const hash of hashes) {
    if (!out.has(hash)) out.set(hash, false);
  }

  return out;
}

module.exports = {
  resolveTorboxLink,
  resolveTorboxLinkWithWait,
  checkCachedAvailability,
  listMyTorrents,
  readTorboxInfoHash,
  readTorboxState,
  readTorboxProgress,
  isTorboxReady,
  ensureTorrentQueued,
  readTorboxErrorCode,
  isTorboxQueueLimitError,
};
