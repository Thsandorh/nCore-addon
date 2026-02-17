'use strict';

const crypto = require('node:crypto');
const { encodeConfig, decodeConfig } = require('../lib/config');
const { loginAndSearch } = require('../lib/ncore-client');
const {
  addTorrent,
  checkCached,
  getMyTorrents,
  resolveLink,
  infoHashFromMagnet,
  isTorrentReady,
  getTorrentState,
  getTorrentProgress,
} = require('../lib/torbox-client');

const MANIFEST = {
  id: 'community.ncore.web',
  version: '2.0.0',
  name: 'nCore + TorBox',
  description: 'nCore torrent keresés és TorBox direct stream feloldás.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: true },
};

const SETUP_MANIFEST = {
  ...MANIFEST,
  id: 'community.ncore.web.setup',
  name: 'nCore + TorBox (Setup)',
  resources: [],
  types: [],
  description: 'Nyisd meg a /configure oldalt, majd telepítsd a tokenes manifestet.',
};

const selectionStore = new Map();
const resolveStore = new Map();
const resolveInFlight = new Map();
const myListStore = new Map();

const TTL_SELECTION_MS = 90 * 60 * 1000;
const TTL_RESOLVE_MS = 20 * 60 * 1000;
const TTL_MYLIST_MS = 15 * 1000;

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function sendHtml(res, statusCode, html) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

function parseBasePath(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/g, '');
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function getOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || 'http';
  return `${protocol}://${req.headers.host || 'localhost'}`;
}

function pruneExpiredEntries() {
  const now = Date.now();

  for (const [key, value] of selectionStore.entries()) {
    if (value.expiresAt <= now) selectionStore.delete(key);
  }

  for (const [key, value] of resolveStore.entries()) {
    if (value.expiresAt <= now) resolveStore.delete(key);
  }

  for (const [key, value] of myListStore.entries()) {
    if (value.expiresAt <= now) myListStore.delete(key);
  }
}

function parseStreamId(rawId) {
  const parts = String(rawId || '').split(':');
  const season = Number(parts[1]);
  const episode = Number(parts[2]);
  return {
    raw: String(rawId || ''),
    imdbId: parts[0] || '',
    season: Number.isInteger(season) && season > 0 ? season : null,
    episode: Number.isInteger(episode) && episode > 0 ? episode : null,
  };
}

function normalizeMagnet(value) {
  const magnet = String(value || '').trim();
  return /^magnet:\?/i.test(magnet) ? magnet : '';
}

function normalizeHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(hash) ? hash : '';
}

function deriveInfoHash(inputMagnet, inputHash) {
  const direct = normalizeHash(inputHash);
  if (direct) return direct;
  return normalizeHash(infoHashFromMagnet(inputMagnet));
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unitIndex = 0;

  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  const precision = amount >= 10 || unitIndex === 0 ? 0 : 1;
  return `${amount.toFixed(precision)} ${units[unitIndex]}`;
}

function inferQuality(title) {
  const normalized = String(title || '').toLowerCase();
  if (normalized.includes('2160') || normalized.includes('4k') || normalized.includes('uhd')) return '2160p';
  if (normalized.includes('1080')) return '1080p';
  if (normalized.includes('720')) return '720p';
  return '';
}

function readableCategory(value) {
  return String(value || '').split('_').filter(Boolean).map((chunk) => chunk.toUpperCase()).join(' ');
}

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 16);
}

function buildStreamTitle(item, statusLine) {
  const details = [
    `S:${Number(item.seeders) || 0}`,
    formatBytes(item.sizeBytes),
    readableCategory(item.category),
    item.freeleech ? 'Freeleech' : '',
  ].filter(Boolean).join(' | ');

  const scoreLine = item.imdbRating ? `IMDb ${item.imdbRating} | nCore + TorBox` : 'nCore + TorBox';

  return [item.title, statusLine, details, scoreLine].filter(Boolean).join('\n');
}

async function getMyListMap(apiKey, fetcher) {
  const cacheKey = shortHash(apiKey);
  const cached = myListStore.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const list = await withTimeout(fetcher({ apiKey }), 2500);
  const map = new Map();
  for (const torrent of list || []) {
    const hash = normalizeHash(torrent?.hash || torrent?.info_hash);
    if (hash) map.set(hash, torrent);
  }

  myListStore.set(cacheKey, {
    value: map,
    expiresAt: Date.now() + TTL_MYLIST_MS,
  });

  return map;
}

