# 🏖️ Serifos Trip — Bill Splitter

A tiny, no-backend web app to split trip expenses with friends and see who pays
whom. Everything runs in the browser; data is saved in your browser's
`localStorage`. Single file (`index.html`) — nothing to build.

## Features

- Add the people on the trip
- Log expenses: who paid, how much, and who shares the cost (split equally)
- Automatic **net balances** and a **minimal "who pays whom"** settle-up plan
- **Copy summary** to paste into your group chat
- Auto-saves locally; **Reset** to start fresh

## Run locally

Just open `index.html` in a browser. (No server needed.)

## Deploy to GitHub Pages

1. Push this repo to GitHub:
   ```bash
   git add -A
   git commit -m "Add Serifos bill splitter"
   git push
   ```
2. On GitHub: **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Set branch to **`main`** and folder to **`/ (root)`**, then **Save**.
5. Wait ~1 minute. Your app will be live at:
   `https://<your-username>.github.io/serifos/`

That's it — share the link with your friends.

## Note on data

Each person's data lives only in **their own browser** (it isn't synced between
devices). For a shared trip, the simplest workflow is for one person to be the
"keeper" of the tab and use **Copy summary** to share the settle-up plan.
