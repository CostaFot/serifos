# 🏖️ Serifos Trip — Bill Splitter

A shared expense splitter for a group trip. One link, everyone sees the same
live list of expenses, and the app works out the **minimal set of payments** to
settle up. Built as a tiny **Express + PostgreSQL** app that runs on **Railway**.

- Create a **PIN-protected trip**, share the link with your friends
- Add people and expenses (who paid, how much, who shares the cost)
- Automatic **net balances** and a **who-pays-whom** plan
- Data lives in Postgres, so it **syncs across everyone's phones** and survives
  redeploys
- **Copy summary** to paste into the group chat

## How it works

```
Phone/laptop ──HTTPS──> Railway service (Express)
                          ├─ serves /public/index.html  (the app)
                          └─ /api/*  ──> Railway Postgres
```

Each trip is a row in `trips` with a bcrypt-hashed PIN. Unlocking returns a
signed token that's required on every read/write. People and expenses are stored
in their own tables (per-operation writes, so two people editing at once won't
clobber each other). The browser polls every few seconds for live updates.

## Environment variables

| Variable       | Required | Notes                                                        |
| -------------- | -------- | ------------------------------------------------------------ |
| `DATABASE_URL` | yes      | Postgres connection string. On Railway: `${{Postgres.DATABASE_URL}}` |
| `APP_SECRET`   | yes      | Any random string; signs the unlock tokens                   |
| `PORT`         | no       | Provided automatically by Railway                            |

## Deploy on Railway

This repo is already connected to a Railway service, so **every push
auto-deploys**. To finish the one-time setup:

1. **Push** this code to GitHub — Railway builds it (Nixpacks detects Node and
   runs `npm start`).
2. In the Railway project: **New → Database → PostgreSQL**.
3. Open the **app service → Variables** and add:
   - `DATABASE_URL` → click *Add Reference* → `${{Postgres.DATABASE_URL}}`
   - `APP_SECRET` → any long random string
4. **Settings → Networking → Generate Domain** (e.g. `serifos.up.railway.app`).
5. Open the domain, **create your trip + PIN**, and share the `#trip=…` link.

> The app refuses to start without `DATABASE_URL`. The very first deploy may
> crash-loop until you add the Postgres variable in step 3 — that's expected; it
> turns green once the variable is set.

## Run locally

You need a PostgreSQL database (local, or the public URL from Railway's Postgres
→ *Connect* tab).

```bash
npm install
DATABASE_URL="postgres://user:pass@host:5432/dbname" APP_SECRET="dev-secret" npm start
# open http://localhost:3000
```

On Windows PowerShell:

```powershell
$env:DATABASE_URL="postgres://user:pass@host:5432/dbname"; $env:APP_SECRET="dev-secret"; npm start
```

## Project layout

```
server.js            Express app: static hosting + /api + Postgres
public/index.html    The whole frontend (UI, settlement math, sync)
package.json         Dependencies + start script
```
