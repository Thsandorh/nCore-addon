const NCORE_BASE = 'https://ncore.pro';

async function loginAndSearch({ username, password, query }) {
  const form = new URLSearchParams({
    nev: username,
    pass: password,
    ne_leptessen_ki: '1',
    submitted: '1',
    set_lang: 'hu',
  });

  const loginResponse = await fetch(`${NCORE_BASE}/login.php`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'stremio-ncore-addon/1.0',
    },
    body: form.toString(),
    redirect: 'manual',
  });

  const cookie = loginResponse.headers.get('set-cookie');
  if (!cookie) {
    throw new Error('nCore login failed: invalid credentials or blocked login');
  }

  const searchUrl = `${NCORE_BASE}/torrents.php?mire=${encodeURIComponent(query)}&miben=name`;
  const searchResponse = await fetch(searchUrl, {
    headers: {
      cookie,
      'user-agent': 'stremio-ncore-addon/1.0',
    },
  });

  if (!searchResponse.ok) {
    throw new Error(`nCore search failed with status ${searchResponse.status}`);
  }

  const html = await searchResponse.text();
  return parseSearchResults(html).slice(0, 8);
}

function parseSearchResults(html) {
  const rows = [];
  const regex = /href="details\.php\?id=(\d+)"[^>]*>([^<]+)<[\s\S]*?href="(magnet:\?xt=urn:btih:[^"]+)"/gi;
  let match;
  while ((match = regex.exec(html))) {
    rows.push({
      id: match[1],
      title: sanitizeTitle(match[2]),
      magnet: match[3].replace(/&amp;/g, '&'),
    });
  }
  return rows;
}

function sanitizeTitle(value) {
  return value.replace(/\s+/g, ' ').trim();
}

module.exports = {
  loginAndSearch,
  parseSearchResults,
};
