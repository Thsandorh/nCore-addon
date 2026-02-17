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

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const MANIFEST = {
  id: 'community.ncore.web',
  version: '1.0.1',
  name: 'nCore Web Addon',
  description: 'nCore + TorBox stream addon',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: true },
};

const SETUP_MANIFEST = {
  ...MANIFEST,
  id: 'community.ncore.web.setup',
  name: 'nCore Web Addon (Setup)',
  description: 'Nyisd meg a /configure oldalt a beállításhoz.',
  resources: [],
  types: [],
};

// ---------------------------------------------------------------------------
// Cache-ek (folyamat-szintű memória)
// ---------------------------------------------------------------------------

const resolveCache    = new Map(); // resolveKey  → { url, expiresAt }
const resolveInFlight = new Map(); // resolveKey  → Promise<string>
const selections      = new Map(); // selectionKey → adatok
const myListCache     = new Map(); // apiKeyHash  → { list, expiresAt }

const RESOLVE_TTL   = 20 * 60 * 1000;
const SELECTION_TTL = 90 * 60 * 1000;
const MYLIST_TTL    =      15 * 1000;

function pruneCache() {
  const now = Date.now();
  for (const [k, v] of resolveCache) if (v.expiresAt <= now) resolveCache.delete(k);
  for (const [k, v] of selections)   if (v.expiresAt <= now) selections.delete(k);
  for (const [k, v] of myListCache)  if (v.expiresAt <= now) myListCache.delete(k);
}

// ---------------------------------------------------------------------------
// HTTP segédek
// ---------------------------------------------------------------------------

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(body);
}

async function readBody(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', c => { s += c; });
    req.on('end', () => resolve(s));
  });
}

// ---------------------------------------------------------------------------
// Kis segédek
// ---------------------------------------------------------------------------

function getOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  return `${proto}://${req.headers.host || 'localhost'}`;
}

function parseBasePath(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s || s === '/') return '';
  return s.startsWith('/') ? s : `/${s}`;
}

function parseStreamId(raw) {
  const parts   = String(raw || '').split(':');
  const season  = Number(parts[1]);
  const episode = Number(parts[2]);
  return {
    raw,
    imdbId:  parts[0] || '',
    season:  Number.isInteger(season)  && season  > 0 ? season  : null,
    episode: Number.isInteger(episode) && episode > 0 ? episode : null,
  };
}

function normalizeMagnet(v) {
  const s = String(v || '').trim();
  return /^magnet:\?/i.test(s) ? s : '';
}

function extractHash(magnet) {
  try {
    const xt  = new URL(magnet).searchParams.get('xt') || '';
    const raw = xt.replace(/^urn:btih:/i, '').trim();
    if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toLowerCase();
  } catch { /* */ }
  return infoHashFromMagnet(magnet);
}

