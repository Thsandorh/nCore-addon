const VERSION = 2;

function isLikelyTorboxApiKey(value) {
  const key = String(value || '').trim();
  if (!key) return false;
  if (/\s/.test(key)) return false;
  if (/[()]/.test(key)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return true;
  if (/^tb_[A-Za-z0-9_-]{10,}$/i.test(key)) return true;
  return /^[A-Za-z0-9._-]{20,128}$/.test(key);
}

function encodeConfig({ username, password, torboxApiKey }) {
  if (!username || !password || !torboxApiKey) {
    throw new Error('username, password and torboxApiKey are required');
  }
  if (!isLikelyTorboxApiKey(torboxApiKey)) {
    throw new Error('invalid torboxApiKey format');
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
  if (!isLikelyTorboxApiKey(parsed.t)) {
    throw new Error('invalid config token payload');
  }

  return { username: parsed.u, password: parsed.p, torboxApiKey: parsed.t };
}

module.exports = {
  encodeConfig,
  decodeConfig,
};
