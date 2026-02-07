# nCore web Stremio addon

Web-based (Vercel-compatible) Stremio addon for nCore search.

## Local run

```bash
npm install
npm start
```

Configure page: `http://localhost:3000/configure`

## Deploy to Vercel

1. Import the repository into Vercel.
2. Framework preset: Other.
3. After deploy, open: `https://<app-domain>/configure`.

## Important

- `user:pass` data is tokenized into the URL.
- The token is not encrypted (only base64url-encoded), so use it in a trusted environment.

