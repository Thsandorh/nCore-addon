const crypto = require('node:crypto');
const { encodeConfig, decodeConfig } = require('../lib/config');
const { loginAndSearch } = require('../lib/ncore-client');

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
  const value = String(magnet || '');
  const match = value.match(/xt=urn:btih:([a-fA-F0-9]{40})/i);
  if (!match) return '';
  return match[1].toLowerCase();
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

  return async function app(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/configure')) {
      if (configureHtml) return html(res, 200, configureHtml);
      return html(res, 500, 'Missing configure.html');
    }

    if (req.method === 'POST' && url.pathname === '/api/config-token') {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      const username = params.get('username') || '';
      const password = params.get('password') || '';
      try {
        const token = encodeConfig({ username, password });
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

    const streamMatch = url.pathname.match(/^\/([^/]+)\/stream\/([^/]+)\/([^/.]+)\.json$/);
    if (req.method === 'GET' && streamMatch) {
      const token = streamMatch[1];
      const imdbId = String(streamMatch[3]).split(':')[0];

      try {
        const creds = decodeConfig(token);
        const results = await searchClient({ username: creds.username, password: creds.password, query: imdbId });

        const streams = results
          .map((item) => {
            const magnet = normalizeMagnet(item.magnet);
            const infoHash = String(item.infoHash || extractInfoHashFromMagnet(magnet) || '').toLowerCase();
            if (!/^[a-f0-9]{40}$/.test(infoHash)) return null;

            const quality = inferQualityFromTitle(item.title);
            const category = toReadableCategory(item.category);
            const size = formatSize(item.sizeBytes);

            const line1 = [`S:${Number(item.seeders) || 0}`, size || '', category || '', item.freeleech ? 'Freeleech' : '']
              .filter(Boolean)
              .join(' | ');
            const line2 = [item.imdbRating ? `IMDb ${item.imdbRating}` : '', 'nCore']
              .filter(Boolean)
              .join(' | ');
            const descriptionLines = [item.title, line1, line2].filter(Boolean);

            const stream = {
              name: quality ? `nCore\n${quality}` : 'nCore',
              title: descriptionLines.join('\n'),
              infoHash,
            };

            if (magnet) {
              stream.sources = [magnet];
            }

            if (Number.isInteger(item.fileIdx) && item.fileIdx >= 0) {
              stream.fileIdx = item.fileIdx;
            }

            return stream;
          })
          .filter(Boolean);

        return json(res, 200, { streams });
      } catch (error) {
        return json(res, 200, { streams: [] });
      }
    }

    return json(res, 404, { error: 'Not found' });
  };
}

module.exports = { createApp, manifestTemplate };
