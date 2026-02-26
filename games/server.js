const path = require("path");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());

const db = new Database("/app/data/data.db");

const SESSION_TTL_SHORT_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_LONG_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

const GAME_RULES = {
  "2048": { order: "DESC", min: 0, max: 1000000 },
  tetris: { order: "DESC", min: 0, max: 10000000 },
  reaction: { order: "ASC", min: 60, max: 5000 }
};

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS email_verifications (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scores (
    user_id INTEGER NOT NULL,
    game TEXT NOT NULL,
    value INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, game),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

const smtpHost = process.env.SMTP_HOST || "";
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER || "";
const smtpPass = process.env.SMTP_PASS || "";
const smtpFrom = process.env.SMTP_FROM || smtpUser || "no-reply@localhost";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "https://games.xpsxp.org";

const canSendMail = !!(smtpHost && smtpUser && smtpPass);
const transporter = canSendMail
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass }
    })
  : null;

function now() {
  return Date.now();
}

function randomToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

function sanitizeName(name) {
  if (typeof name !== "string") return null;
  const n = name.trim();
  if (!/^[a-zA-Z0-9_\-\u4e00-\u9fa5]{2,20}$/.test(n)) return null;
  return n;
}

function sanitizeEmail(email) {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  if (e.length < 5 || e.length > 120) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const digest = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${digest}`;
}

function verifyPassword(password, stored) {
  const [salt, digest] = (stored || "").split(":");
  if (!salt || !digest) return false;
  const attempt = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(attempt, "hex"));
}

function parseBearerToken(req) {
  const auth = req.headers.authorization || "";
  const prefix = "Bearer ";
  if (!auth.startsWith(prefix)) return null;
  return auth.slice(prefix.length).trim();
}

function loadSessionUser(req) {
  const token = parseBearerToken(req);
  if (!token) return null;

  const row = db.prepare(`
    SELECT s.token, s.expires_at, u.id, u.email, u.display_name
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);

  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare("DELETE FROM sessions WHERE token=?").run(token);
    return null;
  }
  return row;
}

function authRequired(req, res, next) {
  const user = loadSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: "unauthorized" });
  req.user = user;
  next();
}

function validateGameAndValue(game, value) {
  const cfg = GAME_RULES[game];
  if (!cfg) return { ok: false, error: "invalid game" };
  if (!Number.isInteger(value)) return { ok: false, error: "invalid value" };
  if (value < cfg.min || value > cfg.max) return { ok: false, error: "out of range" };
  return { ok: true, cfg };
}

function rankWhereClause(game) {
  return GAME_RULES[game].order === "DESC"
    ? "s.value > ? OR (s.value = ? AND u.display_name < ?)"
    : "s.value < ? OR (s.value = ? AND u.display_name < ?)";
}

