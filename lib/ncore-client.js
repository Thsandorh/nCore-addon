const crypto = require('node:crypto');
const { fetch } = require('./fetch');

const NCORE_BASE = 'https://ncore.pro';
// Browser-like UA avoids some tracker-side blocks/edge-cases.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.mpg', '.mpeg', '.ts', '.m2ts']);

async function loginAndSearch({ username, password, query }) {
  const form = new URLSearchParams({
    nev: username,
    pass: password,
    ne_leptessen_ki: '1',
    submitted: '1',
    set_lang: 'hu',
  });

  const loginResponse = await fetch(`${NCORE_BASE}/login.php`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
    },
    body: form.toString(),
    redirect: 'manual',
  });

  const cookie = buildCookieHeader(loginResponse);
  if (!cookie) {
    throw new Error('nCore login failed: invalid credentials or blocked login');
  }

  const imdbId = String(query || '').split(':')[0];
  const searchUrl = `${NCORE_BASE}/torrents.php?mire=${encodeURIComponent(imdbId)}&miben=imdb&miszerint=seeders&hogyan=DESC&jsons=true`;

  const searchResponse = await fetch(searchUrl, {
    headers: {
      cookie,
      'user-agent': USER_AGENT,
    },
  });

  if (!searchResponse.ok) {
    throw new Error(`nCore search failed with status ${searchResponse.status}`);
  }

  const body = await searchResponse.text();
  const rows = parseSearchResults(body).slice(0, 30);

  return Promise.all(rows.map(async (row) => {
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
  }));
}

function buildCookieHeader(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    const values = response.headers.getSetCookie();
    if (values.length > 0) {
      return values
        .map((value) => value.split(';')[0])
        .filter(Boolean)
        .join('; ');
    }
  }

  const raw = response.headers.get('set-cookie');
  if (!raw) return '';

  const pairs = [...raw.matchAll(/(?:^|,\s*)([^=;,\s]+=[^;,\s]+)/g)]
    .map((match) => match[1])
    .filter(Boolean);

  return pairs.join('; ');
}

function parseSearchResults(body) {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed.results)) {
      return parsed.results.map((item) => ({
        id: String(item.torrent_id || ''),
        title: sanitizeTitle(item.release_name || item.torrent_name || ''),
        downloadUrl: toAbsoluteNcoreUrl(item.download_url || ''),
        magnet: String(item.magnet || item.magnet_url || ''),
        seeders: Number(item.seeders) || 0,
        sizeBytes: Number(item.size) || 0,
        category: String(item.category || ''),
        imdbRating: String(item.imdb_rating || ''),
        freeleech: Boolean(item.freeleech),
      })).filter((item) => item.id && item.title && (item.downloadUrl || item.magnet));
    }
  } catch {
    // fallback to legacy html parsing below
  }

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
}

async function fetchTorrentMeta({ downloadUrl, cookie }) {
  const response = await fetch(downloadUrl, {
    headers: {
      cookie,
      'user-agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`torrent download failed with status ${response.status}`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  return parseTorrentMeta(data);
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

  const trackers = Array.from(new Set([announce, ...announceList].filter(Boolean)))
    .filter((tracker) => isSupportedTrackerUrl(tracker));

  return { infoHash, trackers, fileIdx: bestFile.index, fileName: bestFile.name };
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
  parseSearchResults,
  parseTorrentMeta,
  torrentToMagnet,
  streamMetaFromMagnet,
};
