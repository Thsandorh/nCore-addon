const crypto = require('node:crypto');
const { filenameParse } = require('@ctrl/video-filename-parser');
const { fetch } = require('./fetch');

const NCORE_BASE = 'https://ncore.pro';
// Browser-like UA avoids some tracker-side blocks/edge-cases.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.mpg', '.mpeg', '.ts', '.m2ts']);
const SEARCH_RESULT_LIMIT = Number(process.env.NCORE_RESULT_LIMIT || 120);
const ENRICH_CONCURRENCY = Number(process.env.NCORE_META_CONCURRENCY || 6);
const DEBUG_SERIES_FILTER = String(process.env.TORBOX_DEBUG || 'false').toLowerCase() === 'true';
const SEARCH_QUERY_FORMATS = ['jsons=true', 'json=true', ''];
const LOGIN_COOKIE_TTL_MS = Math.max(30_000, Number(process.env.NCORE_COOKIE_TTL_MS || 300_000) || 300_000);
const NCORE_RETRY_ATTEMPTS = Math.max(1, Number(process.env.NCORE_RETRY_ATTEMPTS || 4) || 4);
const NCORE_RETRY_BASE_MS = Math.max(100, Number(process.env.NCORE_RETRY_BASE_MS || 650) || 650);
const NCORE_RETRY_MAX_MS = Math.max(500, Number(process.env.NCORE_RETRY_MAX_MS || 5000) || 5000);
const loginCookieCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status) {
  const code = Number(status || 0);
  return code === 429 || code >= 500;
}

function isRetriableNetworkError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('aborted') ||
    message.includes('socket') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('eai_again') ||
    message.includes('fetch failed')
  );
}

function retryDelayMs(attempt) {
  const exp = Math.min(NCORE_RETRY_MAX_MS, NCORE_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.max(80, Math.floor(exp * 0.25)));
  return exp + jitter;
}

async function fetchWithRetry(url, init, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= NCORE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (isRetriableStatus(response.status) && attempt < NCORE_RETRY_ATTEMPTS) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (!isRetriableNetworkError(error) || attempt >= NCORE_RETRY_ATTEMPTS) {
        throw error;
      }
      await sleep(retryDelayMs(attempt));
    }
  }

  if (lastError) throw lastError;
  throw new Error(`${label || 'nCore request'} failed after retries`);
}

async function loginAndSearch({ username, password, query }) {
  let cookie = await loginAndGetCookie({ username, password });
  const parsedQuery = parseStreamQuery(query);

  let rows;
  try {
    rows = await fetchAllSearchRows({ cookie, imdbId: parsedQuery.imdbId });
  } catch (error) {
    if (!isSessionFailure(error)) throw error;
    cookie = await loginAndGetCookie({ username, password, forceRefresh: true });
    rows = await fetchAllSearchRows({ cookie, imdbId: parsedQuery.imdbId });
  }
  const beforeFilterCount = rows.length;
  rows = dedupeRows(rows).slice(0, SEARCH_RESULT_LIMIT);

  const enriched = await mapLimit(rows, ENRICH_CONCURRENCY, async (row) => enrichRow({ row, cookie, parsedQuery }));
  const out = enriched.filter((item) => item && (item.magnet || item.downloadUrl));
  if (DEBUG_SERIES_FILTER && parsedQuery.season && parsedQuery.episode) {
    console.error('ncore-series-filter', {
      imdbId: parsedQuery.imdbId,
      season: parsedQuery.season,
      episode: parsedQuery.episode,
      searchRows: beforeFilterCount,
      dedupedRows: rows.length,
      outputRows: out.length,
    });
  }
  return out;
}

function getLoginCacheKey({ username, password }) {
  return crypto
    .createHash('sha1')
    .update(`${String(username || '').trim()}|${String(password || '').trim()}`)
    .digest('hex');
}

