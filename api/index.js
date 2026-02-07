const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('./app');

const configurePath = path.join(__dirname, '..', 'public', 'configure.html');
const configureHtml = fs.existsSync(configurePath)
  ? fs.readFileSync(configurePath, 'utf8')
  : '<h1>Missing configure page</h1>';

const app = createApp({ configureHtml });

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  http.createServer((req, res) => app(req, res)).listen(port, () => {
    console.log(`nCore addon listening on :${port}`);
  });
}

module.exports = app;
