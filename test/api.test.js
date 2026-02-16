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

test('resolve endpoint does not reuse stale resolved URL cache between calls', async () => {
  const infoHash = '89abcdef0123456789abcdef0123456789abcdef';
  let resolveCallCount = 0;
  const app = createApp({
    configureHtml: 'ok',
    searchClient: async () => ([{
      id: '77',
      title: 'Movie 2160p',
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=x`,
      infoHash,
      seeders: 20,
      sizeBytes: 2048,
      category: 'xvid',
    }]),
    torboxResolver: async () => {
      resolveCallCount += 1;
      return { url: `https://video.example/${resolveCallCount}` };
    },
    torboxCachedChecker: async () => new Map([[infoHash, false]]),
    torboxMyListFetcher: async () => [],
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
  assert.equal(parsed.streams.length, 1);

  const resolvePath = new URL(parsed.streams[0].url).pathname;
  const firstResolve = await request(server, resolvePath);
  const secondResolve = await request(server, resolvePath);

  assert.equal(firstResolve.status, 302);
  assert.equal(secondResolve.status, 302);
  assert.equal(firstResolve.headers.location, 'https://video.example/1');
  assert.equal(secondResolve.headers.location, 'https://video.example/2');
  assert.equal(resolveCallCount, 2);

  server.close();
});


test('resolve uses stream title as fallback name when fileName is missing', async () => {
  const infoHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let resolverArgs = null;
  const app = createApp({
    configureHtml: 'ok',
    searchClient: async () => ([{
      id: '101',
      title: 'Fallback Name 1080p',
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=Fallback+Name+From+Magnet`,
      infoHash,
      seeders: 1,
      sizeBytes: 1000,
      category: 'xvid',
      fileName: '',
    }]),
    torboxCachedChecker: async () => new Map([[infoHash, false]]),
    torboxMyListFetcher: async () => [],
    torboxResolver: async (args) => {
      resolverArgs = args;
      return { url: 'https://video.example/file.mp4', subtitles: [] };
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
  assert.equal(streams.length, 1);

  const resolvePath = new URL(streams[0].url).pathname;
  const resolveRes = await request(server, resolvePath);
  assert.equal(resolveRes.status, 302);
  assert.equal(resolveRes.headers.location, 'https://video.example/file.mp4');
  assert.equal(resolverArgs.fileName, 'Fallback Name 1080p');

  server.close();
});


test('resolve endpoint accepts HEAD and still triggers torbox resolver', async () => {
  const infoHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  let resolverCalls = 0;
  const app = createApp({
    configureHtml: 'ok',
    searchClient: async () => ([{
      id: '202',
      title: 'Head Resolve Test',
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=Head+Resolve+Test`,
      infoHash,
      seeders: 1,
      sizeBytes: 1000,
      category: 'xvid',
      fileName: '',
    }]),
    torboxCachedChecker: async () => new Map([[infoHash, false]]),
    torboxMyListFetcher: async () => [],
    torboxResolver: async () => {
      resolverCalls += 1;
      return { url: 'https://video.example/head.mp4', subtitles: [] };
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
  assert.equal(streams.length, 1);

  const resolvePath = new URL(streams[0].url).pathname;
  const headRes = await request(server, resolvePath, { method: 'HEAD' });
  assert.equal(headRes.status, 302);
  assert.equal(headRes.headers.location, 'https://video.example/head.mp4');
  assert.equal(resolverCalls, 1);

  server.close();
});


test('resolve can recover selection from stateless query payload', async () => {
  const infoHash = 'cccccccccccccccccccccccccccccccccccccccc';
  let resolverCalls = 0;
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
    torboxCachedChecker: async () => new Map([[infoHash, false]]),
    torboxMyListFetcher: async () => [],
    torboxResolver: async () => {
      resolverCalls += 1;
      return { url: 'https://video.example/stateless.mp4', subtitles: [] };
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
  assert.equal(streams.length, 1);

  const original = new URL(streams[0].url);
  const recoveredPath = `/${token}/resolve/fakeSelectionKey?s=${encodeURIComponent(original.searchParams.get('s'))}`;
  const resolveRes = await request(server, recoveredPath);

  assert.equal(resolveRes.status, 302);
  assert.equal(resolveRes.headers.location, 'https://video.example/stateless.mp4');
  assert.equal(resolverCalls, 1);

  server.close();
});


test('stream resolve URL defaults to https origin when forwarded proto is missing', async () => {
  const infoHash = 'dddddddddddddddddddddddddddddddddddddddd';
  const app = createApp({
    configureHtml: 'ok',
    searchClient: async () => ([{
      id: '404',
      title: 'Proto Default Test',
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=Proto+Default+Test`,
      infoHash,
      seeders: 2,
      sizeBytes: 1500,
      category: 'xvid',
    }]),
    torboxCachedChecker: async () => new Map([[infoHash, false]]),
    torboxMyListFetcher: async () => [],
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
  assert.equal(streams.length, 1);
  assert.match(streams[0].url, /^https:\/\//);

  server.close();
});


test('resolve returns 429 when TorBox resolver reports ACTIVE_LIMIT', async () => {
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
    torboxCachedChecker: async () => new Map([[infoHash, false]]),
    torboxMyListFetcher: async () => [],
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
  assert.equal(streams.length, 1);

  const resolvePath = new URL(streams[0].url).pathname + new URL(streams[0].url).search;
  const resolveRes = await request(server, resolvePath);
  const payload = JSON.parse(resolveRes.body);

  assert.equal(resolveRes.status, 429);
  assert.match(payload.error, /queue limit/i);

  server.close();
});
