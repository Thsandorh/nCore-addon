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

test('stream endpoint returns resolve URL with selection key and inline payload', async () => {
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
  assert.match(parsed.streams[0].url, /_eyJ/);

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

test('resolve redirects to TorBox media URL for GET', async () => {
  const infoHash = 'abababababababababababababababababababab';
  let resolved = 0;
  const app = createApp({
    configureHtml: 'ok',
    searchClient: async () => ([{
      id: '707',
      title: 'Mandatory Enqueue',
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=Mandatory+Enqueue`,
      infoHash,
      seeders: 1,
      sizeBytes: 1111,
      category: 'xvid',
      fileName: '',
    }]),
    torboxResolver: async () => {
      resolved += 1;
      return { url: 'https://media.example/enqueued-playback.mp4' };
    },
  });

  const server = await start(app);
  const tokenRes = await request(server, '/api/config-token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=u&password=p&torboxApiKey=tb_key',
  });
  const token = JSON.parse(tokenRes.body).token;

  const streamRes = await request(server, `/${token}/stream/movie/tt12345.json`);
  const streams = JSON.parse(streamRes.body).streams;
  const resolveUrl = new URL(streams[0].url);

  const resolveRes = await request(server, resolveUrl.pathname + resolveUrl.search);
  assert.equal(resolveRes.status, 302);
  assert.equal(resolveRes.headers.location, 'https://media.example/enqueued-playback.mp4');
  assert.equal(resolved, 1);

  server.close();
});

test('resolve returns 204 for HEAD without invoking resolver', async () => {
  const infoHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  let resolved = 0;
  const app = createApp({
    configureHtml: 'ok',
    searchClient: async () => ([{
      id: '808',
      title: 'Head Enqueue',
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=Head+Enqueue`,
      infoHash,
      seeders: 1,
      sizeBytes: 1111,
      category: 'xvid',
      fileName: '',
    }]),
    torboxResolver: async () => {
      resolved += 1;
      return { url: 'https://media.example/head.mp4' };
    },
  });

  const server = await start(app);
  const tokenRes = await request(server, '/api/config-token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=u&password=p&torboxApiKey=tb_key',
  });
  const token = JSON.parse(tokenRes.body).token;

  const streamRes = await request(server, `/${token}/stream/movie/tt12345.json`);
  const streams = JSON.parse(streamRes.body).streams;
  const resolveUrl = new URL(streams[0].url);

  const headRes = await request(server, resolveUrl.pathname + resolveUrl.search, { method: 'HEAD' });
  assert.equal(headRes.status, 204);
  assert.equal(resolved, 0);

  server.close();
});


test('resolve redirects cached torrents and skips enqueue', async () => {
  const infoHash = 'dddddddddddddddddddddddddddddddddddddddd';
  let resolved = 0;
  const app = createApp({
    configureHtml: 'ok',
    searchClient: async () => ([{
      id: '909',
      title: 'Cached Playback',
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=Cached+Playback`,
      infoHash,
      seeders: 5,
      sizeBytes: 2222,
      category: 'xvid',
      fileName: 'Cached.Playback.1080p.mkv',
    }]),
    torboxCachedChecker: async () => new Map([[infoHash, true]]),
    torboxResolver: async () => {
      resolved += 1;
      return { url: 'https://media.example/cached-playback.mp4' };
    },
  });

  const server = await start(app);
  const tokenRes = await request(server, '/api/config-token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=u&password=p&torboxApiKey=tb_key',
  });
  const token = JSON.parse(tokenRes.body).token;

  const streamRes = await request(server, `/${token}/stream/movie/tt12345.json`);
  const streams = JSON.parse(streamRes.body).streams;
  const resolveUrl = new URL(streams[0].url);

  const resolveRes = await request(server, resolveUrl.pathname + resolveUrl.search);

  assert.equal(resolveRes.status, 302);
  assert.equal(resolveRes.headers.location, 'https://media.example/cached-playback.mp4');
  assert.equal(resolved, 1);

  server.close();
});

test('resolve can recover selection from inline stateless payload', async () => {
  const infoHash = 'cccccccccccccccccccccccccccccccccccccccc';
  let resolved = 0;
  const app = createApp({
    configureHtml: 'ok',
    searchClient: async () => ([{
      id: '303',
      title: 'Stateless Resolve Recovery',
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=Stateless+Resolve+Recovery`,
      infoHash,
      seeders: 4,
      sizeBytes: 2000,
      category: 'xvid',
      fileName: '',
    }]),
    torboxResolver: async () => {
      resolved += 1;
      return { url: 'https://media.example/recovered.mp4' };
    },
  });

  const server = await start(app);
  const tokenRes = await request(server, '/api/config-token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=u&password=p&torboxApiKey=tb_key',
  });
  const token = JSON.parse(tokenRes.body).token;

  const streamRes = await request(server, `/${token}/stream/movie/tt12345.json`);
  const streams = JSON.parse(streamRes.body).streams;
  const original = new URL(streams[0].url);
  const encoded = original.pathname.split('/resolve/')[1].split('_').slice(1).join('_');
  const recoveredPath = `/${token}/resolve/fakeSelectionKey_${encoded}`;

  const resolveRes = await request(server, recoveredPath);
  assert.equal(resolveRes.status, 302);
  assert.equal(resolveRes.headers.location, 'https://media.example/recovered.mp4');
  assert.equal(resolved, 1);

  server.close();
});

test('resolve returns 429 when TorBox resolve reports ACTIVE_LIMIT', async () => {
  const infoHash = 'ffffffffffffffffffffffffffffffffffffffff';
  const app = createApp({
    configureHtml: 'ok',
    searchClient: async () => ([{
      id: '606',
      title: 'Queue Limit Test',
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=Queue+Limit+Test`,
      infoHash,
      seeders: 1,
      sizeBytes: 999,
      category: 'xvid',
      fileName: '',
    }]),
    torboxResolver: async () => {
      const err = new Error('limit');
      err.response = { error: 'ACTIVE_LIMIT' };
      throw err;
    },
  });

  const server = await start(app);
  const tokenRes = await request(server, '/api/config-token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=u&password=p&torboxApiKey=tb_key',
  });
  const token = JSON.parse(tokenRes.body).token;

  const streamRes = await request(server, `/${token}/stream/movie/tt12345.json`);
  const streams = JSON.parse(streamRes.body).streams;
  const resolveUrl = new URL(streams[0].url);

  const resolveRes = await request(server, resolveUrl.pathname + resolveUrl.search);
  const payload = JSON.parse(resolveRes.body);

  assert.equal(resolveRes.status, 429);
  assert.match(payload.error, /queue limit/i);

  server.close();
});