async function loginAndGetCookie({ username, password, forceRefresh = false }) {
  const cacheKey = getLoginCacheKey({ username, password });
  if (!forceRefresh) {
    const cached = loginCookieCache.get(cacheKey);
    if (cached?.expiresAt > Date.now() && cached.cookie) {
      return cached.cookie;
    }
  }

  const form = new URLSearchParams({
    nev: username,
    pass: password,
    ne_leptessen_ki: '1',
    submitted: '1',
    set_lang: 'hu',
  });

  const loginResponse = await fetchWithRetry(`${NCORE_BASE}/login.php`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
    },
    body: form.toString(),
    redirect: 'manual',
  }, 'nCore login');
  if (loginResponse.status >= 400) {
    throw new Error(`nCore login failed with status ${loginResponse.status}`);
  }

  const loginCookies = getSetCookieValues(loginResponse);
  const cookie = buildCookieHeader(loginResponse);
  if (!cookie || isFailedLoginResponse(loginResponse, loginCookies, cookie)) {
    throw new Error('nCore login failed: invalid credentials or blocked login');
  }

  loginCookieCache.set(cacheKey, {
    cookie,
    expiresAt: Date.now() + LOGIN_COOKIE_TTL_MS,
  });
  return cookie;
}

async function loginAndFetchTorrentFile({ username, password, downloadUrl }) {
  let cookie = await loginAndGetCookie({ username, password });
  try {
    return await fetchTorrentFileBuffer({ downloadUrl, cookie });
  } catch (error) {
    if (!isSessionFailure(error)) throw error;
    cookie = await loginAndGetCookie({ username, password, forceRefresh: true });
    return fetchTorrentFileBuffer({ downloadUrl, cookie });
  }
}

function isSessionFailure(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('login') ||
    message.includes('session') ||
    message.includes('blocked') ||
    message.includes('status 401') ||
    message.includes('status 403')
  );
}

function getSetCookieValues(response) {
  if (typeof response?.headers?.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }

  const raw = response?.headers?.get('set-cookie');
  if (!raw) return [];
  return String(raw)
    .split(/,(?=[^;,=\s]+=[^;,]+)/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildCookieHeader(response) {
  return getSetCookieValues(response)
    .map((value) => value.split(';')[0])
    .filter((pair) => pair && !/^(nick|pass)=deleted$/i.test(pair))
    .join('; ');
}

function isFailedLoginResponse(response, cookieLines, cookieHeader) {
  if (!cookieHeader) return true;

  const location = String(response?.headers?.get('location') || '').toLowerCase();
  if (location.includes('login.php') && /\b(problema|error|hiba)\b/.test(location)) {
    return true;
  }

  const pairs = new Map(
    (Array.isArray(cookieLines) ? cookieLines : [])
      .map((line) => String(line).split(';')[0])
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.indexOf('=');
        if (idx <= 0) return ['', ''];
        return [pair.slice(0, idx).trim().toLowerCase(), pair.slice(idx + 1).trim().toLowerCase()];
      }),
  );

  if (pairs.get('nick') === 'deleted' || pairs.get('pass') === 'deleted') {
    return true;
  }

  return !/phpsessid=/i.test(cookieHeader);
}

function parseSearchResults(body) {
  return parseSearchPayload(body).rows;
}

function parseLegacyHtmlSearchRows(body) {
  try {
    const rows = [];
    const regex = /torrents\.php\?action=details&id=(\d+)[\s\S]*?<a[^>]*>([^<]+)<[\s\S]*?href="(magnet:\?xt=urn:btih:[^"]+)"/gi;
    let match;
    while ((match = regex.exec(body))) {
      rows.push({
        id: match[1],
        title: sanitizeTitle(match[2]),
        magnet: match[3].replace(/&amp;/g, '&'),
      });
    }
    return rows;
  } catch {
    return [];
  }
}

async function fetchAllSearchRows({ cookie, imdbId }) {
  const rows = [];
  let page = 1;
  let lastPage = 1;

  do {
    let parsed = { rows: [], lastPage: 1, recognized: false };
    for (const format of SEARCH_QUERY_FORMATS) {
      const suffix = format ? `&${format}` : '';
      const searchUrl = `${NCORE_BASE}/torrents.php?mire=${encodeURIComponent(imdbId)}&miben=imdb&miszerint=seeders&hogyan=DESC&oldal=${page}${suffix}`;
      const searchResponse = await fetchWithRetry(searchUrl, {
        headers: {
          cookie,
          'user-agent': USER_AGENT,
        },
      }, 'nCore search');

      if (!searchResponse.ok) {
        throw new Error(`nCore search failed with status ${searchResponse.status}`);
      }

      const body = await searchResponse.text();
      if (isLoginPage(searchResponse.url, body)) {
        throw new Error('nCore search failed: login/session is invalid or blocked');
      }

      const candidate = parseSearchPayload(body);
      if (candidate.recognized) {
        parsed = candidate;
        break;
      }
    }

    if (!parsed.recognized && page === 1) {
      throw new Error('nCore search failed: unrecognized response format');
    }

    rows.push(...parsed.rows);
    lastPage = Math.max(lastPage, parsed.lastPage);
    page += 1;
  } while (page <= lastPage && rows.length < SEARCH_RESULT_LIMIT);

  return rows;
}

