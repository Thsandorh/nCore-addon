if (typeof globalThis.fetch !== 'function') {
  throw new Error('Global fetch is not available. Please run on Node.js 18+');
}

module.exports = {
  fetch: globalThis.fetch.bind(globalThis),
};
