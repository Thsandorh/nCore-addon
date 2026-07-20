'use strict';

const { fetch } = require('./fetch');

function normalizeBaseUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('QBITTORRENT_URL must start with http:// or https://');
  return url;
}

function makeForm() {
  if (typeof FormData !== 'undefined') return new FormData();
  return new (require('undici').Form