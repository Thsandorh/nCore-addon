const crypto = require('node:crypto');
const { encodeConfig, decodeConfig } = require('../lib/config');
const { loginAndSearch } = require('../lib/ncore-client');
const {
  resolveTorboxLinkWithWait,
  checkCachedAvailability,
  listMyTorrents,
  readTorboxInfoHash,
  readTorboxState,
  readTorboxProgress,
  isTorboxReady,
} = require('../lib/torbox-client');

const manifestTemplate = {
  id: 'community.ncore.web',
  version: '1.0.1',
  name: 'nCore Web Addon',
  description: 'nCore stream addon with web configure page',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: true },
};

const setupManifest = {
  ...manifestTemplate,
  id: 'community.ncore.web.setup',
  name: 'nCore Web Addon (Setup)',
  description: 'Open /configure and install the generated personal manifest URL.',
  resources: [],
  types: [],
};

const RESOLVE_CACHE_TTL_MS = 1000 * 60 * 20;
const STREAM_SELECTION_TTL_MS = 1000 * 60 * 90;
const TORBOX_MYLIST_TTL_MS = 1000 * 15;
const resolveCache = new Map();
const resolveInFlight = new Map();
const streamSelectionCache = new Map();
const torboxMyListCache = new Map(); // apiKeyHash -> { expiresAt, torrents }

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

function pruneResolveCache() {
  const now = Date.now();
  for (const [key, value] of resolveCache.entries()) {
    if (!value || value.expiresAt <= now) {
      resolveCache.delete(key);
    }
  }

  for (const [key, value] of streamSelectionCache.entries()) {
    if (!value || value.expiresAt <= now) {
      streamSelectionCache.delete(key);
    }
  }

  for (const [key, value] of torboxMyListCache.entries()) {
    if (!value || value.expiresAt <= now) torboxMyListCache.delete(key);
  }
}

function createStreamSelection({ token, item, parsedId, cached }) {
  const selectionKey = crypto.randomBytes(9).toString('base64url');
  streamSelectionCache.set(selectionKey, {
    token,
    torrentId: String(item.id || '').trim(),
    magnet: normalizeMagnet(item.magnet),
    infoHash: String(item.infoHash || '').toLowerCase(),
    fileName: item.fileName,
    season: parsedId.season,
    episode: parsedId.episode,
    cached: cached === true ? true : (cached === false ? false : null),
    expiresAt: Date.now() + STREAM_SELECTION_TTL_MS,
  });
  return selectionKey;
}

function getRequestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function normalizeBasePath(value) {
  if (!value) return '';
  let basePath = String(value).trim();
  if (!basePath || basePath === '/') return '';
  if (!basePath.startsWith('/')) basePath = `/${basePath}`;
  basePath = basePath.replace(/\/+$/g, '');
  return basePath === '/' ? '' : basePath;
}

function getConfiguredManifest(token) {
  const suffix = crypto.createHash('sha1').update(String(token)).digest('hex').slice(0, 12);
  return {
    ...manifestTemplate,
    id: `community.ncore.web.${suffix}`,
  };
}

function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function inferQualityFromTitle(title) {
  const text = String(title || '').toLowerCase();
  if (text.includes('2160') || text.includes('4k') || text.includes('uhd')) return '2160p';
  if (text.includes('1080')) return '1080p';
  if (text.includes('720')) return '720p';
  return '';
}

function toReadableCategory(category) {
  const normalized = String(category || '').toLowerCase();
  if (!normalized) return '';

  return normalized
    .split('_')
    .map((part) => part.toUpperCase())
    .join(' ');
}

function normalizeMagnet(value) {
  const magnet = String(value || '').trim();
  if (!/^magnet:\?/i.test(magnet)) return '';
  return magnet;
}

