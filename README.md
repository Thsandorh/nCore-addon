# nCore web Stremio addon

Webes (Vercel-kompatibilis) Stremio addon nCore kereséshez.

## Lokális futtatás

```bash
npm install
npm start
```

Configure oldal: `http://localhost:3000/configure`

## Deploy Vercelre

1. Importáld a repót Vercelbe.
2. Framework: Other.
3. Deploy után nyisd meg: `https://<app-domain>/configure`.

## Fontos

- A `user:pass` adatok tokenizálva kerülnek URL-be.
- A token nem titkosított, csak base64url kódolt, ezért megbízható környezetben használd.


## Web feltöltés

A PR-ekhez ne tegyél be bináris csomagot (pl. `.tar.gz`) a repository-ba, mert egyes felületek nem támogatják.

Ha mégis csomagolnál magadnak lokálisan:

```bash
tar -czf ncore-addon-web-files.tar.gz api lib public test package.json vercel.json README.md
```
