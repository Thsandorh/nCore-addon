'use strict';

const { fetch } = require('./fetch');

const TORBOX_API_BASE = 'https://api.torbox.app';
const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.mpg', '.mpeg', '.ts', '.m2ts']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('missing TorBox apiKey');
  }
}

function createFormData(fields) {
  const fd = typeof FormData !== 'undefined'
    ? new FormData()
    : new (require('undici').FormData)(); // eslint-disable-line global-require

  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    fd.append(key, String(value));
  }

  return fd;
}

async function torboxRequest({ path, method = 'GET', apiKey, query, body }) {
  ensureApiKey(apiKey);

  const url = new URL(`${TORBOX_API_BASE}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method,
    body,
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });

  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { raw: rawText };
  }

  if (!response.ok) {
    const detail = data?.detail || data?.error || data?.message || rawText.slice(0, 200) || `HTTP ${response.status}`;
    const error = new Error(`TorBox request failed: ${detail}`);
    error.status = response.status;
    error.response = data;
    throw error;
  }

  return data;
}

function normalizeInfoHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(hash) ? hash : '';
}

function infoHashFromMagnet(magnet) {
  const source = String(magnet || '').trim();
  if (!source) return '';

  try {
    const xt = new URL(source).searchParams.get('xt') || '';
    return normalizeInfoHash(xt.replace(/^urn:btih:/i, ''));
  } catch {
    const match = source.match(/xt=urn:btih:([a-f0-9]{40})/i);
    return normalizeInfoHash(match?.[1] || '');
  }
}

function getTorrentId(torrent) {
  const id = torrent?.torrent_id ?? torrent?.torrentId ?? torrent?.id ?? torrent?.data?.torrent_id ?? torrent?.data?.id;
  return id == null ? '' : String(id);
}

function getTorrentState(torrent) {
  return String(torrent?.download_state || torrent?.state || torrent?.status || '').toLowerCase();
}

function getTorrentProgress(torrent) {
  const number = Number(torrent?.progress ?? torrent?.download_progress ?? torrent?.percent ?? 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function isTorrentReady(torrent) {
  if (torrent?.download_finished || torrent?.download_present) return true;
  const state = getTorrentState(torrent);
  return state.includes('ready') || state.includes('seeding') || state.includes('finish') || state.includes('complet');
}

function getTorrentFiles(torrent) {
  if (Array.isArray(torrent?.files)) return torrent.files;
  if (Array.isArray(torrent?.data?.files)) return torrent.data.files;
  return [];
}

function readFileName(file) {
  return String(file?.short_name || file?.name || file?.filename || file?.path || '');
}

function buildVideoCandidates(torrent) {
  return getTorrentFiles(torrent)
    .map((file) => ({
      id: String(file?.id ?? file?.file_id ?? file?.fileId ?? ''),
      name: readFileName(file),
      size: Number(file?.size ?? file?.bytes ?? 0) || 0,
    }))
    .filter((file) => file.id && [...VIDEO_EXTENSIONS].some((ext) => file.name.toLowerCase().endsWith(ext)));
}

function findEpisodeFile(videos, season, episode) {
  if (!season || !episode) return null;

  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');

  const matches = videos.filter((video) => {
    const name = video.name.toLowerCase();
    return new RegExp(`\\bs${s}[._ -]?e${e}\\b`, 'i').test(name)
      || new RegExp(`\\b${season}x0*${episode}\\b`, 'i').test(name);
  });

  if (!matches.length) return null;
  matches.sort((a, b) => b.size - a.size);
  return matches[0];
}

function pickFileId(torrent, options = {}) {
  const videos = buildVideoCandidates(torrent);
  if (!videos.length) return null;

  const episodeHit = findEpisodeFile(videos, options.season, options.episode);
  if (episodeHit) return episodeHit.id;

  if (options.preferredFile) {
    const preferred = String(options.preferredFile).toLowerCase();
    const exact = videos.find((video) => {
      const name = video.name.toLowerCase();
      return name === preferred || name.endsWith(preferred) || preferred.endsWith(name);
    });
    if (exact) return exact.id;
  }

  videos.sort((a, b) => b.size - a.size);
  return videos[0].id;
}

function findTorrentByHash(torrents, infoHash) {
  const wanted = normalizeInfoHash(infoHash);
  if (!wanted) return null;

  return torrents.find((torrent) => {
    const hash = normalizeInfoHash(torrent?.hash || torrent?.info_hash);
    if (hash === wanted) return true;
    return infoHashFromMagnet(torrent?.magnet || torrent?.magnet_url) === wanted;
  }) || null;
}

function extractDirectLink(data) {
  const candidates = [data?.data?.url, data?.data?.link, data?.url, data?.link, data?.data];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
      return candidate;
    }
  }
  return '';
}

async function addTorrent({ apiKey, magnet }) {
  if (!String(magnet || '').startsWith('magnet:?')) {
    throw new Error('invalid magnet');
  }

  return torboxRequest({
    path: '/v1/api/torrents/createtorrent',
    method: 'POST',
    apiKey,
    body: createFormData({ magnet, allow_zip: false, as_queued: false }),
  });
}

async function getMyTorrents({ apiKey }) {
  const data = await torboxRequest({
    path: '/v1/api/torrents/mylist',
    method: 'GET',
    apiKey,
    query: { bypass_cache: 'true', limit: '1000', offset: '0' },
  });

  return Array.isArray(data?.data) ? data.data : [];
}

async function getDownloadLink({ apiKey, torrentId, fileId }) {
  const data = await torboxRequest({
    path: '/v1/api/torrents/requestdl',
    method: 'GET',
    apiKey,
    query: {
      token: apiKey,
      torrent_id: torrentId,
      file_id: fileId,
      redirect: 'false',
      zip_link: 'false',
    },
  });

  return extractDirectLink(data);
}

async function checkCached({ apiKey, infoHashes }) {
  const hashes = Array.from(new Set((infoHashes || []).map(normalizeInfoHash).filter(Boolean)));
  if (!hashes.length) return new Map();

  try {
    const data = await torboxRequest({
      path: '/v1/api/torrents/checkcached',
      method: 'GET',
      apiKey,
      query: { hash: hashes.join(','), format: 'list', list_files: 'false' },
    });

    const set = new Set((Array.isArray(data?.data) ? data.data : []).map(normalizeInfoHash));
    return new Map(hashes.map((hash) => [hash, set.has(hash)]));
  } catch {
    return new Map(hashes.map((hash) => [hash, null]));
  }
}

async function resolveLink({ apiKey, magnet, infoHash, preferredFile, season, episode, maxWaitMs = 15000 }) {
  const hash = normalizeInfoHash(infoHash) || infoHashFromMagnet(magnet);
  if (!hash) {
    const error = new Error('invalid infoHash');
    error.code = 'TORBOX_INVALID_HASH';
    throw error;
  }

  const deadline = Date.now() + Math.max(5000, maxWaitMs);
  let torrentId = '';

  const resolveFromList = async () => {
    const torrents = await getMyTorrents({ apiKey });
    const torrent = findTorrentByHash(torrents, hash);
    if (!torrent) return '';

    torrentId = torrentId || getTorrentId(torrent);
    const fileId = pickFileId(torrent, { preferredFile, season, episode });
    if (!torrentId || !fileId || !isTorrentReady(torrent)) {
      return '';
    }

    return getDownloadLink({ apiKey, torrentId, fileId });
  };

  const alreadyAvailable = await resolveFromList();
  if (alreadyAvailable) return alreadyAvailable;

  try {
    const created = await addTorrent({ apiKey, magnet });
    torrentId = torrentId || getTorrentId(created);
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    if (!message.includes('already') && !message.includes('exist')) {
      const wrapped = new Error('TorBox not ready');
      wrapped.code = 'TORBOX_NOT_READY';
      throw wrapped;
    }
  }

  while (Date.now() < deadline) {
    await sleep(2000);

    try {
      const url = await resolveFromList();
      if (url) return url;
    } catch {
      // continue polling
    }
  }

  const error = new Error('TorBox not ready');
  error.code = 'TORBOX_NOT_READY';
  throw error;
}

module.exports = {
  addTorrent,
  getMyTorrents,
  getDownloadLink,
  checkCached,
  resolveLink,
  infoHashFromMagnet,
  findTorrent: findTorrentByHash,
  getTorrentId,
  getTorrentState,
  getTorrentProgress,
  isTorrentReady,
};