function parseSearchPayload(body) {
  try {
    const parsed = JSON.parse(body);
    if (isSearchJsonPayload(parsed)) {
      const rows = extractSearchItems(parsed)
        .map((item) => normalizeSearchRow(item))
        .filter((item) => isValidSearchRow(item));
      return { rows, lastPage: extractLastPage(parsed, rows.length), recognized: true };
    }
  } catch {
    // fallback to legacy parser
  }

  const rows = parseLegacyHtmlSearchRows(body);
  return { rows, lastPage: 1, recognized: rows.length > 0 };
}

function isSearchJsonPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  return (
    hasSearchItems(parsed) ||
    hasAnyKey(parsed, ['total_results', 'total', 'count', 'last_page', 'pages', 'perpage', 'per_page', 'oldalakszama'])
  );
}

function hasSearchItems(parsed) {
  return extractSearchItems(parsed).length > 0;
}

function extractSearchItems(parsed) {
  const candidates = [
    parsed?.results,
    parsed?.torrents,
    parsed?.items,
    parsed?.rows,
    parsed?.data,
    parsed?.data?.results,
    parsed?.data?.torrents,
    parsed?.data?.items,
    parsed?.data?.rows,
  ];

  for (const candidate of candidates) {
    const list = toSearchItemArray(candidate);
    if (list.length > 0) return list;
  }

  return [];
}

function toSearchItemArray(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  }
  if (!value || typeof value !== 'object') return [];

  const out = [];
  for (const item of Object.values(value)) {
    if (Array.isArray(item)) {
      out.push(...item.filter((row) => row && typeof row === 'object' && !Array.isArray(row)));
      continue;
    }
    if (item && typeof item === 'object') out.push(item);
  }
  return out;
}

function normalizeSearchRow(item) {
  return {
    id: String(readFirst(item, ['torrent_id', 'id', 'torrentid', 'tid']) || ''),
    title: sanitizeTitle(readFirst(item, ['release_name', 'torrent_name', 'name', 'title', 'release']) || ''),
    downloadUrl: toAbsoluteNcoreUrl(readFirst(item, ['download_url', 'downloadUrl', 'download', 'download_link', 'dl_url']) || ''),
    magnet: String(readFirst(item, ['magnet', 'magnet_url', 'magnetUrl', 'magnet_link']) || ''),
    seeders: toNumber(readFirst(item, ['seeders', 'seeds', 'seeder'])) || 0,
    sizeBytes: toNumber(readFirst(item, ['size', 'size_bytes', 'bytes', 'meret'])) || 0,
    category: String(readFirst(item, ['category', 'cat', 'tipus']) || ''),
    imdbRating: String(readFirst(item, ['imdb_rating', 'imdbRating', 'imdb']) || ''),
    freeleech: toBoolean(readFirst(item, ['freeleech', 'is_freeleech', 'free'])),
  };
}

function isValidSearchRow(item) {
  return Boolean(item?.id && item?.title && (item?.downloadUrl || item?.magnet));
}

function readFirst(item, keys) {
  for (const key of keys || []) {
    if (Object.prototype.hasOwnProperty.call(item || {}, key) && item[key] != null && item[key] !== '') {
      return item[key];
    }
  }
  return '';
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const normalized = value.replace(/[^\d.-]/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'igen';
}

function extractLastPage(parsed, rowCount) {
  const direct = toNumber(readFirst(parsed, ['last_page', 'lastpage', 'pages', 'page_count', 'oldalakszama']));
  if (direct > 0) return Math.max(1, Math.floor(direct));

  const total = toNumber(readFirst(parsed, ['total_results', 'total', 'count', 'total_count']));
  const perPage = toNumber(readFirst(parsed, ['perpage', 'per_page', 'page_size', 'limit']));
  if (total > 0 && perPage > 0) return Math.max(1, Math.ceil(total / perPage));

  void rowCount;
  return 1;
}

function hasAnyKey(obj, keys) {
  return (keys || []).some((key) => Object.prototype.hasOwnProperty.call(obj || {}, key));
}

function isLoginPage(finalUrl, body) {
  const final = String(finalUrl || '').toLowerCase();
  if (final.includes('/login.php')) return true;

  const html = String(body || '').toLowerCase();
  return html.includes('name="nev"') && html.includes('name="pass"') && html.includes('login.php');
}

function dedupeRows(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    const key = row?.id || `${row?.title || ''}|${row?.downloadUrl || row?.magnet || ''}`;
    if (!key) continue;
    if (!byId.has(key)) byId.set(key, row);
  }
  return Array.from(byId.values());
}