function buildStatusInfo({ inMyList, cachedFlag }) {
  if (inMyList) {
    if (isTorrentReady(inMyList)) {
      return { tag: '[READY]', line: 'TorBox: Ready ⚡' };
    }

    const state = getTorrentState(inMyList) || 'downloading';
    const progress = getTorrentProgress(inMyList);
    const suffix = progress ? ` ${progress}%` : '';
    return {
      tag: `[${state.toUpperCase()}${suffix}]`,
      line: `TorBox: ${state}${suffix}`,
    };
  }

  if (cachedFlag === true) return { tag: '[CACHED]', line: 'TorBox: Cached ⚡' };
  if (cachedFlag === false) return { tag: '[UNCACHED]', line: 'TorBox: Uncached (queue on play)' };
  return { tag: '[?]', line: 'TorBox: Unknown cache state' };
}

function buildManifestForToken(token) {
  const suffix = crypto.createHash('sha1').update(token).digest('hex').slice(0, 12);
  return { ...MANIFEST, id: `community.ncore.web.${suffix}` };
}

function createApp(deps = {}) {
  const configureHtml = deps.configureHtml || '';
  const searchClient = deps.searchClient || loginAndSearch;
  const torboxCachedChecker = deps.torboxCachedChecker || checkCached;
  const torboxMyListFetcher = deps.torboxMyListFetcher || getMyTorrents;
  const torboxResolver = deps.torboxResolver || resolveLink;
  const torboxAdder = deps.torboxAdder || addTorrent;

  return async function app(req, res) {
    pruneExpiredEntries();

    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = requestUrl.pathname;

    if (req.method === 'GET' && path === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && (path === '/' || path === '/configure')) {
      return sendHtml(res, 200, configureHtml || '<h1>Missing configure.html</h1>');
    }

    if (req.method === 'POST' && path === '/api/config-token') {
      const body = await readBody(req);
      const form = new URLSearchParams(body);

      try {
        const token = encodeConfig({
          username: form.get('username') || '',
          password: form.get('password') || '',
          torboxApiKey: form.get('torboxApiKey') || '',
        });
        return sendJson(res, 200, { token });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === 'GET' && path === '/manifest.json') {
      return sendJson(res, 200, SETUP_MANIFEST);
    }

    const manifestMatch = path.match(/^\/([^/]+)\/manifest\.json$/);
    if (req.method === 'GET' && manifestMatch) {
      try {
        decodeConfig(manifestMatch[1]);
        return sendJson(res, 200, buildManifestForToken(manifestMatch[1]));
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === 'GET' && /^\/stream\/[^/]+\/[^/.]+\.json$/.test(path)) {
      return sendJson(res, 200, { streams: [] });
    }

    const resolveMatch = path.match(/^\/([^/]+)\/resolve\/([^/.]+)(?:\.[^/]+)?$/);
    if ((req.method === 'GET' || req.method === 'HEAD') && resolveMatch) {
      const token = resolveMatch[1];
      const selectionId = resolveMatch[2];
      const resolveKey = `${token}|${selectionId}`;

      try {
        const credentials = decodeConfig(token);
        if (!credentials.torboxApiKey) {
          return sendJson(res, 400, { error: 'Missing TorBox API key' });
        }

        const cachedResolve = resolveStore.get(resolveKey);
        if (cachedResolve && cachedResolve.expiresAt > Date.now()) {
          res.statusCode = 302;
          res.setHeader('location', cachedResolve.url);
          return res.end();
        }

        const selection = selectionStore.get(selectionId);
        if (!selection || selection.token !== token || selection.expiresAt <= Date.now()) {
          return sendJson(res, 404, { error: 'Selection not found or expired' });
        }

        const magnet = normalizeMagnet(selection.magnet);
        const infoHash = deriveInfoHash(magnet, selection.infoHash);
        if (!magnet || !infoHash) {
          return sendJson(res, 422, { error: 'Invalid magnet or infoHash' });
        }

        try {
          const map = await withTimeout(torboxCachedChecker({ apiKey: credentials.torboxApiKey, infoHashes: [infoHash] }), 1600);
          if (map.has(infoHash)) {
            selection.cached = map.get(infoHash);
          }
        } catch {
          // keep previous state
        }

        // Always do a best-effort queue add before resolve. This avoids getting
        // stuck on stale cached=false state and handles torrents that just became available.
        try {
          await torboxAdder({ apiKey: credentials.torboxApiKey, magnet });
        } catch {
          // ignore, torrent may already be present in mylist
        }

        let inFlight = resolveInFlight.get(resolveKey);
        if (!inFlight) {
          inFlight = torboxResolver({
            apiKey: credentials.torboxApiKey,
            magnet,
            infoHash,
            preferredFile: selection.preferredFile,
            season: selection.season,
            episode: selection.episode,
            maxWaitMs: 15000,
          });
          resolveInFlight.set(resolveKey, inFlight);
        }

        let resolvedUrl;
        try {
          resolvedUrl = await inFlight;
        } finally {
          resolveInFlight.delete(resolveKey);
        }

        if (!resolvedUrl) {
          return sendJson(res, 502, { error: 'TorBox did not return a direct link' });
        }

        resolveStore.set(resolveKey, {
          url: resolvedUrl,
          expiresAt: Date.now() + TTL_RESOLVE_MS,
        });

        res.statusCode = 302;
        res.setHeader('location', resolvedUrl);
        return res.end();
      } catch (error) {
        if (error.code === 'TORBOX_NOT_READY') {
          res.setHeader('retry-after', '30');
          return sendJson(res, 409, { error: 'TorBox is still preparing this torrent.' });
        }
        return sendJson(res, 502, { error: error.message || 'Resolve failed' });
      }
    }

    const streamMatch = path.match(/^\/([^/]+)\/stream\/([^/]+)\/([^/.]+)\.json$/);
    if (req.method === 'GET' && streamMatch) {
      const token = streamMatch[1];
      const parsedId = parseStreamId(streamMatch[3]);

      try {
        const credentials = decodeConfig(token);
        if (!credentials.torboxApiKey) return sendJson(res, 200, { streams: [] });

        const results = await searchClient({
          username: credentials.username,
          password: credentials.password,
          query: parsedId.raw,
        });

        const myListMap = await getMyListMap(credentials.torboxApiKey, torboxMyListFetcher).catch(() => new Map());

        const hashesToCheck = results
          .slice(0, 30)
          .map((item) => deriveInfoHash(normalizeMagnet(item.magnet), item.infoHash))
          .filter(Boolean);

        const cachedMap = await withTimeout(
          torboxCachedChecker({ apiKey: credentials.torboxApiKey, infoHashes: hashesToCheck }),
          2200,
        ).catch(() => new Map());

        const origin = getOrigin(req);
        const basePath = parseBasePath(process.env.APP_BASE_PATH || '');

        const streams = [];
        for (const item of results.slice(0, 30)) {
          const magnet = normalizeMagnet(item.magnet);
          const infoHash = deriveInfoHash(magnet, item.infoHash);
          if (!magnet || !infoHash) continue;

          const inMyList = myListMap.get(infoHash) || null;
          const cachedFlag = inMyList
            ? isTorrentReady(inMyList)
            : (cachedMap.has(infoHash) ? cachedMap.get(infoHash) : null);

          const selectionId = crypto.randomBytes(9).toString('base64url');
          selectionStore.set(selectionId, {
            token,
            magnet,
            infoHash,
            preferredFile: parsedId.season && parsedId.episode ? null : item.fileName,
            season: parsedId.season,
            episode: parsedId.episode,
            cached: cachedFlag,
            expiresAt: Date.now() + TTL_SELECTION_MS,
          });

          const quality = inferQuality(item.title);
          const statusInfo = buildStatusInfo({ inMyList, cachedFlag });

          streams.push({
            name: `nCore\nTorBox ${[statusInfo.tag, quality].filter(Boolean).join(' ')}`,
            title: buildStreamTitle(item, statusInfo.line),
            url: `${origin}${basePath}/${token}/resolve/${selectionId}`,
            behaviorHints: {
              notWebReady: true,
              bingeGroup: `ncore-torbox-${quality || 'default'}`,
            },
          });
        }

        return sendJson(res, 200, { streams });
      } catch {
        return sendJson(res, 200, { streams: [] });
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  };
}

module.exports = {
  createApp,
  manifestTemplate: MANIFEST,
};
