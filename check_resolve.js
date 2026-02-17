const http = require('http');
const https = require('https');

const RESOLVE_URL = process.argv[2];

if (!RESOLVE_URL) {
  console.error('Usage: node check_resolve.js <resolve-url>');
  console.error('Example: node check_resolve.js "http://localhost:3000/.../resolve/ABC123"');
  process.exit(1);
}

console.log('Testing resolve URL...');
console.log(`URL: ${RESOLVE_URL}\n`);

const protocol = RESOLVE_URL.startsWith('https') ? https : http;

const req = protocol.get(RESOLVE_URL, { timeout: 5000 }, (res) => {
  console.log(`Status Code: ${res.statusCode}`);
  console.log(`Status Message: ${res.statusMessage}`);
  console.log('\nHeaders:');
  Object.entries(res.headers).forEach(([key, value]) => {
    console.log(`  ${key}: ${value}`);
  });

  if (res.statusCode === 302 || res.statusCode === 301) {
    console.log('\n✓ SUCCESS! Resolve endpoint returned redirect');
    console.log(`\nRedirect Location:`);
    console.log(`  ${res.headers.location?.substring(0, 100)}...`);
    console.log('\nThis means:');
    console.log('  → Torrent WAS added to TorBox ✓');
    console.log('  → Video URL is ready ✓');
    console.log('  → Stremio should follow this redirect to play the video');
  } else if (res.statusCode === 409) {
    console.log('\n⚠ TorBox is processing the torrent (uncached)');
    console.log('  → Torrent WAS added to TorBox ✓');
    console.log('  → Still downloading, not ready yet');
    console.log('  → Try again in a few minutes');
  } else if (res.statusCode === 404) {
    console.log('\n✗ Selection key not found or expired');
    console.log('  → Get a new stream list from Stremio');
  } else if (res.statusCode >= 400) {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      console.log(`\n✗ Error: ${data}`);
    });
  }
});

req.on('error', (err) => {
  console.error(`\n✗ Request failed: ${err.message}`);
});

req.on('timeout', () => {
  req.destroy();
  console.error('\n✗ Request timeout');
});

req.end();