async function enrichRow({ row, cookie, parsedQuery }) {
  const isSeriesRequest = Boolean(parsedQuery?.season && parsedQuery?.episode);
  if (!row.downloadUrl && row.magnet) {
    try {
      const streamMeta = streamMetaFromMagnet(row.magnet);
      return {
        ...row,
        infoHash: streamMeta.infoHash,
        sources: streamMeta.sources,
      };
    } catch {
      return row;
    }
  }

  if (!row.downloadUrl) return row;

  try {
    const torrent = await fetchTorrentMeta({ downloadUrl: row.downloadUrl, cookie });
    if (isSeriesRequest) {
      const picked = findSeriesVideoFile(torrent.videoFiles || [], parsedQuery.season, parsedQuery.episode);
      if (!picked) return null;
      torrent.fileIdx = picked.index;
      torrent.fileName = picked.name;
    }

    const magnet = torrentToMagnet(torrent);
    const streamMeta = streamMetaFromMagnet(magnet);

    return {
      ...row,
      infoHash: streamMeta.infoHash,
      sources: streamMeta.sources,
      magnet,
      fileIdx: torrent.fileIdx,
      fileName: torrent.fileName,
    };
  } catch {
    if (row.magnet) {
      try {
        const streamMeta = streamMetaFromMagnet(row.magnet);
        return {
          ...row,
          infoHash: streamMeta.infoHash,
          sources: streamMeta.sources,
        };
      } catch {
        return row;
      }
    }

    return row;
  }
}

async function mapLimit(items, limit, iteratee) {
  const all = Array.isArray(items) ? items : [];
  const size = Math.max(1, Number(limit) || 1);
  const result = new Array(all.length);
  let cursor = 0;

  async function worker() {
    while (cursor < all.length) {
      const i = cursor;
      cursor += 1;
      result[i] = await iteratee(all[i], i);
    }
  }

  const workers = [];
  const workerCount = Math.min(size, all.length);
  for (let i = 0; i < workerCount; i += 1) workers.push(worker());
  await Promise.all(workers);
  return result;
}

