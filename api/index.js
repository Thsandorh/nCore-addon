const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('./app');
let logInfo = (...args) => console.log(...args);
let logError = (...args) => console.error(...args);
try {
  ({ logInfo, logError } = require('../lib/logger')); // optional in older deployments
} catch {
  // Fallback to console if logger module is not deployed yet.
}

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

const configurePath = path.join(__dirname, '..', 'public', 'configure.html');
const configureHtml = fs.existsSync(configurePath)
  ? fs.readFileSync(configurePath, 'utf8')
  : '<h1>Missing configure page</h1>';

const app = createApp({ configureHtml });
const basePath = normalizeBasePath(process.env.APP_BASE_PATH);

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  http.createServer((req, res) => {
    req.url = rewriteUrlForBasePath(req.url, basePath);
    return Promise.resolve(app(req, res)).catch((error) => {
      logError('http-request-failed', error);
      if (res.headersSent) return;
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: error.message || 'Internal server error' }));
    });
  }).listen(port, () => {
    logInfo(`nCore addon listening on :${port}`);
  });
}

module.exports = (req, res) => {
  req.url = rewriteUrlForBasePath(req.url, basePath);
  return app(req, res);
};
