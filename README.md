# serifos

Bill splitter for a group trip. One PIN-protected link, everyone sees the same
live list of expenses, and the app works out who pays whom — pairwise, so each
person pays back exactly the people they owe. There's a copy-summary button for
pasting the result into the group chat.

Tiny Express + PostgreSQL app, runs on Railway.

## Environment variables

| Variable       | Required | Notes                                                                |
| -------------- | -------- | -------------------------------------------------------------------- |
| `DATABASE_URL` | yes      | Postgres connection string. On Railway: `${{Postgres.DATABASE_URL}}` |
| `APP_SECRET`   | yes      | Any random string; signs the unlock tokens                           |
| `PORT`         | no       | Provided automatically by Railway                                    |

## Deploy

The repo is connected to a Railway service, so every push to `main` deploys.
The Railway project needs a Postgres database plus the two required variables
above on the app service (`DATABASE_URL` added as a reference to
`${{Postgres.DATABASE_URL}}`), and a generated domain.

The app refuses to start without `DATABASE_URL`, so a fresh deploy crash-loops
until the variable is set — that's expected, it turns green on its own.

## Run locally

You need a Postgres database (local, or the public URL from Railway's Postgres
Connect tab).

```bash
npm install
DATABASE_URL="postgres://user:pass@host:5432/dbname" APP_SECRET="dev-secret" npm start
# open http://localhost:3000
```

On Windows PowerShell:

```powershell
$env:DATABASE_URL="postgres://user:pass@host:5432/dbname"; $env:APP_SECRET="dev-secret"; npm start
```