function parseStreamQuery(query) {
  const parts = String(query || '').split(':');
  const imdbId = parts[0] || '';
  const season = toPositiveInt(parts[1]);
  const episode = toPositiveInt(parts[2]);
  return { imdbId, season, episode };
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function findSeriesVideoFile(files, season, episode) {
  for (const file of files || []) {
    const name = String(file?.name || '');
    if (isSampleOrTrash(name)) continue;

    let parsed;
    try {
      parsed = filenameParse(name, true);
    } catch {
      continue;
    }

    if (!parsed || !('isTv' in parsed)) continue;
    const seasons = Array.isArray(parsed.seasons) ? parsed.seasons : [];
    const episodes = Array.isArray(parsed.episodeNumbers) ? parsed.episodeNumbers : [];
    if (seasons.includes(Number(season)) && episodes.includes(Number(episode))) {
      return file;
    }
  }
  return null;
}

function isSampleOrTrash(fileName) {
  if (!isVideoFile(fileName)) return true;
  const normalizedName = String(fileName || '').toLowerCase();
  const base = normalizedName.replace(/\.[^.]+$/, '');
  return /(^sample|sample$|sample-|-sample-|-sample)/.test(base);
}

async function fetchTorrentMeta({ downloadUrl, cookie }) {
  const data = await fetchTorrentFileBuffer({ downloadUrl, cookie });
  return parseTorrentMeta(data);
}

async function fetchTorrentFileBuffer({ downloadUrl, cookie }) {
  const response = await fetchWithRetry(downloadUrl, {
    headers: {
      cookie,
      'user-agent': USER_AGENT,
    },
  }, 'nCore torrent download');

  if (!response.ok) {
    throw new Error(`torrent download failed with status ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function parseTorrentMeta(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer[0] !== 0x64) {
    throw new Error('invalid torrent data');
  }

  let offset = 1;
  let infoStart = -1;
  let infoEnd = -1;
  let announce = '';
  let announceList = [];

  while (offset < buffer.length && buffer[offset] !== 0x65) {
    const keyToken = readByteString(buffer, offset);
    const key = keyToken.value.toString('utf8');
    offset = keyToken.next;

    if (key === 'info') {
      infoStart = offset;
      infoEnd = skipBencodeValue(buffer, offset);
      offset = infoEnd;
      continue;
    }

    if (key === 'announce') {
      const valueToken = readByteString(buffer, offset);
      announce = valueToken.value.toString('utf8');
      offset = valueToken.next;
      continue;
    }

    if (key === 'announce-list') {
      const listToken = parseBencodeValue(buffer, offset);
      announceList = flattenAnnounceList(listToken.value);
      offset = listToken.next;
      continue;
    }

    offset = skipBencodeValue(buffer, offset);
  }

  if (infoStart < 0 || infoEnd <= infoStart) {
    throw new Error('missing info dictionary in torrent');
  }

  const infoRaw = buffer.slice(infoStart, infoEnd);
  const infoHash = crypto.createHash('sha1').update(infoRaw).digest('hex');
  const info = parseBencodeValue(buffer, infoStart).value;
  const bestFile = resolveBestVideoFile(info);
  const videoFiles = resolveVideoFiles(info);

  const trackers = Array.from(new Set([announce, ...announceList].filter(Boolean)))
    .filter((tracker) => isSupportedTrackerUrl(tracker));

  return { infoHash, trackers, fileIdx: bestFile.index, fileName: bestFile.name, videoFiles };
}

function readByteString(buffer, offset) {
  let cursor = offset;
  while (cursor < buffer.length && buffer[cursor] >= 0x30 && buffer[cursor] <= 0x39) {
    cursor += 1;
  }

  if (cursor === offset || cursor >= buffer.length || buffer[cursor] !== 0x3a) {
    throw new Error('invalid bencode byte string');
  }

  const len = Number(buffer.slice(offset, cursor).toString('ascii'));
  const start = cursor + 1;
  const end = start + len;

  if (!Number.isFinite(len) || len < 0 || end > buffer.length) {
    throw new Error('invalid bencode byte string length');
  }

  return {
    value: buffer.slice(start, end),
    next: end,
  };
}

function skipBencodeValue(buffer, offset) {
  const token = parseBencodeValue(buffer, offset, true);
  return token.next;
}

function parseBencodeValue(buffer, offset, skipOnly = false) {
  const code = buffer[offset];

  if (code === 0x69) {
    const end = buffer.indexOf(0x65, offset + 1);
    if (end === -1) throw new Error('invalid bencode integer');
    return { value: skipOnly ? undefined : Number(buffer.slice(offset + 1, end).toString('ascii')), next: end + 1 };
  }

  if (code === 0x6c) {
    let cursor = offset + 1;
    const list = [];
    while (cursor < buffer.length && buffer[cursor] !== 0x65) {
      const token = parseBencodeValue(buffer, cursor, skipOnly);
      if (!skipOnly) list.push(token.value);
      cursor = token.next;
    }
    if (cursor >= buffer.length) throw new Error('invalid bencode list');
    return { value: skipOnly ? undefined : list, next: cursor + 1 };
  }

  if (code === 0x64) {
    let cursor = offset + 1;
    const obj = {};
    while (cursor < buffer.length && buffer[cursor] !== 0x65) {
      const keyToken = readByteString(buffer, cursor);
      const key = keyToken.value.toString('utf8');
      cursor = keyToken.next;
      const valueToken = parseBencodeValue(buffer, cursor, skipOnly);
      if (!skipOnly) obj[key] = valueToken.value;
      cursor = valueToken.next;
    }
    if (cursor >= buffer.length) throw new Error('invalid bencode dictionary');
    return { value: skipOnly ? undefined : obj, next: cursor + 1 };
  }

  if (code >= 0x30 && code <= 0x39) {
    const token = readByteString(buffer, offset);
    return {
      value: skipOnly ? undefined : token.value.toString('utf8'),
      next: token.next,
    };
  }

  throw new Error('invalid bencode token');
}

function flattenAnnounceList(value) {
  if (!Array.isArray(value)) return [];

  const trackers = [];
  for (const entry of value) {
    if (Array.isArray(entry)) {
      for (const nested of entry) {
        if (typeof nested === 'string') trackers.push(nested);
      }
      continue;
    }

    if (typeof entry === 'string') trackers.push(entry);
  }

  return trackers;
}

function resolveBestVideoFile(info) {
  if (!info || typeof info !== 'object') {
    return { index: undefined, name: undefined };
  }

  const singleFileLength = Number(info.length);
  if (Number.isFinite(singleFileLength) && singleFileLength > 0) {
    return {
      index: 0,
      name: readString(info['name.utf-8']) || readString(info.name),
    };
  }

  if (!Array.isArray(info.files) || info.files.length === 0) {
    return { index: undefined, name: undefined };
  }

  const candidates = info.files.map((file, index) => {
    const length = Number(file?.length) || 0;
    const path = joinPath(file?.['path.utf-8']) || joinPath(file?.path) || '';
    return { index, length, name: path, isVideo: isVideoFile(path) };
  });

  const videos = candidates.filter((item) => item.isVideo);
  if (videos.length === 0) {
    return { index: undefined, name: undefined };
  }

  videos.sort((a, b) => b.length - a.length);
  return { index: videos[0].index, name: videos[0].name };
}

function resolveVideoFiles(info) {
  if (!info || typeof info !== 'object') return [];

  const singleFileLength = Number(info.length);
  if (Number.isFinite(singleFileLength) && singleFileLength > 0) {
    const name = readString(info['name.utf-8']) || readString(info.name);
    return isVideoFile(name) ? [{ index: 0, name, length: singleFileLength }] : [];
  }

  if (!Array.isArray(info.files) || info.files.length === 0) return [];

  return info.files
    .map((file, index) => ({
      index,
      length: Number(file?.length) || 0,
      name: joinPath(file?.['path.utf-8']) || joinPath(file?.path) || '',
    }))
    .filter((file) => isVideoFile(file.name));
}

function joinPath(pathValue) {
  if (Array.isArray(pathValue)) {
    return pathValue.map((part) => readString(part)).filter(Boolean).join('/');
  }

  return readString(pathValue);
}

function readString(value) {
  if (typeof value === 'string') return value;
  return '';
}

function isVideoFile(filename) {
  const lowered = String(filename).toLowerCase();
  for (const ext of VIDEO_EXTENSIONS) {
    if (lowered.endsWith(ext)) return true;
  }
  return false;
}

function sanitizeTitle(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function toAbsoluteNcoreUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';

  if (/^https?:\/\//i.test(input)) return input;
  if (input.startsWith('/')) return `${NCORE_BASE}${input}`;
  return `${NCORE_BASE}/${input}`;
}

function torrentToMagnet(torrent) {
  const params = [`xt=urn:btih:${encodeURIComponent(torrent.infoHash)}`];

  if (torrent.fileName) {
    params.push(`dn=${encodeURIComponent(torrent.fileName)}`);
  }

  for (const tracker of torrent.trackers || []) {
    params.push(`tr=${encodeURIComponent(tracker)}`);
  }

  return `magnet:?${params.join('&')}`;
}

function streamMetaFromMagnet(magnet) {
  const url = new URL(magnet);
  const xt = url.searchParams.get('xt') || '';
  const infoHash = xt.replace(/^urn:btih:/i, '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(infoHash)) {
    throw new Error('invalid magnet infoHash');
  }

  const trackers = url.searchParams
    .getAll('tr')
    .map((value) => value.trim())
    .filter((value) => isSupportedTrackerUrl(value));
  const expandedTrackers = expandTrackerVariants(trackers);
  const sources = Array.from(
    new Set(expandedTrackers.map((tracker) => `tracker:${tracker}`)),
  );
  return { infoHash, sources };
}

function isSupportedTrackerUrl(value) {
  return /^(udp|http|https|ws|wss):\/\//i.test(String(value || ''));
}

function expandTrackerVariants(trackers) {
  return Array.from(new Set((Array.isArray(trackers) ? trackers : []).filter(Boolean)));
}


module.exports = {
  loginAndSearch,
  loginAndFetchTorrentFile,
  parseSearchResults,
  parseTorrentMeta,
  torrentToMagnet,
  streamMetaFromMagnet,
};
