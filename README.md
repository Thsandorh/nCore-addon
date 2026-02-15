# nCore web Stremio addon

Web-based Stremio addon for nCore search (Node.js hosting, cPanel/CloudLinux).

## Local run

```bash
npm install
npm start
```

Configure page: `http://localhost:3000/configure`

## cPanel / CloudLinux deploy

- Application root: repository root (where `server.js` and `package.json` are)
- Application URL: `/` or `/addon-path`
- Application startup file: `server.js`
- Node.js version: `14+` (example: `24`)
- Environment variables:
  - `APP_BASE_PATH` = empty for root URL, or `/addon-path` when using a subpath
  - `PORT` = optional (usually set by hosting automatically)

After deploy:
- Configure page: `https://<domain>/configure` or `https://<domain>/<addon-path>/configure`
- Manifest: `https://<domain>/<token>/manifest.json` or `https://<domain>/<addon-path>/<token>/manifest.json`

## Important

- `user:pass` data is tokenized into the URL.
- The token is not encrypted (only base64url-encoded), so use it in a trusted environment.

