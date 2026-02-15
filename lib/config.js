const VERSION = 2;

function encodeConfig({ username, password, torboxApiKey }) {
  if (!username || !password || !torboxApiKey) {
    throw new Error('username, password and torboxApiKey are required');
  }

  const payload = JSON.stringify({ v: VERSION, u: username, p: password, t: torboxApiKey });
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

  if (!parsed || !parsed.u || !parsed.p) {
    throw new Error('invalid config token payload');
  }

  if (parsed.v === 1) {
    return { username: parsed.u, password: parsed.p, torboxApiKey: '' };
  }

  if (parsed.v !== VERSION || !parsed.t) {
    throw new Error('invalid config token payload');
  }

  return { username: parsed.u, password: parsed.p, torboxApiKey: parsed.t };
}

module.exports = {
  encodeConfig,
  decodeConfig,
};
