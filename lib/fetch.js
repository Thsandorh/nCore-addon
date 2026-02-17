let fetchFn = global.fetch;

// Node 18+ provides global fetch. For Node 14/16 (common on shared hosting),
// fall back to undici.
if (!fetchFn) {
  try {
    // eslint-disable-next-line global-require
    fetchFn = require('undici').fetch;
  } catch {
    fetchFn = null;
  }
}

if (!fetchFn) {
  throw new Error('fetch is not available. Use Node 18+ or add dependency "undici".');
}

module.exports = { fetch: fetchFn };

