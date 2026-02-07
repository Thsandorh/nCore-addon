const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../api/app');

function start(app) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => app(req, res));
    server.listen(0, () => resolve(server));
  });
}

function request(server, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: options.method || 'GET',
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      headers: options.headers,
    }, (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('configure endpoint works', async () => {
  const app = createApp({ configureHtml: '<h1>ok</h1>' });
  const server = await start(app);
  const res = await request(server, '/configure');
  assert.equal(res.status, 200);
  assert.match(res.body, /ok/);
  server.close();
});

test('stream endpoint returns streams with mock client', async () => {
  const app = createApp({
    configureHtml: 'ok',
    searchClient: async () => ([{ title: 'Movie', magnet: 'magnet:?xt=urn:btih:abc123&dn=x' }]),
  });
  const server = await start(app);

  const tokenRes = await request(server, '/api/config-token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=u&password=p',
  });

  const token = JSON.parse(tokenRes.body).token;
  const streamRes = await request(server, `/${token}/stream/movie/tt12345.json`);
  const parsed = JSON.parse(streamRes.body);

  assert.equal(streamRes.status, 200);
  assert.equal(parsed.streams.length, 1);
  assert.equal(parsed.streams[0].infoHash, 'abc123');
  server.close();
});
