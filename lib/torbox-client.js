const TORBOX_BASES = ['https://api.torbox.app/v1', 'https://api.torbox.app'];
const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.mpg', '.mpeg', '.ts', '.m2ts']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt']);
const { fetch } = require('./fetch');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

function createFormData() {
  /* global FormData */
  if (typeof FormData !== 'undefined') return new FormData();
  try {
    // eslint-disable-next-line global-require
    const undici = require('undici');
    if (typeof undici.FormData === 'function') return new undici.FormData();
  } catch {
    // ignore
  }
  throw new Error('FormData is not available (need Node 18+ or undici FormData)');
}

async function fetchJson({ path, method = 'GET', base, query = {}, body = undefined, headers = {} }) {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, { method, headers, body, redirect: 'manual' });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { ok: response.ok, status: response.status, parsed, headers: response.headers };
}

async function fetchJsonWithAuth({ path, method = 'GET', apiKey, query = {}, body = undefined, headers = {} }) {
  let lastError;

  for (const base of TORBOX_BASES) {
    try {
      const res = await fetchJson({
        base,
        path,
        method,
        query,
        body,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...headers,
        },
      });

      if (res.ok) return res.parsed;
      lastError = new Error(`TorBox request failed (${res.status})`);
      lastError.response = res.parsed;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('TorBox request failed');
}

function readNameFromMagnet(magnet) {
  const input = String(magnet || '').trim();
  if (!input) return '';
  try {
    const url = new URL(input);
    return String(url.searchParams.get('dn') || '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

function extractInfoHash(value) {
  const text = String(value || '');
  const match = text.match(/xt=urn:btih:([a-fA-F0-9]{40})/i);
  return match ? match[1].toLowerCase() : '';
}

function getFirstObjectArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];

  const keys = ['data', 'torrents', 'list', 'results'];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }

  if (value.data && typeof value.data === 'object') {
    for (const key of ['torrents', 'list', 'results', 'items']) {
      if (Array.isArray(value.data[key])) return value.data[key];
    }
  }

  return [];
}

function pickTorrentId(value) {
  if (!value || typeof value !== 'object') return '';

  const candidates = [value.torrent_id, value.torrentId, value.id, value.data?.torrent_id, value.data?.id];
  for (const candidate of candidates) {
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
  const code = readTorboxErrorCode(error);
  return ['ACTIVE_LIMIT', 'COOLDOWN_LIMIT', 'MONTHLY_LIMIT'].includes(code);
}

function isCreateAlreadyExistsError(error) {
  const parts = [
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

  if (!parts) return false;
  return parts.includes('already')
    || parts.includes('exist')
    || parts.includes('duplicate')
    || parts.includes('409');
}

function pickFileArray(item) {
  if (!item || typeof item !== 'object') return [];
  if (Array.isArray(item.files)) return item.files;
  if (Array.isArray(item.data?.files)) return item.data.files;
  return [];
}

function readFileName(file) {
  return String(
    file?.short_name
      || file?.name
      || file?.filename
      || file?.path
      || '',
  );
}

function readFileId(file) {
  const candidate = file?.id ?? file?.file_id ?? file?.fileId;
  if (candidate === undefined || candidate === null) return '';
  return String(candidate);
}

function readFileSize(file) {
  const size = Number(file?.size ?? file?.bytes ?? file?.size_bytes ?? 0);
  return Number.isFinite(size) ? size : 0;
}

function isVideoFile(name) {
  const lowered = String(name || '').toLowerCase();
  for (const ext of VIDEO_EXTENSIONS) {
    if (lowered.endsWith(ext)) return true;
  }
  return false;
}

function isSubtitleFile(name) {
  const lowered = String(name || '').toLowerCase();
  for (const ext of SUBTITLE_EXTENSIONS) {
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

  const direct = [
    new RegExp(`\\bs${s}\\s*[._\\- ]?e${e}\\b`, 'i'),
    new RegExp(`\\b${season}\\s*[x]\\s*0*${episode}\\b`, 'i'),
    new RegExp(`\\bseason\\s*0*${season}\\s*(?:episode|ep|e)\\s*0*${episode}\\b`, 'i'),
    new RegExp(`\\b0*${season}\\s*[._\\- ]*(?:evad|\\u00e9vad)\\s*[._\\- ]*0*${episode}\\s*[._\\- ]*(?:resz|r\\u00e9sz|epizod|epiz\\u00f3d)\\b`, 'i'),
  ].some((re) => re.test(text));

  if (!direct) return false;

  const range = [
    new RegExp(`\\bs${s}\\s*[._\\- ]?e${e}\\s*-\\s*e?\\d{1,2}\\b`, 'i'),
    new RegExp(`\\b${season}\\s*[x]\\s*0*${episode}\\s*-\\s*\\d{1,2}\\b`, 'i'),
    new RegExp(`\\bs${s}\\s*[._\\- ]?e${e}\\s*e\\d{1,2}\\b`, 'i'),
  ].some((re) => re.test(text));

  return !range;
}

function chooseFileIdFromTorrent(item, preferredName, season, episode) {
  const files = pickFileArray(item);
  if (files.length === 0) return '';

  if (season && episode) {
    const episodeMatches = files
      .map((file) => ({ id: readFileId(file), name: readFileName(file), size: readFileSize(file) }))
      .filter((file) => file.id && isVideoFile(file.name) && isEpisodeFileMatch(file.name, season, episode));

    if (episodeMatches.length > 0) {
      episodeMatches.sort((a, b) => b.size - a.size);
      return episodeMatches[0].id;
    }

    return '';
  }

  const preferred = String(preferredName || '').toLowerCase();
  if (preferred) {
    for (const file of files) {
      const name = readFileName(file).toLowerCase();
      if (name && (name === preferred || name.endsWith(preferred) || preferred.endsWith(name))) {
        const id = readFileId(file);
        if (id) return id;
      }
    }
  }

  const videos = files
    .map((file) => ({ id: readFileId(file), name: readFileName(file), size: readFileSize(file) }))
    .filter((file) => file.id && isVideoFile(file.name));

  if (videos.length > 0) {
    videos.sort((a, b) => b.size - a.size);
    return videos[0].id;
  }

  for (const file of files) {
    const id = readFileId(file);
    if (id) return id;
  }

  return '';
}

function detectSubtitleLang(name) {
  const text = String(name || '').toLowerCase();
  if (/\b(hu|hun|hungarian|magyar)\b/.test(text)) return 'hu';
  if (/\b(en|eng|english)\b/.test(text)) return 'en';
  if (/\b(de|ger|german|deutsch)\b/.test(text)) return 'de';
  if (/\b(fr|fre|french)\b/.test(text)) return 'fr';
  if (/\b(es|spa|spanish)\b/.test(text)) return 'es';
  if (/\b(it|ita|italian)\b/.test(text)) return 'it';
  if (/\b(pl|pol|polish)\b/.test(text)) return 'pl';
  if (/\b(ro|ron|romanian)\b/.test(text)) return 'ro';
  if (/\b(cs|cze|czech)\b/.test(text)) return 'cs';
  if (/\b(sk|slk|slovak)\b/.test(text)) return 'sk';
  return 'en';
}

function pickSubtitleFiles(item, preferredName, limit = 4) {
  const files = pickFileArray(item);
  if (files.length === 0) return [];

  const preferred = String(preferredName || '').toLowerCase();
  const videoStem = preferred ? preferred.replace(/\.[a-z0-9]{2,5}$/i, '') : '';

  const subtitles = files
    .map((file) => ({ id: readFileId(file), name: readFileName(file) }))
    .filter((file) => file.id && isSubtitleFile(file.name));

  if (subtitles.length === 0) return [];

  const scored = subtitles.map((file) => {
    const lowered = file.name.toLowerCase();
    let score = 0;
    if (videoStem && lowered.includes(videoStem)) score += 4;
    if (/\b(hu|hun|magyar)\b/.test(lowered)) score += 3;
    if (/\b(en|eng|english)\b/.test(lowered)) score += 2;
    return { ...file, score };
  });

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit);
}

function findTorrentInList(listPayload, infoHash, torrentId = '') {
  const list = getFirstObjectArray(listPayload);
  if (list.length === 0) return null;

  const targetId = String(torrentId || '').trim();
  if (targetId) {
    for (const item of list) {
      if (pickTorrentId(item) === targetId) return item;
    }
  }

  const target = String(infoHash || '').toLowerCase();
  if (!target) return list[0];

  for (const item of list) {
    const hash = String(item?.hash || item?.info_hash || '').toLowerCase();
    if (hash && hash === target) return item;

    const magnet = String(item?.magnet || item?.magnet_url || '');
    const magnetHash = extractInfoHash(magnet);
    if (magnetHash && magnetHash === target) return item;
  }

  return null;
}

function pickDownloadUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value) ? value : '';
  }

  const candidates = [
    value.data?.url,
    value.data?.link,
    value.data?.download,
    value.url,
    value.link,
    value.download,
    value.data,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
      return candidate;
    }
  }

  return '';
}

