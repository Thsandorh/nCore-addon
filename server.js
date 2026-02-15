const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('./api/app');

function normalizeBasePath(value) {
  if (!value) return '';
  let basePath = String(value).trim();
  if (!basePath || basePath === '/') return '';
  if (!basePath.startsWith('/')) basePath = `/${basePath}`;
  basePath = basePath.replace(/\/+$/g, '');
  return basePath === '/' ? '' : basePath;
}

function rewriteUrlForBasePath(urlValue, basePath) {
  const parsed = new URL(urlValue || '/', 'http://localhost');
  if (!basePath) return `${parsed.pathname}${parsed.search}`;

  if (parsed.pathname === basePath || parsed.pathname === `${basePath}/`) {
    return `/${parsed.search}`;
  }

  if (parsed.pathname.startsWith(`${basePath}/`)) {
    return `${parsed.pathname.slice(basePath.length)}${parsed.search}`;
  }

  return `${parsed.pathname}${parsed.search}`;
}

const configurePath = path.join(__dirname, 'public', 'configure.html');
const configureHtml = fs.existsSync(configurePath)
  ? fs.readFileSync(configurePath, 'utf8')
  : '<h1>Missing configure page</h1>';

const basePath = normalizeBasePath(process.env.APP_BASE_PATH);
const app = createApp({ configureHtml });

const server = http.createServer((req, res) => {
  const rewrittenUrl = rewriteUrlForBasePath(req.url, basePath);
  if (rewrittenUrl === null) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  req.url = rewrittenUrl;
  Promise.resolve(app(req, res)).catch((error) => {
    if (res.headersSent) return;
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: error.message || 'Internal server error' }));
  });
});

{
  const port = Number(process.env.PORT || 3000);
  if (!server.listening) {
  server.listen(port, () => {
    console.log(`nCore addon listening on :${port}`);
  });
  }
}

module.exports = { app, server, normalizeBasePath, rewriteUrlForBasePath };
