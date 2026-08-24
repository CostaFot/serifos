# serifos — internals

Shared bill splitter: Express + Postgres on Railway, single-page frontend. The
README covers usage and deployment; this file holds the implementation detail.

## Architecture

```
Phone/laptop ──HTTPS──> Railway service (Express)
                          ├─ serves /public/index.html  (the app)
                          └─ /api/*  ──> Railway Postgres
```

- Each trip is a row in `trips` with a bcrypt-hashed PIN. Unlocking returns an
  HMAC-SHA256 token (signed with `APP_SECRET`, see `server.js`) that is
  required on every read/write.
- `people` and `expenses` are separate tables with per-operation writes, so two
  people editing at once don't clobber each other.
- The browser polls every few seconds for live updates — no websockets.
- Settlement is pairwise: each person pays back exactly who they owe
  (`computeSettlements()` in `public/index.html`). This deliberately replaced
  the earlier minimal-transfer optimisation (commit `895f835`).

## Layout

| File                | What it is                                          |
| ------------------- | --------------------------------------------------- |
| `server.js`         | Express app: static hosting, `/api/*`, Postgres     |
| `public/index.html` | the whole frontend — UI, settlement math, sync      |
| `package.json`      | dependencies + `npm start`                          |
