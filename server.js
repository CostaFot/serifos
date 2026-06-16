"use strict";

/**
 * Serifos Bill Splitter — Express + Postgres backend.
 *
 * Serves the static app from /public and a small JSON API under /api.
 * Each "trip" is PIN-protected; unlocking returns an HMAC token that is
 * required on every read/write. Data lives in Postgres so it is shared across
 * everyone's phones and survives redeploys.
 *
 * Required env vars:
 *   DATABASE_URL  - Postgres connection string (Railway: ${{Postgres.DATABASE_URL}})
 *   APP_SECRET    - secret used to sign unlock tokens (any random string)
 *   PORT          - provided by Railway automatically
 */

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const APP_SECRET = process.env.APP_SECRET || "dev-insecure-secret-change-me";

if (!process.env.DATABASE_URL) {
  console.error(
    "FATAL: DATABASE_URL is not set. On Railway add a Postgres database and set " +
      "DATABASE_URL = ${{Postgres.DATABASE_URL}} in this service's Variables."
  );
  process.exit(1);
}
if (!process.env.APP_SECRET) {
  console.warn(
    "WARNING: APP_SECRET is not set — using an insecure default. Set APP_SECRET in Railway Variables."
  );
}

// Railway's private network (DATABASE_URL with *.railway.internal) needs no SSL.
// Only enable SSL if pointed at a public Postgres proxy host.
const usePublicSsl = /proxy\.rlwy\.net|\.railway\.app/.test(process.env.DATABASE_URL || "");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: usePublicSsl ? { rejectUnauthorized: false } : false,
});

