const VERSION = 1;

function encodeConfig({ username, password }) {
  if (!username || !password) throw new Error('username and password are required');
  const payload = JSON.stringify({ v: VERSION, u: username, p: password });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeConfig(token) {
  if (!token) throw new Error('missing config token');
  let json;
  try {
    json = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    throw new Error('invalid config token encoding');
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('invalid config token json');
  }

  if (parsed.v !== VERSION || !parsed.u || !parsed.p) {
    throw new Error('invalid config token payload');
  }

  return { username: parsed.u, password: parsed.p };
}

module.exports = {
  encodeConfig,
  decodeConfig,
};