async function createTorrentFromMagnet({ apiKey, magnet, name }) {
  const form = createFormData();
  form.append('magnet', magnet);
  const resolvedName = String(name || readNameFromMagnet(magnet) || '').replace(/\s+/g, ' ').trim();
  if (resolvedName) form.append('name', resolvedName.slice(0, 180));
  form.append('allow_zip', 'false');
  form.append('as_queued', 'true');
  form.append('seed', '1');

  return fetchJsonWithAuth({
    path: '/api/torrents/createtorrent',
    method: 'POST',
    apiKey,
    body: form,
  });
}

async function requestDownloadLink({ apiKey, torrentId, fileId }) {
  const query = {
    token: apiKey,
    torrent_id: torrentId,
    file_id: fileId || 0,
    redirect: 'false',
    zip_link: 'false',
  };

  let lastError;
  for (const base of TORBOX_BASES) {
    try {
      const res = await fetchJson({
        base,
        path: '/api/torrents/requestdl',
        method: 'GET',
        query,
        headers: { accept: 'application/json,text/plain,*/*' },
      });
      if (!res.ok) {
        const err = new Error(`TorBox requestdl failed (${res.status})`);
        err.response = res.parsed;
        throw err;
      }
      const link = pickDownloadUrl(res.parsed);
      if (link) return link;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Failed to request TorBox download link');
}

async function checkCachedAvailability({ apiKey, infoHashes }) {
  const hashes = (Array.isArray(infoHashes) ? infoHashes : [])
    .map((h) => String(h || '').trim().toLowerCase())
    .filter((h) => /^[a-f0-9]{40}$/.test(h));

  if (hashes.length === 0) return new Map();

  try {
    const payload = await fetchJsonWithAuth({
      path: '/api/torrents/checkcached',
      method: 'GET',
      apiKey,
      query: { 
        hash: hashes.join(','), 
        format: 'list', 
        list_files: 'false' 
      },
    });

    const out = new Map();
    if (Array.isArray(payload?.data)) {
      for (const hash of payload.data) {
        const h = String(hash || '').trim().toLowerCase();
        if (/^[a-f0-9]{40}$/.test(h)) out.set(h, true);
      }
      for (const h of hashes) {
        if (!out.has(h)) out.set(h, false);
      }
      return out;
    }

    if (typeof payload?.data === 'object' && payload.data !== null) {
      for (const [hash, cached] of Object.entries(payload.data)) {
        const h = String(hash || '').trim().toLowerCase();
        if (/^[a-f0-9]{40}$/.test(h)) {
          out.set(h, Boolean(cached));
        }
      }
      for (const h of hashes) {
        if (!out.has(h)) out.set(h, false);
      }
      return out;
    }

    for (const h of hashes) {
      out.set(h, false);
    }

    return out;
  } catch (error) {
    console.error('TorBox checkCachedAvailability failed:', error?.message || error);
    const out = new Map();
    for (const h of hashes) {
      out.set(h, false);
    }
    return out;
  }
}

async function listMyTorrents({
  apiKey,
  bypassCache = true,
  offset = 0,
  limit = 1000,
  id = undefined,
} = {}) {
  if (!apiKey) throw new Error('missing TorBox API key');

  const payload = await fetchJsonWithAuth({
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

  return getFirstObjectArray(payload);
}

function readTorboxInfoHash(item) {
  if (!item || typeof item !== 'object') return '';
  const direct = String(item.hash || item.info_hash || '').toLowerCase();
  if (/^[a-f0-9]{40}$/.test(direct)) return direct;
  const magnet = String(item.magnet || item.magnet_url || '');
  const fromMagnet = extractInfoHash(magnet);
  return /^[a-f0-9]{40}$/.test(fromMagnet) ? fromMagnet : '';
}

function readTorboxState(item) {
  return String(item?.download_state ?? item?.downloadState ?? item?.state ?? item?.status ?? '').toLowerCase();
}

function readTorboxProgress(item) {
  const value = Number(item?.progress ?? item?.download_progress ?? item?.downloadProgress ?? item?.percent ?? 0);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function isTorboxReady(item) {
  if (item?.download_finished === true || item?.downloadFinished === true) return true;
  if (item?.download_present === true || item?.downloadPresent === true) return true;
  const state = readTorboxState(item);
  const progress = readTorboxProgress(item);
  if (state.includes('completed') || state.includes('complete') || state.includes('finished') || state.includes('ready')) return true;
  if (progress !== null && progress >= 100) return true;
  return false;
}



function statusDownloading(item) {
  if (!item || typeof item !== 'object') return false;
  const queuedId = item.queued_id ?? item.queuedId;
  if (queuedId !== undefined && queuedId !== null && String(queuedId).trim()) return true;
  return !isTorboxReady(item) && !statusError(item);
}

function statusError(item) {
  if (!item || typeof item !== 'object') return false;
  const state = readTorboxState(item);
  if (state === 'error') return true;
  const active = item.active;
  const finished = item.download_finished ?? item.downloadFinished;
  if (active === false && finished === false) return true;
  return false;
}

function pickQueuedId(value) {
  if (!value || typeof value !== 'object') return '';
  const candidates = [
    value.queued_id,
    value.queuedId,
    value.data?.queued_id,
    value.data?.queuedId,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
      return String(candidate);
    }
  }
  return '';
}

async function ensureTorrentQueued({ apiKey, magnet, name }) {
  if (!apiKey) throw new Error('missing TorBox API key');
  if (!magnet) throw new Error('missing magnet');

  try {
    const created = await createTorrentFromMagnet({ apiKey, magnet, name });
    return {
      queued: true,
      torrentId: pickTorrentId(created)
        || String(created?.data?.torrentId || created?.data?.torrent_id || ''),
    };
  } catch (error) {
    if (isCreateAlreadyExistsError(error)) {
      return { queued: true, torrentId: '' };
    }
    throw error;
  }
}

async function resolveTorboxLinkWithWait({
  apiKey,
  magnet,
  infoHash,
  fileName,
  season,
  episode,
  includeSubtitles = false,
  maxWaitMs = 600_000,
  skipCreate = false,
}) {
  const targetHash = String(infoHash || extractInfoHash(magnet)).toLowerCase();
  if (!apiKey) throw new Error('missing TorBox API key');
  if (!targetHash) throw new Error('missing infoHash');
  if (!magnet) throw new Error('missing magnet');

  let torrentId = '';
  let queuedId = '';
  let createdAttempted = false;

  const deadline = Date.now() + Math.max(5_000, Number(maxWaitMs) || 600_000);
  while (Date.now() < deadline) {
    if (!skipCreate && !createdAttempted) {
      createdAttempted = true;
      try {
        const created = await createTorrentFromMagnet({ apiKey, magnet, name: fileName });
        torrentId = pickTorrentId(created)
          || String(created?.data?.torrentId || created?.data?.torrent_id || '');
        queuedId = pickQueuedId(created);
      } catch (error) {
        if (isCreateAlreadyExistsError(error)) {
          // fine, we will locate by hash from mylist.
        } else if (isTorboxQueueLimitError(error)) {
          error.code = readTorboxErrorCode(error) || 'ACTIVE_LIMIT';
          throw error;
        } else {
          // retry once without optional name to match TorBox tolerance.
          try {
            const retryCreated = await createTorrentFromMagnet({ apiKey, magnet, name: undefined });
            torrentId = pickTorrentId(retryCreated)
              || String(retryCreated?.data?.torrentId || retryCreated?.data?.torrent_id || '');
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
      limit: 1000,
      offset: 0,
    });

    const chosen = findTorrentInList(list, targetHash, torrentId);
    if (!chosen) {
      // If TorBox only returned a queued id, keep waiting for the real torrent row.
      await sleep(2000);
      // eslint-disable-next-line no-continue
      continue;
    }

    torrentId = torrentId || pickTorrentId(chosen);
    const files = pickFileArray(chosen);
    const fileId = chooseFileIdFromTorrent(chosen, fileName, season, episode);

    if (torrentId && fileId !== '') {
      const url = await requestDownloadLink({ apiKey, torrentId, fileId });
      if (!includeSubtitles) return { url, subtitles: [] };

      const subtitleCandidates = pickSubtitleFiles(chosen, fileName, 1);
      const subtitles = [];
      for (let idx = 0; idx < subtitleCandidates.length; idx += 1) {
        const subtitle = subtitleCandidates[idx];
        try {
          const subtitleUrl = await withTimeout(
            requestDownloadLink({ apiKey, torrentId, fileId: subtitle.id }),
            1200,
          );
          subtitles.push({
            id: `tb-sub-${subtitle.id}`,
            lang: detectSubtitleLang(subtitle.name),
            url: subtitleUrl,
          });
        } catch {
          // ignore
        }
      }

      return { url, subtitles };
    }

    if (statusError(chosen)) {
      const err = new Error('TorBox torrent errored during download');
      err.code = 'TORBOX_DOWNLOAD_ERROR';
      throw err;
    }

    if (statusDownloading(chosen) || queuedId) {
      await sleep(2000);
      // eslint-disable-next-line no-continue
      continue;
    }

    if (files.length === 0) {
      await sleep(2000);
      // eslint-disable-next-line no-continue
      continue;
    }

    await sleep(2000);
  }

  const err = new Error('TorBox not ready or file not found');
  err.code = 'TORBOX_NOT_READY';
  throw err;
}

async function resolveTorboxLink(args) {
  // Backwards compat: old code calls resolveTorboxLink; keep behavior, but with wait.
  return resolveTorboxLinkWithWait(args);
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

