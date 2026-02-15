const TORBOX_BASES = ['https://api.torbox.app/v1', 'https://api.torbox.app'];
const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.mpg', '.mpeg', '.ts', '.m2ts']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function fetchJsonWithAuth({ path, method = 'GET', apiKey, query = {}, body = undefined, headers = {} }) {
  let lastError;

  for (const base of TORBOX_BASES) {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    try {
      const response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...headers,
        },
        body,
      });

      const text = await response.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text };
      }

      if (response.ok) return parsed;
      lastError = new Error(`TorBox request failed (${response.status})`);
      lastError.response = parsed;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('TorBox request failed');
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

function findTorrentInList(listPayload, infoHash) {
  const list = getFirstObjectArray(listPayload);
  if (list.length === 0) return null;

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

async function createTorrentFromMagnet({ apiKey, magnet }) {
  const paths = ['/api/torrents/createtorrent', '/torrents/createtorrent'];
  const attempts = [
    { body: new URLSearchParams({ magnet }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    { body: new URLSearchParams({ magnet_link: magnet }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    { body: JSON.stringify({ magnet }), headers: { 'content-type': 'application/json' } },
    { body: JSON.stringify({ magnet_link: magnet }), headers: { 'content-type': 'application/json' } },
  ];

  let lastError;
  for (const path of paths) {
    for (const attempt of attempts) {
      try {
        const payload = await fetchJsonWithAuth({
          path,
          method: 'POST',
          apiKey,
          body: attempt.body,
          headers: attempt.headers,
        });
        return payload;
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error('Failed to create TorBox torrent');
}

async function requestDownloadLink({ apiKey, torrentId, fileId }) {
  const querySets = [
    { token: apiKey, torrent_id: torrentId, file_id: fileId, redirect: 'false' },
    { token: apiKey, torrentId, fileId, redirect: 'false' },
    { torrent_id: torrentId, file_id: fileId, redirect: 'false' },
  ];
  const paths = ['/api/torrents/requestdl', '/torrents/requestdl'];

  let lastError;
  for (const path of paths) {
    for (const query of querySets) {
      try {
        const payload = await fetchJsonWithAuth({
          path,
          method: 'GET',
          apiKey,
          query,
        });

        const link = pickDownloadUrl(payload);
        if (link) return link;
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error('Failed to request TorBox download link');
}

async function resolveTorboxLink({
  apiKey,
  magnet,
  infoHash,
  fileName,
  season,
  episode,
  includeSubtitles = false,
}) {
  const targetHash = String(infoHash || extractInfoHash(magnet)).toLowerCase();
  if (!apiKey) throw new Error('missing TorBox API key');
  if (!targetHash) throw new Error('missing infoHash');
  if (!magnet) throw new Error('missing magnet');

  const created = await createTorrentFromMagnet({ apiKey, magnet });
  let torrentId = pickTorrentId(created);

  let chosen = null;
  const listPaths = ['/api/torrents/mylist', '/torrents/mylist'];

  for (let attempt = 0; attempt < 7; attempt += 1) {
    let listPayload = null;
    for (const path of listPaths) {
      try {
        listPayload = await fetchJsonWithAuth({
          path,
          method: 'GET',
          apiKey,
          query: { bypass_cache: 'true' },
        });
        if (listPayload) break;
      } catch {
        // try next path variant
      }
    }

    chosen = findTorrentInList(listPayload, targetHash);
    if (chosen) {
      torrentId = torrentId || pickTorrentId(chosen);
      const fileId = chooseFileIdFromTorrent(chosen, fileName, season, episode);
      if (torrentId && fileId) {
        const url = await requestDownloadLink({ apiKey, torrentId, fileId });
        if (!includeSubtitles) {
          return { url, subtitles: [] };
        }

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
            // Skip failed subtitle links.
          }
        }

        return { url, subtitles };
      }
    }

    if (attempt < 6) {
      await sleep(1000);
    }
  }

  if (!torrentId) throw new Error('TorBox torrent id not found');
  throw new Error('TorBox file id not found');
}

module.exports = {
  resolveTorboxLink,
};

