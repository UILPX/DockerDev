const path = require("path");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json());

const db = new Database("/app/data/data.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS identities (
    browser_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS simple_scores (
    name TEXT PRIMARY KEY,
    best_ms INTEGER NOT NULL,
    false_starts INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pro_scores (
    name TEXT PRIMARY KEY,
    best_ms INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// ==========================
// AIM MODE
// ==========================
const AIM_TARGETS = 20;
const AIM_MIN_HIT_MS = 80;
const AIM_MAX_HIT_MS = 2000;
const AIM_MIN_AVG_MS = 120;
const AIM_MISS_PENALTY = 150;
const AIM_MAX_MISSES = 60;

db.exec(`
  CREATE TABLE IF NOT EXISTS aim_scores (
    name TEXT PRIMARY KEY,
    best_score INTEGER NOT NULL,
    avg_ms INTEGER NOT NULL,
    misses INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

function isMobileRequest(req) {
  const ch = (req.headers["sec-ch-ua-mobile"] || "").toString().trim();
  if (ch === "?1") return true;
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  return /android|iphone|ipad|ipod|mobile|phone|tablet|iemobile/.test(ua);
}

function getSimpleRank(name) {
  if (!name) return null;
  const row = db.prepare(
    "SELECT best_ms, false_starts FROM simple_scores WHERE name=?"
  ).get(name);
  if (!row) return null;
  const rankRow = db.prepare(
    "SELECT 1 + COUNT(*) AS rank FROM simple_scores WHERE best_ms < ? OR (best_ms = ? AND name < ?)"
  ).get(row.best_ms, row.best_ms, name);
  return {
    rank: rankRow ? rankRow.rank : null,
    name,
    best_ms: row.best_ms,
    false_starts: row.false_starts
  };
}

function getProRank(name) {
  if (!name) return null;
  const row = db.prepare(
    "SELECT best_ms FROM pro_scores WHERE name=?"
  ).get(name);
  if (!row) return null;
  const rankRow = db.prepare(
    "SELECT 1 + COUNT(*) AS rank FROM pro_scores WHERE best_ms < ? OR (best_ms = ? AND name < ?)"
  ).get(row.best_ms, row.best_ms, name);
  return {
    rank: rankRow ? rankRow.rank : null,
    name,
    best_ms: row.best_ms
  };
}

function getAimRank(name) {
  if (!name) return null;
  const row = db.prepare(
    "SELECT best_score, avg_ms, misses FROM aim_scores WHERE name=?"
  ).get(name);
  if (!row) return null;
  const rankRow = db.prepare(
    "SELECT 1 + COUNT(*) AS rank FROM aim_scores WHERE best_score < ? OR (best_score = ? AND name < ?)"
  ).get(row.best_score, row.best_score, name);
  return {
    rank: rankRow ? rankRow.rank : null,
    name,
    best_score: row.best_score,
    avg_ms: row.avg_ms,
    misses: row.misses
  };
}

// Keep per-user false starts since last Simple record.
db.exec(`
  CREATE TABLE IF NOT EXISTS simple_false_start_cycles (
    browser_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pending_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )
`);


db.exec(`
  CREATE TABLE IF NOT EXISTS simple_used_challenges (
    token_hash TEXT PRIMARY KEY,
    used_at INTEGER NOT NULL
  )
`);

// ==========================
// Identity
// ==========================

app.get("/api/me", (req, res) => {
  const bid = req.query.bid;
  const row = db.prepare(
    "SELECT name FROM identities WHERE browser_id=?"
  ).get(bid);
  if (!row) return res.json({ ok: true, claimed: false });
  res.json({ ok: true, claimed: true, name: row.name });
});

app.post("/api/claim", (req, res) => {
  const { bid, name } = req.body || {};
  if (!bid || !name || typeof name !== 'string' || name.length < 1 || name.length > 20) {
    return res.status(400).json({ ok: false, error: 'invalid input' });
  }

  const row = db.prepare(
    "SELECT name FROM identities WHERE browser_id=?"
  ).get(bid);

  if (row) {
    return res.json({ ok: true, claimed: true, name: row.name });
  }

  try {
    db.prepare(
      "INSERT INTO identities (browser_id, name, created_at) VALUES (?, ?, ?)"
    ).run(bid, name, Date.now());
    return res.json({ ok: true, claimed: true, name });
  } catch (e) {
    console.error('claim error', e);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

// ==========================
// SIMPLE MODE
// ==========================

const SIMPLE_MIN_MS = 80;
const SIMPLE_MAX_MS = 5000;
const SIMPLE_CHALLENGE_TTL_MS = 12000;
const SIMPLE_CHALLENGE_SECRET = process.env.SIMPLE_CHALLENGE_SECRET || "replace-this-secret";

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function signSimpleChallenge(payloadBase64) {
  return crypto.createHmac("sha256", SIMPLE_CHALLENGE_SECRET).update(payloadBase64).digest("hex");
}

function encodeSimpleChallenge(payloadObj) {
  const payloadBase64 = Buffer.from(JSON.stringify(payloadObj), "utf8").toString("base64url");
  const signature = signSimpleChallenge(payloadBase64);
  return `${payloadBase64}.${signature}`;
}

function decodeSimpleChallenge(token) {
  if (!token || typeof token !== "string") return null;
  const [payloadBase64, sig] = token.split(".");
  if (!payloadBase64 || !sig) return null;
  const expected = signSimpleChallenge(payloadBase64);
  const sigBuf = Buffer.from(sig, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const json = Buffer.from(payloadBase64, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch (_err) {
    return null;
  }
}

function consumeSimpleChallenge(token, nowTs) {
  const tokenHash = sha256Hex(token);
  const existed = db.prepare("SELECT token_hash FROM simple_used_challenges WHERE token_hash=?").get(tokenHash);
  if (existed) return false;
  db.prepare("INSERT INTO simple_used_challenges (token_hash, used_at) VALUES (?, ?)").run(tokenHash, nowTs);
  return true;
}

app.post("/api/simple/challenge", (req, res) => {
  const { bid, name } = req.body || {};
  if (!bid || !name || typeof bid !== "string" || typeof name !== "string") {
    return res.status(400).json({ ok: false, error: "invalid input" });
  }

  const nowTs = Date.now();
  const readyAt = nowTs + 1000 + Math.floor(Math.random() * 3000);
  const expiresAt = readyAt + SIMPLE_CHALLENGE_TTL_MS;
  const nonce = crypto.randomBytes(16).toString("hex");
  const token = encodeSimpleChallenge({ bid, name, readyAt, expiresAt, nonce, v: 1 });
  res.json({ ok: true, token, ready_at: readyAt });
});

app.post("/api/simple/submit", (req, res) => {
  const { name, ms, falseStarts, bid, challengeToken } = req.body || {};
  if (!name || typeof name !== "string" || name.length < 1 || name.length > 20) {
    return res.status(400).json({ ok: false, error: "invalid name" });
  }
  if (!bid || typeof bid !== "string") {
    return res.status(400).json({ ok: false, error: "invalid bid" });
  }
  if (!Number.isInteger(ms) || ms < SIMPLE_MIN_MS || ms > SIMPLE_MAX_MS) {
    return res.status(400).json({ ok: false, error: "invalid ms" });
  }

  const nowTs = Date.now();
  db.prepare("DELETE FROM simple_used_challenges WHERE used_at < ?").run(nowTs - 24 * 60 * 60 * 1000);

  const challenge = decodeSimpleChallenge(challengeToken);
  if (!challenge || challenge.v !== 1) {
    return res.status(400).json({ ok: false, error: "invalid challenge" });
  }
  if (challenge.bid !== bid || challenge.name !== name) {
    return res.status(400).json({ ok: false, error: "challenge mismatch" });
  }
  if (nowTs < challenge.readyAt) {
    return res.status(400).json({ ok: false, error: "too early" });
  }
  if (nowTs > challenge.expiresAt) {
    return res.status(400).json({ ok: false, error: "challenge expired" });
  }
  if (!consumeSimpleChallenge(challengeToken, nowTs)) {
    return res.status(400).json({ ok: false, error: "challenge already used" });
  }

  const pendingFalseStarts = bid
    ? (db.prepare("SELECT pending_count FROM simple_false_start_cycles WHERE browser_id=?").get(bid)?.pending_count || 0)
    : (falseStarts || 0);

  const row = db.prepare("SELECT best_ms FROM simple_scores WHERE name=?").get(name);

  if (!row) {
    db.prepare(
      "INSERT INTO simple_scores (name, best_ms, false_starts, updated_at) VALUES (?, ?, ?, ?)"
    ).run(name, ms, pendingFalseStarts, nowTs);
    db.prepare(`
      INSERT INTO simple_false_start_cycles (browser_id, name, pending_count, updated_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(browser_id) DO UPDATE SET
        pending_count = 0,
        name = excluded.name,
        updated_at = excluded.updated_at
    `).run(bid, name, nowTs);
    return res.json({
      ok: true,
      best_ms: ms,
      broke_record: true,
      false_starts_before_record: pendingFalseStarts,
      pending_false_starts: 0
    });
  }

  if (ms < row.best_ms) {
    db.prepare(
      "UPDATE simple_scores SET best_ms=?, false_starts=?, updated_at=? WHERE name=?"
    ).run(ms, pendingFalseStarts, nowTs, name);
    db.prepare(`
      INSERT INTO simple_false_start_cycles (browser_id, name, pending_count, updated_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(browser_id) DO UPDATE SET
        pending_count = 0,
        name = excluded.name,
        updated_at = excluded.updated_at
    `).run(bid, name, nowTs);
    return res.json({
      ok: true,
      best_ms: ms,
      broke_record: true,
      false_starts_before_record: pendingFalseStarts,
      pending_false_starts: 0
    });
  }

  res.json({
    ok: true,
    best_ms: row.best_ms,
    broke_record: false,
    false_starts_before_record: null,
    pending_false_starts: pendingFalseStarts
  });
});

app.get("/api/simple/leaderboard", (req, res) => {
  const rows = db.prepare(
    "SELECT name, best_ms, false_starts FROM simple_scores ORDER BY best_ms ASC, name ASC LIMIT 20"
  ).all();
  const me = getSimpleRank(req.query.name);
  res.json({ ok: true, rows, me });
});

app.get("/api/simple/leaderboard/all", (req, res) => {
  const rows = db.prepare(
    "SELECT name, best_ms, false_starts FROM simple_scores ORDER BY best_ms ASC, name ASC"
  ).all();
  res.json({ ok: true, rows });
});

app.post("/api/simple/false-start", (req, res) => {
  const { bid, name } = req.body || {};
  if (!bid || !name || typeof bid !== "string" || typeof name !== "string") {
    return res.status(400).json({ ok: false, error: "invalid input" });
  }

  const now = Date.now();
  db.prepare(`
    INSERT INTO simple_false_start_cycles (browser_id, name, pending_count, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(browser_id) DO UPDATE SET
      pending_count = pending_count + 1,
      name = excluded.name,
      updated_at = excluded.updated_at
  `).run(bid, name, now);

  const row = db.prepare(
    "SELECT pending_count FROM simple_false_start_cycles WHERE browser_id=?"
  ).get(bid);

  res.json({ ok: true, pending_false_starts: row ? row.pending_count : 0 });
});

app.get("/api/simple/stats", (req, res) => {
  const bid = req.query.bid;
  if (!bid || typeof bid !== "string") {
    return res.status(400).json({ ok: false, error: "invalid bid" });
  }

  const row = db.prepare(
    "SELECT pending_count FROM simple_false_start_cycles WHERE browser_id=?"
  ).get(bid);
  res.json({ ok: true, pending_false_starts: row ? row.pending_count : 0 });
});

// ==========================
// PRO MODE
// ==========================

app.post("/api/pro/submit", (req, res) => {
  const { name, ms } = req.body;
  const now = Date.now();

  const row = db.prepare(
    "SELECT best_ms FROM pro_scores WHERE name=?"
  ).get(name);

  if (!row) {
    db.prepare(
      "INSERT INTO pro_scores (name, best_ms, updated_at) VALUES (?, ?, ?)"
    ).run(name, ms, now);
    return res.json({ ok: true, best_ms: ms });
  }

  if (ms < row.best_ms) {
    db.prepare(
      "UPDATE pro_scores SET best_ms=?, updated_at=? WHERE name=?"
    ).run(ms, now, name);
    return res.json({ ok: true, best_ms: ms });
  }

  res.json({ ok: true, best_ms: row.best_ms });
});

app.get("/api/pro/leaderboard", (req, res) => {
  const rows = db.prepare(
    "SELECT name, best_ms FROM pro_scores ORDER BY best_ms ASC, name ASC LIMIT 20"
  ).all();
  const me = getProRank(req.query.name);
  res.json({ ok: true, rows, me });
});

app.get("/api/pro/leaderboard/all", (req, res) => {
  const rows = db.prepare(
    "SELECT name, best_ms FROM pro_scores ORDER BY best_ms ASC, name ASC"
  ).all();
  res.json({ ok: true, rows });
});

db.exec(`
  CREATE TABLE IF NOT EXISTS identities (
    browser_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS simple_scores (
    name TEXT PRIMARY KEY,
    best_ms INTEGER NOT NULL,
    false_starts INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pro_scores (
    name TEXT PRIMARY KEY,
    best_ms INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// ==========================
// AIM MODE
// ==========================

app.post("/api/aim/submit", (req, res) => {
  if (isMobileRequest(req)) {
    return res.status(403).json({ ok: false, error: "mobile not allowed" });
  }
  const { name, hits, misses } = req.body || {};
  if (!name || typeof name !== "string" || name.length < 1 || name.length > 20) {
    return res.status(400).json({ ok: false, error: "invalid name" });
  }
  if (!Array.isArray(hits) || hits.length !== AIM_TARGETS) {
    return res.status(400).json({ ok: false, error: "invalid hits" });
  }
  const cleanHits = hits.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  if (cleanHits.length !== AIM_TARGETS) {
    return res.status(400).json({ ok: false, error: "invalid hits" });
  }
  for (const h of cleanHits) {
    if (h < AIM_MIN_HIT_MS || h > AIM_MAX_HIT_MS) {
      return res.status(400).json({ ok: false, error: "out of range" });
    }
  }
  const missCount = Number.isInteger(misses) ? misses : 0;
  if (missCount < 0 || missCount > AIM_MAX_MISSES) {
    return res.status(400).json({ ok: false, error: "invalid misses" });
  }
  const avg = Math.round(cleanHits.reduce((a, b) => a + b, 0) / AIM_TARGETS);
  if (avg < AIM_MIN_AVG_MS) {
    return res.status(400).json({ ok: false, error: "avg too low" });
  }
  const score = avg + missCount * AIM_MISS_PENALTY;
  const now = Date.now();

  const row = db.prepare(
    "SELECT best_score FROM aim_scores WHERE name=?"
  ).get(name);
  if (!row) {
    db.prepare(
      "INSERT INTO aim_scores (name, best_score, avg_ms, misses, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(name, score, avg, missCount, now);
    return res.json({ ok: true, best_score: score, avg_ms: avg, misses: missCount });
  }
  if (score < row.best_score) {
    db.prepare(
      "UPDATE aim_scores SET best_score=?, avg_ms=?, misses=?, updated_at=? WHERE name=?"
    ).run(score, avg, missCount, now, name);
    return res.json({ ok: true, best_score: score, avg_ms: avg, misses: missCount });
  }
  const bestRow = db.prepare(
    "SELECT best_score, avg_ms, misses FROM aim_scores WHERE name=?"
  ).get(name);
  res.json({ ok: true, best_score: bestRow.best_score, avg_ms: bestRow.avg_ms, misses: bestRow.misses });
});

app.get("/api/aim/leaderboard", (req, res) => {
  const rows = db.prepare(
    "SELECT name, best_score, avg_ms, misses FROM aim_scores ORDER BY best_score ASC, name ASC LIMIT 20"
  ).all();
  const me = getAimRank(req.query.name);
  res.json({ ok: true, rows, me });
});

app.get("/api/aim/leaderboard/all", (req, res) => {
  const rows = db.prepare(
    "SELECT name, best_score, avg_ms, misses FROM aim_scores ORDER BY best_score ASC, name ASC"
  ).all();
  res.json({ ok: true, rows });
});

// ==========================

app.use("/", express.static(path.join(__dirname, "public")));

app.listen(3000, () => console.log("Server running"));
