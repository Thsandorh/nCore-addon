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
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('root endpoint serves configure page', async () => {
  const app = createApp({ configureHtml: '<h1>ok</h1>' });
  const server = await start(app);

  const response = await request(server, '/');
  assert.equal(response.status, 200);
  assert.match(response.body, /ok/);

  server.close();
});

test('stream endpoint returns resolve URL', async () => {
  const infoHash = '0123456789abcdef0123456789abcdef01234567';
  const app = createApp({
    configureHtml: '<h1>ok</h1>',
    searchClient: async () => ([{
      title: 'Movie 1080p',
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=movie`,
      infoHash,
      seeders: 10,
      sizeBytes: 1024,
      category: 'xvid_hun',
    }]),
  });

  const server = await start(app);

  const tokenResponse = await request(server, '/api/config-token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=u&password=p&torboxApiKey=tb_key',
  });

  const token = JSON.parse(tokenResponse.body).token;
  const streamsResponse = await request(server, `/${token}/stream/movie/tt12345.json`);
  const payload = JSON.parse(streamsResponse.body);

  assert.equal(streamsResponse.status, 200);
  assert.equal(payload.streams.length, 1);
  assert.match(payload.streams[0].url, new RegExp(`/${token}/resolve/`));

  server.close();
});

test('resolve with invalid selection returns 404', async () => {
  const app = createApp({ configureHtml: '<h1>ok</h1>' });
  const server = await start(app);

  const tokenResponse = await request(server, '/api/config-token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=u&password=p&torboxApiKey=tb_key',
  });

  const token = JSON.parse(tokenResponse.body).token;
  const resolveResponse = await request(server, `/${token}/resolve/does-not-exist`);

  assert.equal(resolveResponse.status, 404);

  server.close();
});