function extractInfoHashFromMagnet(magnet) {
  const value = String(magnet || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    const xt = String(url.searchParams.get('xt') || '');
    const raw = xt.replace(/^urn:btih:/i, '').trim();
    if (/^[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
    return '';
  } catch {
    return '';
  }
}

function hashTorboxKey(apiKey) {
  return crypto.createHash('sha1').update(String(apiKey || '')).digest('hex').slice(0, 16);
}

function parseStreamId(id) {
  const raw = String(id || '');
  const parts = raw.split(':');
  const imdbId = parts[0] || '';
  const season = Number(parts[1]);
  const episode = Number(parts[2]);
  return {
    raw,
    imdbId,
    season: Number.isInteger(season) && season > 0 ? season : null,
    episode: Number.isInteger(episode) && episode > 0 ? episode : null,
  };
}

function isEpisodeReleaseMatch(title, season, episode) {
  if (!season || !episode) return true;
  const line = String(title || '').toLowerCase();
  if (!line) return false;

  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');

  const direct = [
    new RegExp(`\\bs${s}\\s*[._\\- ]?e${e}\\b`, 'i'),
    new RegExp(`\\b${season}\\s*[x]\\s*0*${episode}\\b`, 'i'),
    new RegExp(`\\bseason\\s*0*${season}\\s*(?:episode|ep|e)\\s*0*${episode}\\b`, 'i'),
  ].some((re) => re.test(line));

  if (!direct) return false;

  const range = [
    new RegExp(`\\bs${s}\\s*[._\\- ]?e${e}\\s*-\\s*e?\\d{1,2}\\b`, 'i'),
    new RegExp(`\\b${season}\\s*[x]\\s*0*${episode}\\s*-\\s*\\d{1,2}\\b`, 'i'),
    new RegExp(`\\bs${s}\\s*[._\\- ]?e${e}\\s*e\\d{1,2}\\b`, 'i'),
  ].some((re) => re.test(line));

  return !range;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

function createApp(deps = {}) {
  const searchClient = deps.searchClient || loginAndSearch;
  const configureHtml = deps.configureHtml;
  const torboxCachedChecker = deps.torboxCachedChecker || checkCachedAvailability;
  const torboxMyListFetcher = deps.torboxMyListFetcher || listMyTorrents;
  const torboxResolver = deps.torboxResolver || resolveTorboxLinkWithWait;

  return async function app(req, res) {
    pruneResolveCache();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    
    // Log all requests
    const timestamp = new Date().toISOString().substring(11, 19);
    console.log(`[${timestamp}] ${req.method} ${url.pathname.substring(0, 100)}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        node: process.version,
      });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/configure')) {
      if (configureHtml) return html(res, 200, configureHtml);
      return html(res, 500, 'Missing configure.html');
    }

    if (req.method === 'POST' && url.pathname === '/api/config-token') {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      const username = params.get('username') || '';
      const password = params.get('password') || '';
      const torboxApiKey = params.get('torboxApiKey') || '';
      try {
        const token = encodeConfig({ username, password, torboxApiKey });
        return json(res, 200, { token });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    if (req.method === 'GET' && url.pathname === '/manifest.json') {
      return json(res, 200, setupManifest);
    }

    const manifestMatch = url.pathname.match(/^\/([^/]+)\/manifest\.json$/);
    if (req.method === 'GET' && manifestMatch) {
      try {
        decodeConfig(manifestMatch[1]);
        return json(res, 200, getConfiguredManifest(manifestMatch[1]));
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    const streamNoConfigMatch = url.pathname.match(/^\/stream\/([^/]+)\/([^/.]+)\.json$/);
    if (req.method === 'GET' && streamNoConfigMatch) {
      return json(res, 200, { streams: [] });
    }

    const resolveMatch = url.pathname.match(/^\/([^/]+)\/resolve\/([^/.]+)(?:\.[^/]+)?$/);
    if (req.method === 'GET' && resolveMatch) {
      const token = resolveMatch[1];
      const selectionKey = resolveMatch[2];
      const resolveKey = `${token}|${selectionKey}`;

      console.log(`[RESOLVE] Request for selectionKey: ${selectionKey}`);

      try {
        const creds = decodeConfig(token);
        if (!creds.torboxApiKey) {
          return json(res, 400, { error: 'missing torbox api key' });
        }

        const cached = resolveCache.get(resolveKey);
        if (cached && cached.expiresAt > Date.now() && cached.url) {
          res.statusCode = 302;
          res.setHeader('location', cached.url);
          return res.end();
        }

        const selection = streamSelectionCache.get(selectionKey);
        if (!selection || selection.expiresAt <= Date.now() || selection.token !== token) {
          console.log(`[RESOLVE] Selection not found or expired`);
          return json(res, 404, { error: 'selected torrent not found or expired' });
        }

        console.log(`[RESOLVE] Selection found: ${selection.fileName || 'N/A'}, infoHash: ${selection.infoHash.substring(0, 8)}...`);

        const selected = {
          magnet: selection.magnet,
          infoHash: selection.infoHash,
          fileName: selection.fileName,
        };

        const magnet = normalizeMagnet(selected.magnet);
        const infoHash = String(selected.infoHash || extractInfoHashFromMagnet(magnet) || '').toLowerCase();
    if (!magnet || !infoHash) {
      return json(res, 422, { error: 'selected torrent has no usable magnet/infohash' });
    }

        // Refresh cached state at resolve time (Stremio caches stream lists).
        let isCached = selection.cached;
        try {
          const cachedMap = await withTimeout(
            torboxCachedChecker({ apiKey: creds.torboxApiKey, infoHashes: [infoHash] }),
            1500,
          );
          if (cachedMap.has(infoHash)) isCached = Boolean(cachedMap.get(infoHash));
        } catch {
          // ignore
        }

        let maxWaitMs = 600_000; // 10 min default
        if (isCached === true) maxWaitMs = 30_000;
        if (isCached === false) maxWaitMs = 600_000;

        let promise = resolveInFlight.get(resolveKey);
        if (!promise) {
          promise = torboxResolver({
            apiKey: creds.torboxApiKey,
            magnet,
            infoHash,
            fileName: (selection.season && selection.episode) ? null : selected.fileName,
            season: selection.season,
            episode: selection.episode,
            includeSubtitles: false,
            maxWaitMs,
          });
          resolveInFlight.set(resolveKey, promise);
        }

        let resolved;
        try {
          console.log(`[RESOLVE] Calling TorBox resolver... (cached: ${isCached}, maxWait: ${maxWaitMs}ms)`);
          resolved = await promise;
          console.log(`[RESOLVE] TorBox resolver success: ${resolved?.url ? 'Got URL' : 'No URL'}`);
        } finally {
          resolveInFlight.delete(resolveKey);
        }

        if (!resolved || !resolved.url) {
          console.log(`[RESOLVE] Failed to resolve torbox url`);
          return json(res, 502, { error: 'failed to resolve torbox url' });
        }

        resolveCache.set(resolveKey, {
          url: resolved.url,
          expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS,
        });

        console.log(`[RESOLVE] Redirecting to video URL (302)`);
        res.statusCode = 302;
        res.setHeader('location', resolved.url);
        return res.end();
      } catch (error) {
        console.log(`[RESOLVE] Error: ${error.message}, code: ${error.code || 'N/A'}`);
        if (error && error.code === 'TORBOX_NOT_READY') {
          res.setHeader('retry-after', '10');
          return json(res, 409, { error: error.message || 'TorBox not ready' });
        }
        return json(res, 502, { error: error.message || 'resolve failed' });
      }
    }

    const streamMatch = url.pathname.match(/^\/([^/]+)\/stream\/([^/]+)\/([^/.]+)\.json$/);
    if (req.method === 'GET' && streamMatch) {
      const token = streamMatch[1];
      const parsedId = parseStreamId(streamMatch[3]);
      try {
        const creds = decodeConfig(token);
        if (!creds.torboxApiKey) {
          return json(res, 200, { streams: [] });
        }

        const results = await searchClient({ username: creds.username, password: creds.password, query: parsedId.raw });
        const filteredResults = results;
        const origin = getRequestOrigin(req);
        const appBasePath = normalizeBasePath(process.env.APP_BASE_PATH || '');

        // Pull TorBox mylist (cached briefly) so we can label already-downloaded items as cached/ready,
        // even if they are not in the global instant cache.
        let torboxStateByHash = new Map(); // infoHash -> { ready, state, progress }
        try {
          const key = hashTorboxKey(creds.torboxApiKey);
          const cachedList = torboxMyListCache.get(key);
          let torrents;
          if (cachedList && cachedList.expiresAt > Date.now() && Array.isArray(cachedList.torrents)) {
            torrents = cachedList.torrents;
          } else {
            torrents = await withTimeout(
              torboxMyListFetcher({ apiKey: creds.torboxApiKey, bypassCache: true, limit: 400, offset: 0 }),
              1500,
            );
            torboxMyListCache.set(key, { torrents, expiresAt: Date.now() + TORBOX_MYLIST_TTL_MS });
          }

          for (const t of torrents || []) {
            const hash = readTorboxInfoHash(t);
            if (!hash) continue;
            torboxStateByHash.set(hash, {
              ready: isTorboxReady(t),
              state: readTorboxState(t),
              progress: readTorboxProgress(t),
            });
          }
        } catch {
          torboxStateByHash = new Map();
        }

        // TorBox global cache check for top results.
        let cachedMap = new Map();
        try {
          const hashes = filteredResults
            .slice(0, 30)
            .map((item) => String(item.infoHash || extractInfoHashFromMagnet(normalizeMagnet(item.magnet)) || '').toLowerCase())
            .filter(Boolean);
          cachedMap = await withTimeout(
            torboxCachedChecker({ apiKey: creds.torboxApiKey, infoHashes: hashes }),
            2000,
          );
          for (const h of hashes) if (!cachedMap.has(h)) cachedMap.set(h, false);
        } catch {
          cachedMap = new Map();
        }

        const streams = [];
        for (const item of filteredResults.slice(0, 30)) {
          const magnet = normalizeMagnet(item.magnet);
          const infoHash = String(item.infoHash || extractInfoHashFromMagnet(magnet) || '').toLowerCase();
          if (!magnet || !infoHash) continue;

          const own = torboxStateByHash.get(infoHash) || null;
          let cached = cachedMap.has(infoHash) ? Boolean(cachedMap.get(infoHash)) : null;
          if (own && own.ready) cached = true;
          if (own && !own.ready) cached = false;

          const selectionKey = createStreamSelection({ token, item, parsedId, cached });

          const quality = inferQualityFromTitle(item.title);
          const category = toReadableCategory(item.category);
          const size = formatSize(item.sizeBytes);
          const cacheLine = own && !own.ready
            ? `TorBox: ${own.state || 'processing'}${Number.isFinite(own.progress) ? ` ${Math.round(own.progress)}%` : ''}`
            : (cached === true ? 'TorBox: Cached' : (cached === false ? 'TorBox: Uncached (will download)' : 'TorBox: Unknown'));
          const line1 = [`S:${Number(item.seeders) || 0}`, size || '', category || '', item.freeleech ? 'Freeleech' : '']
            .filter(Boolean)
            .join(' | ');
          const line2 = [item.imdbRating ? `IMDb ${item.imdbRating}` : '', 'nCore + TorBox']
            .filter(Boolean)
            .join(' | ');

          const resolveUrl = `${origin}${appBasePath}/${token}/resolve/${selectionKey}`;
          const cacheTag = own && !own.ready
            ? `[${String(own.state || 'processing').toUpperCase()}${Number.isFinite(own.progress) ? ` ${Math.round(own.progress)}%` : ''}]`
            : (cached === true ? '[CACHED]' : (cached === false ? '[UNCACHED]' : '[UNKNOWN]'));

          streams.push({
            name: [cacheTag, quality].filter(Boolean).length > 0
              ? `nCore\nTorBox ${[cacheTag, quality].filter(Boolean).join(' ')}`
              : 'nCore\nTorBox',
            title: [item.title, cacheLine, line1, line2].filter(Boolean).join('\n'),
            url: resolveUrl,
            behaviorHints: {
              notWebReady: true,
              bingeGroup: `nCore-TorBox-${quality || 'default'}`,
            },
          });
        }

        return json(res, 200, { streams });
      } catch (error) {
        return json(res, 200, { streams: [] });
      }
    }

    return json(res, 404, { error: 'Not found' });
  };
}

module.exports = { createApp, manifestTemplate };

