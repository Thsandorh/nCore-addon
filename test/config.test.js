const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeConfig, decodeConfig } = require('../lib/config');

test('encode/decode config roundtrip', () => {
  const token = encodeConfig({ username: 'alice', password: 'secret' });
  const decoded = decodeConfig(token);
  assert.deepEqual(decoded, { username: 'alice', password: 'secret' });
});

test('decode invalid token throws', () => {
  assert.throws(() => decodeConfig('x'), /invalid config token/);
});