// ---------------------------------------------------------------------------
// Schema (idempotent — created on boot, no migration tooling)
// ---------------------------------------------------------------------------
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trips (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      pin_hash   TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS people (
      id         TEXT PRIMARY KEY,
      trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id         TEXT PRIMARY KEY,
      trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      descr      TEXT,
      amount     NUMERIC(12,2) NOT NULL,
      payer_id   TEXT NOT NULL,
      shares     JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_people_trip   ON people(trip_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses(trip_id);
  `);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeId(bytes) {
  // URL-safe short id
  return crypto.randomBytes(bytes || 8).toString("base64url");
}

function tokenFor(tripId) {
  return crypto.createHmac("sha256", APP_SECRET).update("trip:" + tripId).digest("hex");
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function touchTrip(client, tripId) {
  await client.query("UPDATE trips SET updated_at = now() WHERE id = $1", [tripId]);
}

async function loadState(tripId) {
  const [people, expenses, trip] = await Promise.all([
    pool.query("SELECT id, name FROM people WHERE trip_id = $1 ORDER BY created_at", [tripId]),
    pool.query(
      "SELECT id, descr, amount, payer_id, shares FROM expenses WHERE trip_id = $1 ORDER BY created_at",
      [tripId]
    ),
    pool.query("SELECT updated_at FROM trips WHERE id = $1", [tripId]),
  ]);
  return {
    people: people.rows.map((r) => ({ id: r.id, name: r.name })),
    expenses: expenses.rows.map((r) => ({
      id: r.id,
      desc: r.descr || "",
      amount: Number(r.amount),
      payer: r.payer_id,
      shares: Array.isArray(r.shares) ? r.shares : [],
    })),
    updatedAt: trip.rows[0] ? trip.rows[0].updated_at : null,
  };
}

// ---------------------------------------------------------------------------
// Unlock throttle (in-memory, best-effort brute-force slowdown)
// ---------------------------------------------------------------------------
const attempts = new Map(); // key -> { count, first }
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function throttleKey(req, tripId) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
  return ip + "|" + tripId;
}
function tooManyAttempts(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}
function noteAttempt(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}
function clearAttempts(key) {
  attempts.delete(key);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "256kb" }));
app.set("trust proxy", 1); // Railway sits behind a proxy → correct client IPs

// Auth middleware for trip-scoped routes
async function requireTripAuth(req, res, next) {
  const tripId = req.params.id;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !timingSafeEqual(token, tokenFor(tripId))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { rows } = await pool.query("SELECT id FROM trips WHERE id = $1", [tripId]);
    if (!rows.length) return res.status(404).json({ error: "Trip not found" });
    next();
  } catch (e) {
    next(e);
  }
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Create a trip ---------------------------------------------------------
app.post(
  "/api/trips",
  asyncRoute(async (req, res) => {
    const name = (req.body.name || "").toString().trim().slice(0, 80) || "Trip";
    const pin = (req.body.pin || "").toString();
    if (pin.length < 3 || pin.length > 64) {
      return res.status(400).json({ error: "PIN must be 3–64 characters." });
    }
    const id = makeId(6);
    const pinHash = await bcrypt.hash(pin, 10);
    await pool.query("INSERT INTO trips (id, name, pin_hash) VALUES ($1, $2, $3)", [id, name, pinHash]);
    res.status(201).json({ id, name, token: tokenFor(id) });
  })
);

// --- Unlock (verify PIN) ---------------------------------------------------
app.post(
  "/api/trips/:id/unlock",
  asyncRoute(async (req, res) => {
    const tripId = req.params.id;
    const key = throttleKey(req, tripId);
    if (tooManyAttempts(key)) {
      return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." });
    }
    const pin = (req.body.pin || "").toString();
    const { rows } = await pool.query("SELECT name, pin_hash FROM trips WHERE id = $1", [tripId]);
    if (!rows.length) {
      noteAttempt(key);
      return res.status(404).json({ error: "Trip not found." });
    }
    const ok = await bcrypt.compare(pin, rows[0].pin_hash);
    if (!ok) {
      noteAttempt(key);
      return res.status(401).json({ error: "Wrong PIN." });
    }
    clearAttempts(key);
    const state = await loadState(tripId);
    res.json({ token: tokenFor(tripId), name: rows[0].name, state });
  })
);

// --- Read state ------------------------------------------------------------
app.get(
  "/api/trips/:id",
  requireTripAuth,
  asyncRoute(async (req, res) => {
    res.json(await loadState(req.params.id));
  })
);

// --- Add person ------------------------------------------------------------
app.post(
  "/api/trips/:id/people",
  requireTripAuth,
  asyncRoute(async (req, res) => {
    const tripId = req.params.id;
    const name = (req.body.name || "").toString().trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: "Name required." });

    const dupe = await pool.query("SELECT 1 FROM people WHERE trip_id = $1 AND lower(name) = lower($2)", [
      tripId,
      name,
    ]);
    if (dupe.rows.length) return res.status(409).json({ error: "That name is already on the trip." });

    const id = makeId(6);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO people (id, trip_id, name) VALUES ($1, $2, $3)", [id, tripId, name]);
      await touchTrip(client, tripId);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    res.status(201).json({ id });
  })
);

// --- Remove person (cascade like the original client logic) ----------------
app.delete(
  "/api/trips/:id/people/:pid",
  requireTripAuth,
  asyncRoute(async (req, res) => {
    const tripId = req.params.id;
    const pid = req.params.pid;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Remove the person.
      await client.query("DELETE FROM people WHERE trip_id = $1 AND id = $2", [tripId, pid]);
      // Remove expenses they paid for.
      await client.query("DELETE FROM expenses WHERE trip_id = $1 AND payer_id = $2", [tripId, pid]);
      // Strip them from remaining shares.
      await client.query(
        `UPDATE expenses
            SET shares = COALESCE((SELECT jsonb_agg(s) FROM jsonb_array_elements(shares) s WHERE s <> to_jsonb($2::text)), '[]'::jsonb)
          WHERE trip_id = $1`,
        [tripId, pid]
      );
      // Drop expenses now shared by nobody.
      await client.query("DELETE FROM expenses WHERE trip_id = $1 AND jsonb_array_length(shares) = 0", [tripId]);
      await touchTrip(client, tripId);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    res.json(await loadState(tripId));
  })
);

// --- Add expense -----------------------------------------------------------
app.post(
  "/api/trips/:id/expenses",
  requireTripAuth,
  asyncRoute(async (req, res) => {
    const tripId = req.params.id;
    const desc = (req.body.desc || "").toString().trim().slice(0, 120);
    const amount = Number(req.body.amount);
    const payer = (req.body.payer || "").toString();
    const shares = Array.isArray(req.body.shares) ? req.body.shares.map(String) : [];

    if (!(amount > 0)) return res.status(400).json({ error: "Amount must be greater than 0." });
    if (!payer) return res.status(400).json({ error: "Payer required." });
    if (!shares.length) return res.status(400).json({ error: "Pick at least one person to split between." });

    // Validate payer + shares are real members of this trip.
    const members = await pool.query("SELECT id FROM people WHERE trip_id = $1", [tripId]);
    const valid = new Set(members.rows.map((r) => r.id));
    if (!valid.has(payer)) return res.status(400).json({ error: "Unknown payer." });
    const cleanShares = shares.filter((s) => valid.has(s));
    if (!cleanShares.length) return res.status(400).json({ error: "Shares must be trip members." });

    const id = makeId(6);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO expenses (id, trip_id, descr, amount, payer_id, shares) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, tripId, desc, amount.toFixed(2), payer, JSON.stringify(cleanShares)]
      );
      await touchTrip(client, tripId);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    res.status(201).json({ id });
  })
);

// --- Delete expense --------------------------------------------------------
app.delete(
  "/api/trips/:id/expenses/:eid",
  requireTripAuth,
  asyncRoute(async (req, res) => {
    const tripId = req.params.id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM expenses WHERE trip_id = $1 AND id = $2", [tripId, req.params.eid]);
      await touchTrip(client, tripId);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    res.json(await loadState(tripId));
  })
);

// --- Reset (wipe people + expenses, keep the trip + PIN) --------------------
app.post(
  "/api/trips/:id/reset",
  requireTripAuth,
  asyncRoute(async (req, res) => {
    const tripId = req.params.id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM expenses WHERE trip_id = $1", [tripId]);
      await client.query("DELETE FROM people WHERE trip_id = $1", [tripId]);
      await touchTrip(client, tripId);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    res.json(await loadState(tripId));
  })
);

// --- Static frontend -------------------------------------------------------
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// Health check (Railway can use this)
app.get("/healthz", (req, res) => res.json({ ok: true }));

// SPA-ish fallback to index.html for any non-API GET.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const ready = initSchema()
  .then(
    () =>
      new Promise((resolve) => {
        const server = app.listen(PORT, () => {
          console.log(`Serifos splitter listening on :${PORT}`);
          resolve(server);
        });
      })
  )
  .catch((e) => {
    console.error("Failed to initialise database:", e);
    process.exit(1);
  });

module.exports = { app, pool, ready };
