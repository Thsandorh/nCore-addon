'use strict';

function now() {
  return new Date().toISOString();
}

function normalizeErrorMeta(meta) {
  if (!meta) return undefined;
  if (meta instanceof Error) {
    return {
      name: meta.name,
      message: meta.message,
      stack: meta.stack,
      code: meta.code,
      status: meta.status,
    };
  }
  return meta;
}

function write(stream, level, message, meta) {
  const payload = {
    ts: now(),
    level,
    message: String(message || ''),
  };
  const normalized = normalizeErrorMeta(meta);
  if (normalized !== undefined) payload.meta = normalized;
  stream.write(`${JSON.stringify(payload)}\n`);
}

function logInfo(message, meta) {
  write(process.stdout, 'info', message, meta);
}

function logError(message, meta) {
  write(process.stderr, 'error', message, meta);
}

module.exports = {
  logInfo,
  logError,
};

