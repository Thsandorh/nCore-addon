const { encodeConfig, decodeConfig } = require('../lib/config');
const { loginAndSearch } = require('../lib/ncore-client');

const manifestTemplate = {
  id: 'community.ncore.web',
  version: '1.0.0',
  name: 'nCore Web Addon',
  description: 'nCore stream addon with web configure page',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: true },
};

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

    if (req.method === 'GET' && url.pathname === '/configure') {
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
      return json(res, 200, manifestTemplate);
    }

    const manifestMatch = url.pathname.match(/^\/([^/]+)\/manifest\.json$/);
    if (req.method === 'GET' && manifestMatch) {
      try {
        decodeConfig(manifestMatch[1]);
        return json(res, 200, manifestTemplate);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    const streamMatch = url.pathname.match(/^\/([^/]+)\/stream\/(movie|series)\/([^/.]+)\.json$/);
    if (req.method === 'GET' && streamMatch) {
      const token = streamMatch[1];
      const imdbId = streamMatch[3];

      try {
        const creds = decodeConfig(token);
        const results = await searchClient({ username: creds.username, password: creds.password, query: imdbId });

        return json(res, 200, {
          streams: results.map((item) => ({
            title: item.title,
            name: 'nCore',
            infoHash: item.magnet.match(/btih:([^&]+)/i)?.[1],
            sources: [item.magnet],
          })),
        });
      } catch (error) {
        return json(res, 200, { streams: [], error: error.message });
      }
    }

    return json(res, 404, { error: 'Not found' });
  };
}

module.exports = { createApp, manifestTemplate };
