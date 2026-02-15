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
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('root endpoint serves configure page', async () => {
  const app = createApp({ configureHtml: '<h1>root ok</h1>' });
  const server = await start(app);
  const res = await request(server, '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /root ok/);
  server.close();
});

test('configure endpoint works', async () => {
  const app = createApp({ configureHtml: '<h1>ok</h1>' });
  const server = await start(app);
  const res = await request(server, '/configure');
  assert.equal(res.status, 200);
  assert.match(res.body, /ok/);
  server.close();
});

test('stream endpoint returns resolve URL with selection cache key', async () => {
  const infoHash = '0123456789abcdef0123456789abcdef01234567';
  const app = createApp({
    configureHtml: 'ok',
    searchClient: async () => ([{
      id: '42',
      title: 'Movie 1080p',
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=x`,
      infoHash,
      seeders: 10,
      sizeBytes: 1024,
      category: 'xvid',
    }]),
  });
  const server = await start(app);

  const tokenRes = await request(server, '/api/config-token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=u&password=p&torboxApiKey=tb_key',
  });

  const token = JSON.parse(tokenRes.body).token;
  const streamRes = await request(server, `/${token}/stream/movie/tt12345.json`);
  const parsed = JSON.parse(streamRes.body);

  assert.equal(streamRes.status, 200);
  assert.equal(parsed.streams.length, 1);
  assert.match(parsed.streams[0].url, new RegExp(`/${token}/resolve/`));

  server.close();
});

test('resolve endpoint with unknown key fails with 404', async () => {
  const app = createApp({ configureHtml: 'ok', searchClient: async () => [] });
  const server = await start(app);

  const tokenRes = await request(server, '/api/config-token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=u&password=p&torboxApiKey=tb_key',
  });
  const token = JSON.parse(tokenRes.body).token;

  const resolveRes = await request(server, `/${token}/resolve/not-found.mp4`);
  const payload = JSON.parse(resolveRes.body);

  assert.equal(resolveRes.status, 404);
  assert.match(payload.error, /not found/i);

  server.close();
});