async function sendVerificationMail(email, token, displayName) {
  const url = `${publicBaseUrl}/auth.html?verify=${token}`;
  const text = `Hi ${displayName}, click this link to verify: ${url}`;
  if (!canSendMail) {
    console.log("[verify-link]", url);
    return { sent: false, fallback: true, verifyUrl: url };
  }
  await transporter.sendMail({
    from: smtpFrom,
    to: email,
    subject: "Games 注册验证",
    text
  });
  return { sent: true };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const email = sanitizeEmail(req.body?.email);
    const displayName = sanitizeName(req.body?.displayName);
    const password = req.body?.password;

    if (!email || !displayName || typeof password !== "string" || password.length < 8 || password.length > 72) {
      return res.status(400).json({ ok: false, error: "invalid input" });
    }

    const existing = db.prepare(
      "SELECT id FROM users WHERE email=? OR display_name=?"
    ).get(email, displayName);
    if (existing) {
      return res.status(409).json({ ok: false, error: "email or display name already exists" });
    }

    const passwordHash = hashPassword(password);
    const token = randomToken();
    const ts = now();

    db.prepare("DELETE FROM email_verifications WHERE email=? OR display_name=?").run(email, displayName);
    db.prepare(`
      INSERT INTO email_verifications (token, email, display_name, password_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(token, email, displayName, passwordHash, ts + VERIFY_TTL_MS, ts);

    const mailResult = await sendVerificationMail(email, token, displayName);
    return res.json({
      ok: true,
      message: "verification created",
      mail_sent: !!mailResult.sent,
      verify_url: mailResult.verifyUrl || null
    });
  } catch (err) {
    console.error("register error", err);
    return res.status(500).json({ ok: false, error: "server error" });
  }
});

app.post("/api/auth/verify", (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!token) return res.status(400).json({ ok: false, error: "invalid token" });

  const row = db.prepare("SELECT * FROM email_verifications WHERE token=?").get(token);
  if (!row) return res.status(404).json({ ok: false, error: "token not found" });
  if (row.expires_at < now()) {
    db.prepare("DELETE FROM email_verifications WHERE token=?").run(token);
    return res.status(410).json({ ok: false, error: "token expired" });
  }

  const exists = db.prepare("SELECT id FROM users WHERE email=? OR display_name=?").get(row.email, row.display_name);
  if (exists) {
    db.prepare("DELETE FROM email_verifications WHERE token=?").run(token);
    return res.status(409).json({ ok: false, error: "user already exists" });
  }

  const ts = now();
  db.prepare(`
    INSERT INTO users (email, display_name, password_hash, verified, created_at)
    VALUES (?, ?, ?, 1, ?)
  `).run(row.email, row.display_name, row.password_hash, ts);
  db.prepare("DELETE FROM email_verifications WHERE token=?").run(token);
  res.json({ ok: true });
});

app.post("/api/auth/login", (req, res) => {
  const email = sanitizeEmail(req.body?.email);
  const password = req.body?.password;
  const remember = !!req.body?.remember;
  if (!email || typeof password !== "string") {
    return res.status(400).json({ ok: false, error: "invalid input" });
  }

  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ ok: false, error: "invalid credentials" });
  }

  const ts = now();
  const token = randomToken();
  const ttl = remember ? SESSION_TTL_LONG_MS : SESSION_TTL_SHORT_MS;
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).run(token, user.id, ts + ttl, ts);

  res.json({
    ok: true,
    token,
    user: { id: user.id, email: user.email, display_name: user.display_name },
    expires_at: ts + ttl
  });
});

app.post("/api/auth/logout", authRequired, (req, res) => {
  const token = parseBearerToken(req);
  db.prepare("DELETE FROM sessions WHERE token=?").run(token);
  res.json({ ok: true });
});

app.get("/api/auth/me", authRequired, (req, res) => {
  res.json({
    ok: true,
    user: { id: req.user.id, email: req.user.email, display_name: req.user.display_name }
  });
});

app.post("/api/scores/submit", authRequired, (req, res) => {
  const game = typeof req.body?.game === "string" ? req.body.game.trim().toLowerCase() : "";
  const value = req.body?.value;
  const valid = validateGameAndValue(game, value);
  if (!valid.ok) return res.status(400).json({ ok: false, error: valid.error });

  const existing = db.prepare("SELECT value FROM scores WHERE user_id=? AND game=?").get(req.user.id, game);
  const ts = now();
  const better = !existing ||
    (valid.cfg.order === "DESC" ? value > existing.value : value < existing.value);

  if (better) {
    db.prepare(`
      INSERT INTO scores (user_id, game, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, game) DO UPDATE SET
        value=excluded.value,
        updated_at=excluded.updated_at
    `).run(req.user.id, game, value, ts);
  }

  const latest = db.prepare("SELECT value FROM scores WHERE user_id=? AND game=?").get(req.user.id, game);
  res.json({ ok: true, best: latest ? latest.value : value, improved: better });
});

app.get("/api/scores/leaderboard", (req, res) => {
  const game = typeof req.query.game === "string" ? req.query.game.trim().toLowerCase() : "";
  if (!GAME_RULES[game]) return res.status(400).json({ ok: false, error: "invalid game" });

  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const order = GAME_RULES[game].order;
  const rows = db.prepare(`
    SELECT u.display_name, s.value
    FROM scores s
    JOIN users u ON u.id = s.user_id
    WHERE s.game = ?
    ORDER BY s.value ${order}, u.display_name ASC
    LIMIT ?
  `).all(game, limit);

  const me = loadSessionUser(req);
  let myRank = null;
  if (me) {
    const my = db.prepare("SELECT value FROM scores WHERE user_id=? AND game=?").get(me.id, game);
    if (my) {
      const rankSql = `
        SELECT 1 + COUNT(*) AS rank
        FROM scores s
        JOIN users u ON u.id = s.user_id
        WHERE s.game = ?
          AND (${rankWhereClause(game)})
      `;
      const rankRow = db.prepare(rankSql).get(game, my.value, my.value, me.display_name);
      myRank = {
        display_name: me.display_name,
        value: my.value,
        rank: rankRow ? rankRow.rank : null
      };
    }
  }

  res.json({ ok: true, game, rows, me: myRank });
});

app.get("/api/scores/me", authRequired, (req, res) => {
  const rows = db.prepare("SELECT game, value FROM scores WHERE user_id=?").all(req.user.id);
  res.json({ ok: true, rows });
});

app.use("/", express.static(path.join(__dirname, "public")));

app.listen(3000, () => {
  console.log("Games server running on :3000");
});