function formatSize(bytes) {
  const n = Number(bytes);
  if (!n || !Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function inferQuality(title) {
  const t = String(title || '').toLowerCase();
  if (t.includes('2160') || t.includes('4k') || t.includes('uhd')) return '2160p';
  if (t.includes('1080')) return '1080p';
  if (t.includes('720'))  return '720p';
  return '';
}

function readableCategory(cat) {
  return String(cat || '').split('_').map(p => p.toUpperCase()).join(' ');
}

function shortHash(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function createApp(deps = {}) {
  const searchClient   = deps.searchClient        || loginAndSearch;
  const _checkCached   = deps.torboxCachedChecker || checkCached;
  const _getMyTorrents = deps.torboxMyListFetcher  || getMyTorrents;
  const _resolveLink   = deps.torboxResolver       || resolveLink;
  const _addTorrent    = deps.torboxAdder          || addTorrent;
  const configureHtml  = deps.configureHtml;

  return async function app(req, res) {
    pruneCache();

    const url  = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${path.slice(0, 120)}`);

    // Health
    if (req.method === 'GET' && path === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    // Configure oldal
    if (req.method === 'GET' && (path === '/' || path === '/configure')) {
      return configureHtml ? sendHtml(res, 200, configureHtml) : sendHtml(res, 500, 'Missing configure.html');
    }

    // Token generálás
    if (req.method === 'POST' && path === '/api/config-token') {
      const raw = await readBody(req);
      const p   = new URLSearchParams(raw);
      try {
        const token = encodeConfig({
          username:     p.get('username')     || '',
          password:     p.get('password')     || '',
          torboxApiKey: p.get('torboxApiKey') || '',
        });
        return sendJson(res, 200, { token });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // Setup manifest
    if (req.method === 'GET' && path === '/manifest.json') {
      return sendJson(res, 200, SETUP_MANIFEST);
    }

    // Konfigurált manifest
    const manifestM = path.match(/^\/([^/]+)\/manifest\.json$/);
    if (req.method === 'GET' && manifestM) {
      try {
        decodeConfig(manifestM[1]);
        const suffix = crypto.createHash('sha1').update(manifestM[1]).digest('hex').slice(0, 12);
        return sendJson(res, 200, { ...MANIFEST, id: `community.ncore.web.${suffix}` });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // Stream – konfig nélkül
    if (req.method === 'GET' && path.match(/^\/stream\/[^/]+\/[^/.]+\.json$/)) {
      return sendJson(res, 200, { streams: [] });
    }

    // -----------------------------------------------------------------------
    // Resolve endpoint
    // -----------------------------------------------------------------------
    const resolveM = path.match(/^\/([^/]+)\/resolve\/([^/.]+)(?:\.[^/]+)?$/);
    if ((req.method === 'GET' || req.method === 'HEAD') && resolveM) {
      const token      = resolveM[1];
      const selKey     = resolveM[2];
      const resolveKey = `${token}|${selKey}`;

      try {
        const creds = decodeConfig(token);
        if (!creds.torboxApiKey) return sendJson(res, 400, { error: 'Nincs TorBox API kulcs' });

        // Cache hit
        const hit = resolveCache.get(resolveKey);
        if (hit?.expiresAt > Date.now() && hit.url) {
          res.statusCode = 302;
          res.setHeader('location', hit.url);
          return res.end();
        }

        // Kiválasztás keresése
        const sel = selections.get(selKey);
        if (!sel || sel.expiresAt <= Date.now() || sel.token !== token) {
          return sendJson(res, 404, { error: 'Kiválasztás nem található vagy lejárt' });
        }

        const magnet   = normalizeMagnet(sel.magnet);
        const infoHash = String(sel.infoHash || extractHash(magnet) || '').toLowerCase();
        if (!magnet || !infoHash) return sendJson(res, 422, { error: 'Érvénytelen magnet/infoHash' });

        // Cache státusz frissítése
        let isCached = sel.cached;
        try {
          const map = await withTimeout(_checkCached({ apiKey: creds.torboxApiKey, infoHashes: [infoHash] }), 1500);
          if (map.has(infoHash)) isCached = Boolean(map.get(infoHash));
        } catch { /* ignore */ }

        console.log(`[RESOLVE] hash=${infoHash.slice(0, 8)}... isCached=${isCached}`);

        // UNCACHED: egyből hozzáadjuk a TorBox queue-hoz, majd 409
        if (isCached === false) {
          try {
            await _addTorrent({ apiKey: creds.torboxApiKey, magnet });
            console.log('[RESOLVE] Uncached → TorBox queue-ba rakva');
          } catch (e) {
            const msg = String(e?.message || '').toLowerCase();
            if (!msg.includes('already') && !msg.includes('exist')) {
              console.log(`[RESOLVE] addTorrent hiba: ${e.message}`);
            }
          }
          res.setHeader('retry-after', '60');
          return sendJson(res, 409, { error: 'Torrent hozzáadva. Töltés után elérhető.' });
        }

        // CACHED / ISMERETLEN: resolveLink
        let promise = resolveInFlight.get(resolveKey);
        if (!promise) {
          promise = _resolveLink({
            apiKey:        creds.torboxApiKey,
            magnet,
            infoHash,
            preferredFile: (sel.season && sel.episode) ? null : sel.fileName,
            season:        sel.season,
            episode:       sel.episode,
            maxWaitMs:     15000,
          });
          resolveInFlight.set(resolveKey, promise);
        }

        let resolvedUrl;
        try {
          resolvedUrl = await promise;
        } finally {
          resolveInFlight.delete(resolveKey);
        }

        if (!resolvedUrl) return sendJson(res, 502, { error: 'TorBox nem adott vissza URL-t' });

        resolveCache.set(resolveKey, { url: resolvedUrl, expiresAt: Date.now() + RESOLVE_TTL });
        res.statusCode = 302;
        res.setHeader('location', resolvedUrl);
        return res.end();

      } catch (e) {
        console.log(`[RESOLVE] Hiba: ${e.message} (code=${e.code})`);
        if (e.code === 'TORBOX_NOT_READY') {
          res.setHeader('retry-after', '30');
          return sendJson(res, 409, { error: 'TorBox még nem kész. Próbáld újra.' });
        }
        return sendJson(res, 502, { error: e.message || 'Feloldás sikertelen' });
      }
    }

    // -----------------------------------------------------------------------
    // Stream lista
    // -----------------------------------------------------------------------
    const streamM = path.match(/^\/([^/]+)\/stream\/([^/]+)\/([^/.]+)\.json$/);
    if (req.method === 'GET' && streamM) {
      const token    = streamM[1];
      const parsedId = parseStreamId(streamM[3]);

      try {
        const creds = decodeConfig(token);
        if (!creds.torboxApiKey) return sendJson(res, 200, { streams: [] });

        // nCore keresés
        const results = await searchClient({ username: creds.username, password: creds.password, query: parsedId.raw });

        // TorBox mylist (rövid cache)
        let myListByHash = new Map();
        try {
          const key   = shortHash(creds.torboxApiKey);
          const entry = myListCache.get(key);
          let list;
          if (entry?.expiresAt > Date.now()) {
            list = entry.list;
          } else {
            list = await withTimeout(_getMyTorrents({ apiKey: creds.torboxApiKey }), 2000);
            myListCache.set(key, { list, expiresAt: Date.now() + MYLIST_TTL });
          }
          for (const t of list || []) {
            const h = String(t?.hash || t?.info_hash || '').toLowerCase();
            if (/^[a-f0-9]{40}$/.test(h)) myListByHash.set(h, t);
          }
        } catch { /* ignore */ }

        // TorBox globális cache ellenőrzés (top 30)
        let cachedMap = new Map();
        try {
          const hashes = results.slice(0, 30)
            .map(r => String(r.infoHash || extractHash(normalizeMagnet(r.magnet)) || '').toLowerCase())
            .filter(Boolean);
          cachedMap = await withTimeout(_checkCached({ apiKey: creds.torboxApiKey, infoHashes: hashes }), 2000);
        } catch { /* ignore */ }

        const origin   = getOrigin(req);
        const basePath = parseBasePath(process.env.APP_BASE_PATH || '');
        const streams  = [];

        for (const item of results.slice(0, 30)) {
          const magnet   = normalizeMagnet(item.magnet);
          const infoHash = String(item.infoHash || extractHash(magnet) || '').toLowerCase();
          if (!magnet || !infoHash) continue;

          const inMyList   = myListByHash.get(infoHash) || null;
          const isReady    = inMyList ? isTorrentReady(inMyList) : false;
          const globalCached = cachedMap.get(infoHash) ?? null;

          // cached: true=kész, false=töltődik vagy uncached, null=ismeretlen
          let cached;
          if (isReady)                   cached = true;
          else if (inMyList)             cached = false;  // listában van de töltődik
          else if (globalCached != null) cached = globalCached;
          else                           cached = null;

          const selKey = crypto.randomBytes(9).toString('base64url');
          selections.set(selKey, {
            token, magnet, infoHash,
            fileName: item.fileName,
            season:   parsedId.season,
            episode:  parsedId.episode,
            cached,
            expiresAt: Date.now() + SELECTION_TTL,
          });

          const quality = inferQuality(item.title);
          const size    = formatSize(item.sizeBytes);
          const cat     = readableCategory(item.category);

          let tag, statusLine;
          if (inMyList && !isReady) {
            const st  = getTorrentState(inMyList);
            const pct = getTorrentProgress(inMyList);
            tag        = `[${st.toUpperCase()}${pct ? ` ${pct}%` : ''}]`;
            statusLine = `TorBox: ${st}${pct ? ` ${pct}%` : ''}`;
          } else if (cached === true) {
            tag = '[CACHED]'; statusLine = 'TorBox: Cached ⚡';
          } else if (cached === false) {
            tag = '[UNCACHED]'; statusLine = 'TorBox: Uncached – queue-ba kerül';
          } else {
            tag = '[?]'; statusLine = 'TorBox: ?';
          }

          streams.push({
            name:  `nCore\nTorBox ${[tag, quality].filter(Boolean).join(' ')}`,
            title: [
              item.title,
              statusLine,
              [`S:${Number(item.seeders) || 0}`, size, cat, item.freeleech ? 'Freeleech' : ''].filter(Boolean).join(' | '),
              item.imdbRating ? `IMDb ${item.imdbRating} | nCore + TorBox` : 'nCore + TorBox',
            ].filter(Boolean).join('\n'),
            url: `${origin}${basePath}/${token}/resolve/${selKey}`,
            behaviorHints: {
              notWebReady: true,
              bingeGroup:  `nCore-TorBox-${quality || 'default'}`,
            },
          });
        }

        return sendJson(res, 200, { streams });

      } catch (e) {
        console.log(`[STREAM] Hiba: ${e.message}`);
        return sendJson(res, 200, { streams: [] });
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  };
}

module.exports = { createApp, manifestTemplate: MANIFEST };
